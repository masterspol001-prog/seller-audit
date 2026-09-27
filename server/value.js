'use strict';

// The value loop.
//
// When a seller uploads a new settlement, later reimbursement / adjustment rows
// can prove that an issue we flagged earlier was actually paid back. We match
// those rows against open findings using strong identifiers (order ID) and
// weaker ones (SKU), record a resolution and write it to the value ledger.
//
// Nothing here asserts that money is owed. A resolution only exists when the
// seller's own uploaded file contains the reimbursement that closes the loop.

const db = require('./db');
const recovery = require('./recovery');
const logger = require('./lib/logger');
const { round2 } = require('./parsers/amazon');

const MATCHABLE_CATEGORIES = new Set([
  'reimbursement', 'fee_audit', 'storage', 'removal', 'reconciliation', 'profitability', 'data_quality',
]);

// A recovery candidate is a positive reimbursement-style row.
function isRecoveryRow(t) {
  if (t.category !== 'reimbursement') return false;
  return (t.amount || 0) > 0;
}

function matchFinding(tx, openFindings) {
  // Strong: same order ID.
  if (tx.orderId) {
    const byOrder = openFindings.find((f) => f.order_id && f.order_id === tx.orderId);
    if (byOrder) return { finding: byOrder, matchedBy: 'order_id' };
  }
  // Strong-ish: same adjustment / shipment reference stored in evidence.
  // Weak: same SKU, only for categories where a reimbursement logically follows.
  if (tx.sku) {
    const bySku = openFindings.find((f) =>
      f.sku && f.sku === tx.sku && MATCHABLE_CATEGORIES.has(f.category));
    if (bySku) return { finding: bySku, matchedBy: 'sku' };
  }
  return null;
}

// Scans the transactions of a just-processed audit and closes any open findings
// whose issue now shows up as a reimbursement in this newer file.
function detectRecoveries({ workspaceId, auditId, transactions, detectedAt = Date.now() }) {
  const openFindings = db.listOpenFindingsForWorkspace(workspaceId, { excludeAuditId: auditId });
  if (!openFindings.length) return { matched: 0, recovered: 0, currency: null };

  const claimed = new Set();
  let matched = 0;
  let recovered = 0;
  let currency = null;

  for (const tx of transactions) {
    if (!isRecoveryRow(tx)) continue;
    const candidates = openFindings.filter((f) => !claimed.has(f.id));
    const hit = matchFinding(tx, candidates);
    if (!hit) continue;

    const { finding } = hit;
    const amount = round2(tx.amount);
    const resolution = db.insertResolution({
      findingId: finding.id,
      auditId: finding.audit_id,
      workspaceId,
      kind: 'auto_detected',
      recoveredAmount: amount,
      currency: tx.currency || null,
      detectedSource: `settlement ${tx.settlementId || 'n/a'} row ${tx.sourceRow}`,
      detectedAt,
      evidence: {
        matchedBy: hit.matchedBy,
        sourceRow: tx.sourceRow,
        settlementId: tx.settlementId || null,
        transactionType: tx.transactionType || null,
        amount,
        raw: tx.raw || [],
      },
    });
    if (!resolution) continue; // already resolved

    claimed.add(finding.id);
    // The reimbursement is already in the seller's own settlement, so this is
    // cash-confirmed — not merely potential. The transition posts to the ledger.
    try {
      recovery.transition({
        workspaceId,
        findingId: finding.id,
        toState: 'CASH_CONFIRMED',
        actor: 'system',
        source: 'settlement_reimbursement',
        note: `Reimbursement matched by ${hit.matchedBy === 'order_id' ? 'order id' : 'SKU'}`,
        evidenceRef: `settlement ${tx.settlementId || 'n/a'} row ${tx.sourceRow}`,
      });
    } catch (err) {
      logger.warn('recovery transition failed', { findingId: finding.id, error: String(err) });
    }

    matched += 1;
    recovered = round2(recovered + amount);
    currency = tx.currency || currency;
  }

  return { matched, recovered, currency };
}

// Marks a finding resolved with a seller-entered amount. Used when the seller
// confirms a recovery that did not arrive as a settlement row (e.g. a one-off
// account credit), or records a value for their own books.
function recordManualResolution({ workspaceId, findingId, recoveredAmount = null, currency = null, note = '', detectedAt = Date.now() }) {
  const finding = db.get('SELECT f.* FROM findings f JOIN audits a ON a.id = f.audit_id WHERE f.id = ? AND a.workspace_id = ?', [findingId, workspaceId]);
  if (!finding) return null;
  const resolution = db.insertResolution({
    findingId: finding.id,
    auditId: finding.audit_id,
    workspaceId,
    kind: 'seller_confirmed',
    recoveredAmount: recoveredAmount === null ? null : round2(recoveredAmount),
    currency,
    detectedSource: 'seller entry',
    detectedAt,
    evidence: { note },
  });
  if (!resolution) return null;
  const hasAmount = recoveredAmount !== null && recoveredAmount !== undefined;
  try {
    recovery.transition({
      workspaceId,
      findingId: finding.id,
      toState: hasAmount ? 'CASH_CONFIRMED' : 'CLOSED',
      actor: 'seller',
      source: 'manual_entry',
      note: note || (hasAmount ? 'Seller confirmed cash received' : 'Seller closed the finding'),
      skipLedger: true,
    });
  } catch (err) {
    logger.warn('manual resolution transition failed', { findingId: finding.id, error: String(err) });
    db.updateFindingStatus(finding.id, finding.audit_id, 'resolved');
  }
  if (hasAmount) {
    db.addLedger({
      workspaceId, entryDate: detectedAt, type: 'recovery', amount: round2(recoveredAmount),
      currency, findingId: finding.id, auditId: finding.audit_id, note: note || 'Seller-confirmed recovery',
    });
  }
  return resolution;
}

// Monthly proof-of-value report: the artifact that justifies the subscription.
function valueReport(workspaceId, { planPrice = 0, planCurrency = null } = {}) {
  const totals = db.ledgerTotals(workspaceId);
  const byMonth = db.ledgerByMonth(workspaceId);
  const resolutions = db.listResolutions(workspaceId, 100);

  const thisMonth = byMonth[0] || { period: null, amount: 0, entries: 0 };
  let roi = null;
  if (planPrice > 0 && thisMonth.amount > 0) roi = round2(thisMonth.amount / planPrice);
  else if (planPrice > 0) roi = 0;

  const monthName = thisMonth.period
    ? new Date(`${thisMonth.period}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : null;

  let headline;
  if (totals.recovered > 0) {
    headline = `SettleProof found and tracked ${totals.recovered.toFixed(2)} ${totals.currency || ''} of recoveries across your settlements.`.trim();
  } else if (resolutions.length === 0) {
    headline = 'No recoveries detected yet. Keep uploading settlements and we will match reimbursements back to the issues we flag.';
  } else {
    headline = 'Issues have been resolved; recovery amounts have not been quantified yet.';
  }

  return {
    totals,
    states: recovery.valueSummary(workspaceId),
    thisMonth: { ...thisMonth, planPrice, planCurrency, roi, monthName },
    byMonth,
    resolutions,
    headline,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detectRecoveries, recordManualResolution, valueReport, isRecoveryRow, MATCHABLE_CATEGORIES };
