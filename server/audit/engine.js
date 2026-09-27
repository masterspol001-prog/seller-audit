'use strict';

const rules = require('./rules');
const { makeFinding, insufficientEvidence, SEVERITY_RANK } = require('./findings');
const { round2 } = require('../parsers/amazon');

const RULES = [
  ['R001', rules.ruleRowTotalMismatch],
  ['R002', rules.ruleSettlementReconciliation],
  ['R003', rules.ruleDuplicateTransactions],
  ['R004', rules.ruleReferralFeeMissing],
  ['R005', rules.ruleReferralFeeAnomaly],
  ['R006', rules.ruleRefundWithoutOrder],
  ['R007', rules.ruleReimbursementReview],
  ['R008', rules.ruleStorageFeeAnomaly],
  ['R009', rules.ruleRemovalDiscrepancy],
  ['R010', rules.ruleAgedInventory],
  ['R011', rules.ruleCurrencyMismatch],
  ['R012', rules.ruleProfitability],
];

function runAudit({ transactions = [], columns = [], columnMap = { map: {}, unmapped: [], mappedCount: 0 }, reportKind = 'unknown', cogs = new Map(), options = {} } = {}) {
  const opts = { ...rules.DEFAULTS, ...options };
  const totals = rules.partitionTotals(transactions);
  const currencies = [...new Set(transactions.map((t) => t.currency).filter(Boolean))];
  const currency = currencies.length === 1 ? currencies[0] : null;

  const ctx = { transactions, columns, columnMap, reportKind, cogs, opts, totals, currency };

  const findings = [];
  const errors = [];
  for (const [ruleId, rule] of RULES) {
    try {
      const produced = rule(ctx) || [];
      for (const f of produced) findings.push(f);
    } catch (err) {
      errors.push({ ruleId, message: err.message });
    }
  }

  const dataGapFindings = dataGaps(ctx);
  const allFindings = findings.concat(dataGapFindings);
  const summary = buildSummary(ctx, allFindings, { reportKind, currencies, errors });

  return { findings: allFindings, summary };
}

/* Findings about data that is absent, so the seller knows what was NOT checked. */
function dataGaps(ctx) {
  const out = [];
  const has = (f) => ctx.columnMap.map && ctx.columnMap.map[f] !== undefined;
  const txs = ctx.transactions;

  if (!txs.length) {
    out.push(insufficientEvidence('R900', {
      category: 'data_gap',
      title: 'No transactions could be read',
      detail: 'The file parsed but contained no data rows. Check that you uploaded the settlement detail report and not an empty or summary-only export.',
    }));
    return out;
  }

  if (ctx.columnMap.map.settlementId === undefined) {
    out.push(insufficientEvidence('R901', {
      category: 'data_gap',
      title: 'No settlement ID column',
      detail: 'Without a settlement identifier the file cannot be grouped or reconciled per settlement.',
    }));
  }
  if (!has('priceAmount') && !has('itemRelatedFeeAmount') && !has('miscFeeAmount') && !has('otherFeeAmount')) {
    out.push(insufficientEvidence('R902', {
      category: 'data_gap',
      title: 'No recognizable amount columns',
      detail: 'None of the expected Amazon amount columns were found, so financial totals could not be built from this file.',
    }));
  }
  if (!has('transactionType')) {
    out.push(insufficientEvidence('R903', {
      category: 'data_gap',
      title: 'No transaction type column',
      detail: 'Transaction types are required to separate sales, refunds, fees and reimbursements.',
    }));
  }
  if (!has('sku')) {
    out.push(insufficientEvidence('R904', {
      category: 'data_gap',
      title: 'No SKU column',
      detail: 'Per-SKU profitability and COGS matching were not run because this file has no SKU column.',
    }));
  }

  const soldSkus = new Set(txs.filter((t) => t.category === 'order' && t.sku).map((t) => t.sku));
  const missingCogs = [...soldSkus].filter((sku) => !ctx.cogs.has(sku));
  if (soldSkus.size && missingCogs.length) {
    out.push(insufficientEvidence('R905', {
      category: 'data_gap',
      title: 'COGS missing for some SKUs',
      detail: `Profit for ${missingCogs.length} of ${soldSkus.size} sold SKUs ignores product cost because no COGS is set. Add COGS to make those margins trustworthy.`,
      evidence: { note: 'SKUs without COGS', skus: missingCogs.slice(0, 25) },
    }));
  }

  const explicitTotals = txs.filter((t) => t.explicitTotal !== null && t.explicitTotal !== undefined).length;
  if (explicitTotals === 0 && txs.length) {
    out.push(insufficientEvidence('R906', {
      category: 'data_gap',
      title: 'No stated totals to reconcile against',
      detail: 'This file has no total column, so rows could not be cross-checked against Amazon\u2019s own arithmetic. Settlement reconciliation is limited to internal consistency.',
    }));
  }

  return out;
}

