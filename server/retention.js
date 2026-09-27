'use strict';

// Retention loop.
//
// Every meaningful event queues a message in the outbox so the seller keeps
// coming back: first audit ready, new findings, and — the important one — a
// detected recovery that closes the loop on an issue we flagged earlier.
//
// No email provider is configured in this build, so messages stay queued for an
// operator to send (or for a provider worker to drain). That is deliberate: we
// never report a message as "sent" when it was not.

const db = require('./db');
const logger = require('./lib/logger');
const { config } = require('./config');

function ownerEmail(workspaceId) {
  const ws = db.getWorkspace(workspaceId);
  if (!ws) return null;
  const user = db.getUserById(ws.owner_id);
  return user ? user.email : null;
}

function enqueue({ workspaceId, subject, body, kind, idempotencyKey = null }) {
  const to = ownerEmail(workspaceId);
  if (!to) return null;
  if (idempotencyKey) {
    const existing = db.get('SELECT id FROM email_outbox WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return existing.id;
  }
  const eid = db.enqueueEmail({ workspaceId, to, subject, body, kind });
  if (idempotencyKey) db.run('UPDATE email_outbox SET idempotency_key = ? WHERE id = ?', [idempotencyKey, eid]);
  logger.info('retention email queued', { workspaceId, kind });
  return eid;
}

function onAuditCompleted({ workspaceId, auditName, findingsCount, severityCounts }) {
  if (!findingsCount) {
    return enqueue({
      workspaceId,
      kind: 'audit_clean',
      subject: `Your audit "${auditName}" is clean`,
      body: `Good news: we audited "${auditName}" and found nothing that needs your attention. `
        + `Keep uploading each settlement and we will keep watching for fee errors and reimbursements.`,
    });
  }
  const high = (severityCounts && (severityCounts.high || 0) + (severityCounts.critical || 0)) || 0;
  return enqueue({
    workspaceId,
    kind: 'audit_findings',
    subject: `${findingsCount} things to review in "${auditName}"`,
    body: `We finished auditing "${auditName}" and flagged ${findingsCount} items`
      + (high ? `, ${high} of them high severity` : '')
      + `. Open the audit, confirm the real issues, and we will automatically watch your next settlements `
      + `to detect when Amazon reimburses them.`,
  });
}

function onRecoveryDetected({ workspaceId, recovered, currency, count }) {
  if (!recovered) return null;
  return enqueue({
    workspaceId,
    kind: 'recovery_detected',
    subject: `Recovery detected: ${recovered.toFixed(2)} ${currency || ''}`.trim(),
    body: `Your latest settlement contains a reimbursement that matches ${count} issue(s) we flagged earlier: `
      + `${recovered.toFixed(2)} ${currency || ''}. It has been added to your value report. `
      + `This is why the audit pays for itself — keep uploading so we catch every one.`,
  });
}

function onUpgrade({ workspaceId, planLabel }) {
  return enqueue({
    workspaceId,
    kind: 'upgrade',
    subject: `You are on the ${planLabel} plan`,
    body: `Thanks for upgrading to ${planLabel}. Your limits have increased immediately: more audits, COGS and `
      + `profitability, longer retention and every export format. Your monthly value report shows exactly what `
      + `the tool recovered for you.`,
  });
}

function onEvidenceReady({ workspaceId, title, findingId }) {
  return enqueue({
    workspaceId,
    kind: 'evidence_ready',
    subject: `Evidence ready: ${title}`,
    body: `The evidence package for "${title}" is ready. Review it, then submit the claim to Amazon and record `
      + `the case reference so we can track the outcome alongside your settlements.`,
    idempotencyKey: `evidence:${findingId}`,
  });
}

function onUnresolvedReminder({ workspaceId, count, idempotencyKey = null }) {
  return enqueue({
    workspaceId,
    kind: 'unresolved_reminder',
    subject: `${count} finding(s) still need your review`,
    body: `You have ${count} finding(s) that have not been actioned yet. Reviewing them takes a few minutes and `
      + `keeps the evidence current before the Amazon claim window closes.`,
    idempotencyKey,
  });
}

function onAmazonResponseReminder({ workspaceId, title, findingId }) {
  return enqueue({
    workspaceId,
    kind: 'amazon_response_reminder',
    subject: `Any response from Amazon on "${title}"?`,
    body: `We have "${title}" marked as submitted. When Amazon responds, record the outcome so your value report `
      + `reflects what was actually confirmed. If they approve it, confirm the cash when it lands in a settlement.`,
    idempotencyKey: `amazon_response:${findingId}`,
  });
}

function onCashConfirmationReminder({ workspaceId, title, findingId }) {
  return enqueue({
    workspaceId,
    kind: 'cash_confirmation_reminder',
    subject: `Confirm the cash for "${title}"`,
    body: `Amazon confirmed "${title}". Once the money appears in your settlement, mark it cash-confirmed so it `
      + `counts in your value report. We only count money you have actually received.`,
    idempotencyKey: `cash_confirmation:${findingId}`,
  });
}

function onMonthlyValueReport({ workspaceId, cashConfirmed, currency, monthName, roi, idempotencyKey = null }) {
  return enqueue({
    workspaceId,
    kind: 'monthly_value_report',
    subject: `Your SettleProof value report for ${monthName}`,
    body: `This month we tracked ${cashConfirmed.toFixed(2)} ${currency || ''} of cash-confirmed recoveries`
      + (roi === null ? '' : `, a ${roi.toFixed(1)}x return on your plan`)
      + `. Keep uploading each settlement so every reimbursement is matched back to the issue it closes.`,
    idempotencyKey,
  });
}

function onReferralActivated({ referrerWorkspaceId, credit }) {
  return enqueue({
    workspaceId: referrerWorkspaceId,
    kind: 'referral_activated',
    subject: `Referral credit of ${credit} applied`,
    body: `Someone you referred activated a paid plan. Your account credit of ${credit} has been applied. `
      + `Thanks for spreading the word.`,
  });
}

function retryDelayMs(attempts) {
  const minutes = Math.min(2 ** Math.max(attempts, 1), 360);
  return minutes * 60 * 1000;
}

// A provider is only present when credentials are configured. We never report a
// message as sent without one.
function emailProvider() {
  return null;
}

// Drains the outbox through a provider. With no provider configured we leave
// messages queued so nothing is falsely marked as delivered.
function flushOutbox({ limit = 25 } = {}) {
  const provider = emailProvider();
  if (!provider) {
    const queued = db.listOutbox({ status: 'queued', limit: 500 }).length;
    return { provider: 'none', queued, claimed: 0, sent: 0, failed: 0, note: 'No email provider configured; messages remain queued.' };
  }
  const batch = db.claimOutboxBatch(limit);
  let sent = 0;
  let failed = 0;
  for (const msg of batch) {
    try {
      provider.send(msg);
      db.markEmailSent(msg.id);
      sent += 1;
    } catch (err) {
      db.markEmailFailed(msg.id, String(err), retryDelayMs(msg.attempts));
      failed += 1;
    }
  }
  return { provider: 'configured', claimed: batch.length, sent, failed };
}

function markEmailSentByAdmin(id_) {
  db.markEmailSent(id_);
  return db.get('SELECT * FROM email_outbox WHERE id = ?', [id_]);
}

module.exports = {
  ownerEmail,
  onAuditCompleted,
  onRecoveryDetected,
  onUpgrade,
  onEvidenceReady,
  onUnresolvedReminder,
  onAmazonResponseReminder,
  onCashConfirmationReminder,
  onMonthlyValueReport,
  onReferralActivated,
  flushOutbox,
  markEmailSentByAdmin,
  emailProvider,
};
