'use strict';

// Lifecycle sweep: the retention loop's recurring half. Runs daily and queues at
// most one monthly value report per workspace and one unresolved-findings nudge
// per workspace per week (idempotency keys make repeat runs safe). Messages are
// queued in the outbox; nothing is ever reported as sent without a provider.

const db = require('../db');
const logger = require('../lib/logger');
const plans = require('../plans');
const value = require('../value');
const retention = require('../retention');

const DAY_MS = 24 * 3600 * 1000;

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);
  return `${d.getUTCFullYear()}W${String(week).padStart(2, '0')}`;
}

function oldestOpenFindingAgeDays(workspaceId) {
  const row = db.get(
    `SELECT MIN(f.created_at) AS oldest
       FROM findings f JOIN audits a ON a.id = f.audit_id
      WHERE a.workspace_id = ?
        AND f.recovery_state NOT IN ('CLOSED', 'CASH_CONFIRMED', 'REJECTED', 'EXPIRED', 'UNVERIFIED')`,
    [workspaceId],
  );
  if (!row || !row.oldest) return null;
  return (Date.now() - row.oldest) / DAY_MS;
}

function runLifecycleSweep() {
  const rows = db.all('SELECT id FROM workspaces');
  let monthly = 0;
  let unresolved = 0;

  for (const { id: workspaceId } of rows) {
    try {
      const entitlements = plans.getEntitlements(workspaceId);
      const report = value.valueReport(workspaceId, {
        planPrice: entitlements.plan.price,
        planCurrency: entitlements.plan.currency,
      });

      const period = report.thisMonth.period;
      if (period && report.thisMonth.amount > 0) {
        retention.onMonthlyValueReport({
          workspaceId,
          cashConfirmed: report.thisMonth.amount,
          currency: report.totals.currency,
          monthName: report.thisMonth.monthName,
          roi: report.thisMonth.roi,
          idempotencyKey: `monthly:${workspaceId}:${period}`,
        });
        monthly += 1;
      }

      const open = report.states.openIssues;
      const ageDays = oldestOpenFindingAgeDays(workspaceId);
      if (open > 0 && ageDays !== null && ageDays >= 3) {
        retention.onUnresolvedReminder({
          workspaceId,
          count: open,
          idempotencyKey: `unresolved:${workspaceId}:${isoWeek()}`,
        });
        unresolved += 1;
      }
    } catch (err) {
      logger.warn('lifecycle sweep failed for workspace', { workspaceId, error: String(err) });
    }
  }

  return { workspaces: rows.length, monthly, unresolved };
}

module.exports = { runLifecycleSweep, isoWeek };
