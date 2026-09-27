'use strict';

const fs = require('fs');
const db = require('../db');
const logger = require('../lib/logger');
const { parseFile } = require('../parsers/parseFile');
const amazon = require('../parsers/amazon');
const { runAudit } = require('../audit/engine');
const value = require('../value');
const retention = require('../retention');

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

function minMax(values) {
  const present = values.filter(Boolean).sort();
  if (!present.length) return { min: null, max: null };
  return { min: present[0], max: present[present.length - 1] };
}

// Parses an uploaded file and runs the audit. Runs after the HTTP response so
// the client can poll the audit status.
function processAudit({ auditId, workspaceId, filePath, originalName }) {
  const job = db.getAuditJob(auditId);
  db.updateAuditJob(auditId, { status: 'running', attempts: (job ? job.attempts : 0) + 1 });
  try {
    const buffer = fs.readFileSync(filePath);
    const parsed = parseFile({ buffer, filename: originalName });
    const { map, unmapped, mappedCount } = amazon.buildColumnMap(parsed.columns);
    const reportKind = amazon.detectReportKind(map);

    const transactions = parsed.rows.map((row, i) => amazon.normalizeTransaction(row, map, i + 2));
    const cogsMap = new Map(db.listCogs(workspaceId).map((c) => [c.sku, c.unit_cost]));

    const { findings, summary } = runAudit({
      transactions,
      columns: parsed.columns,
      columnMap: { map, unmapped, mappedCount },
      reportKind,
      cogs: cogsMap,
    });

    db.clearFindingsForAudit(auditId);
    db.insertFindings(auditId, findings);

    // Close the loop: a reimbursement in this file can prove an earlier finding
    // was actually paid back. We only record it when the seller's own data
    // contains the matching row.
    let recovery = { matched: 0, recovered: 0, currency: null };
    try {
      recovery = value.detectRecoveries({ workspaceId, auditId, transactions });
    } catch (err) {
      logger.error('recovery detection failed', { auditId, error: String(err) });
    }

    const periods = minMax(transactions.flatMap((t) => [t.postedDate, t.settlementStartDate, t.settlementEndDate]));
    const severityFindings = findings.length;
    const auditRow = db.getAudit(auditId);

    db.updateAudit(auditId, {
      status: 'completed',
      completed_at: db.now(),
      marketplace: mostCommon(transactions.map((t) => t.marketplace)),
      period_start: periods.min,
      period_end: periods.max,
      deposit_date: mostCommon(transactions.map((t) => t.depositDate)),
      currency: summary.currency,
      encoding: parsed.meta.encoding,
      delimiter: parsed.meta.delimiter,
      row_count: parsed.rows.length,
      tx_count: transactions.length,
      findings_count: severityFindings,
      recoverable_total: summary.recoverableTotal,
      summary_json: JSON.stringify({ ...summary, parseMeta: parsed.meta, recovery }),
    });

    try {
      retention.onAuditCompleted({
        workspaceId,
        auditName: auditRow ? auditRow.name : 'your audit',
        findingsCount: findings.length,
        severityCounts: summary.severityCounts,
      });
      if (recovery.matched) {
        retention.onRecoveryDetected({
          workspaceId,
          recovered: recovery.recovered,
          currency: recovery.currency,
          count: recovery.matched,
        });
      }
    } catch (err) {
      logger.error('retention queue failed', { auditId, error: String(err) });
    }

    logger.info('audit completed', { auditId, rows: parsed.rows.length, findings: severityFindings, recoveries: recovery.matched });
    db.updateAuditJob(auditId, { status: 'completed', last_error: null });
    return { ok: true };
  } catch (err) {
    const message = err && err.status && err.message ? err.message : 'Failed to process the file.';
    logger.error('audit failed', { auditId, error: err });
    db.updateAudit(auditId, {
      status: 'failed',
      completed_at: db.now(),
      error: message,
    });
    db.updateAuditJob(auditId, { status: 'failed', last_error: message });
    return { ok: false, error: message };
  }
}

module.exports = { processAudit };