function buildSummary(ctx, findings, { reportKind, currencies, errors }) {
  const txs = ctx.transactions;
  const sum = (arr, fn) => round2(arr.reduce((s, t) => s + (fn(t) || 0), 0));
  const byCat = (c) => txs.filter((t) => t.category === c);

  const orders = byCat('order');
  const grossSales = sum(orders, (t) => ((t.priceAmount || 0) > 0 ? t.priceAmount : 0));
  const promotions = sum(txs, (t) => t.promotionAmount);
  const fees = sum(txs, (t) => t.feeTotal);
  const refunds = sum(byCat('refund'), (t) => t.amount);
  const reimbursements = sum(byCat('reimbursement'), (t) => t.amount);
  const adjustments = sum(byCat('adjustment'), (t) => t.amount);
  const other = sum(txs.filter((t) => ['other', 'debt', 'transfer'].includes(t.category)), (t) => t.amount);
  const net = sum(txs, (t) => t.amount);

  const settlementMap = new Map();
  for (const t of txs) {
    if (!t.settlementId) continue;
    if (!settlementMap.has(t.settlementId)) {
      settlementMap.set(t.settlementId, {
        id: t.settlementId,
        start: t.settlementStartDate || null,
        end: t.settlementEndDate || null,
        deposit: t.depositDate || null,
        currency: t.currency || null,
        rows: 0,
        net: 0,
      });
    }
    const s = settlementMap.get(t.settlementId);
    s.rows += 1;
    s.net = round2(s.net + (t.amount || 0));
    if (!s.start && t.settlementStartDate) s.start = t.settlementStartDate;
    if (!s.end && t.settlementEndDate) s.end = t.settlementEndDate;
    if (!s.deposit && t.depositDate) s.deposit = t.depositDate;
  }

  const skuMap = new Map();
  for (const t of orders) {
    if (!t.sku) continue;
    if (!skuMap.has(t.sku)) skuMap.set(t.sku, { sku: t.sku, units: 0, revenue: 0, fees: 0, cogs: null, cogsKnown: ctx.cogs.has(t.sku) });
    const row = skuMap.get(t.sku);
    row.units += t.quantity && t.quantity > 0 ? t.quantity : 1;
    row.revenue = round2(row.revenue + (t.priceAmount || 0) + (t.promotionAmount || 0));
    row.fees = round2(row.fees - (t.feeTotal || 0));
  }
  const profitability = [...skuMap.values()].map((row) => {
    const cogs = row.cogsKnown ? round2(ctx.cogs.get(row.sku) * row.units) : null;
    const profit = round2(row.revenue - row.fees - (cogs || 0));
    return { ...row, cogs, profit, marginPct: row.revenue > 0 ? round2((profit / row.revenue) * 100) : null };
  }).sort((a, b) => a.profit - b.profit);

  const recoverableTotal = round2(findings.filter((f) => f.recoverable).reduce((s, f) => s + (f.amount || 0), 0));
  const potentialTotal = round2(findings.filter((f) => f.potential).reduce((s, f) => s + (f.amount || 0), 0));

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const categoryCounts = {};
  let insufficient = 0;
  for (const f of findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
    categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
    if (f.confidence === 'insufficient') insufficient += 1;
  }

  const limitations = findings
    .filter((f) => f.confidence === 'insufficient')
    .map((f) => f.title);

  return {
    reportKind,
    currency: ctx.currency,
    currencies,
    totals: { grossSales, promotions, fees, refunds, reimbursements, adjustments, other, net },
    counts: {
      rows: txs.length,
      orders: orders.length,
      refunds: byCat('refund').length,
      fees: byCat('fee').length,
      reimbursements: byCat('reimbursement').length,
      adjustments: byCat('adjustment').length,
      skus: skuMap.size,
      settlements: settlementMap.size,
    },
    settlements: [...settlementMap.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    profitability: profitability.slice(0, 100),
    recoverableTotal,
    potentialTotal,
    severityCounts,
    categoryCounts,
    insufficientEvidenceCount: insufficient,
    limitations,
    dataQuality: {
      columns: ctx.columns.length,
      mappedColumns: ctx.columnMap.mappedCount,
      unmappedColumns: ctx.columnMap.unmapped || [],
      ruleErrors: errors,
    },
  };
}

module.exports = { runAudit, RULES, SEVERITY_RANK };
