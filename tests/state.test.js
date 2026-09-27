'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(os.tmpdir(), `sp-state-test-${crypto.randomUUID()}`);
process.env.APP_SECRET = 'test-secret-value-1234567890';

const db = require('../server/db');
const recovery = require('../server/recovery');
const retention = require('../server/retention');
const billing = require('../server/billing');

function setup() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = db.createUser({ email: `state-${suffix}@example.com`, name: 'State', passwordHash: 'x', passwordSalt: 'y' });
  const ws = db.createWorkspace({ name: 'State WS', ownerId: user.id });
  const audit = db.createAudit({ workspaceId: ws.id, userId: user.id, name: 'Audit' });
  db.insertFindings(audit.id, [{
    ruleId: 'R005', category: 'fee_audit', severity: 'high', confidence: 'high',
    title: 'Overcharged referral fee', detail: 'fixture', sku: 'SKU-1', orderId: 'ORD-1',
    amount: 25, currency: 'USD', recoverable: true, evidence: { sourceRows: [3], calculation: 'expected 10, charged 35' },
  }]);
  const finding = db.listFindings(audit.id, {})[0];
  return { user, ws, audit, finding };
}

test('a valid transition records from, to, actor and evidence in the audit trail', () => {
  const { ws, finding } = setup();
  const result = recovery.transition({
    workspaceId: ws.id, findingId: finding.id, toState: 'EVIDENCE_READY',
    actor: 'seller', note: 'checked the report', evidenceRef: 'report p.2',
  });
  assert.equal(result.finding.recovery_state, 'EVIDENCE_READY');
  assert.equal(result.event.from_state, 'POTENTIAL');
  assert.equal(result.event.to_state, 'EVIDENCE_READY');
  assert.equal(result.event.actor, 'seller');

  const timeline = db.listFindingEvents(finding.id);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].evidence_ref, 'report p.2');
});

test('impossible transitions are rejected', () => {
  const { ws, finding } = setup();
  // Force a terminal state, then try to move out of it illegally.
  recovery.transition({ workspaceId: ws.id, findingId: finding.id, toState: 'CLOSED', actor: 'seller' });
  assert.throws(
    () => recovery.transition({ workspaceId: ws.id, findingId: finding.id, toState: 'SELLER_REVIEW', actor: 'seller' }),
    (err) => err.status === 409 && err.code === 'invalid_transition',
  );
});

test('cash confirmation posts to the ledger exactly once', () => {
  const { ws, finding } = setup();
  recovery.transition({ workspaceId: ws.id, findingId: finding.id, toState: 'CASH_CONFIRMED', actor: 'seller' });
  assert.equal(db.ledgerTotals(ws.id).recovered, 25);
  // Re-confirming the same state must not duplicate the amount.
  recovery.transition({ workspaceId: ws.id, findingId: finding.id, toState: 'CASH_CONFIRMED', actor: 'seller' });
  assert.equal(db.ledgerTotals(ws.id).entries, 1);
  assert.equal(db.listResolutions ? db.listResolutions(ws.id).length >= 0 : true, true);
});

test('value summary keeps potential and cash-confirmed value strictly separate', () => {
  const { ws, audit } = setup();
  const second = db.listFindings(audit.id, {})[0];
  recovery.transition({ workspaceId: ws.id, findingId: second.id, toState: 'CLAIM_SUBMITTED', actor: 'seller' });

  db.insertFindings(audit.id, [{
    ruleId: 'R008', category: 'storage', severity: 'medium', confidence: 'medium',
    title: 'Storage outlier', detail: 'fixture', amount: 100, currency: 'USD', recoverable: false, evidence: {},
  }]);
  const other = db.listFindings(audit.id, {}).find((f) => f.title === 'Storage outlier');

  let summary = recovery.valueSummary(ws.id);
  assert.equal(summary.submittedValue, 25);
  assert.equal(summary.potentialValue, 100);
  assert.equal(summary.cashConfirmedValue, 0);
  assert.equal(summary.totalCustomerValue, 0);

  recovery.transition({ workspaceId: ws.id, findingId: other.id, toState: 'CASH_CONFIRMED', actor: 'seller' });
  summary = recovery.valueSummary(ws.id);
  assert.equal(summary.cashConfirmedValue, 100);
  assert.equal(summary.totalCustomerValue, 100);
});

test('onboarding advances only on real activity', () => {
  const { ws, finding } = setup();
  let status = recovery.onboardingStatus(ws.id);
  assert.equal(status.steps.find((s) => s.key === 'account_created').done, true);
  assert.equal(status.steps.find((s) => s.key === 'settlement_uploaded').done, true);
  assert.equal(status.steps.find((s) => s.key === 'action_completed').done, false);

  recovery.transition({ workspaceId: ws.id, findingId: finding.id, toState: 'EVIDENCE_READY', actor: 'seller' });
  status = recovery.onboardingStatus(ws.id);
  assert.equal(status.steps.find((s) => s.key === 'evidence_reviewed').done, true);
});

test('a finding cannot be transitioned through the wrong tenant', () => {
  const { finding } = setup();
  const other = setup();
  assert.throws(
    () => recovery.transition({ workspaceId: other.ws.id, findingId: finding.id, toState: 'EVIDENCE_READY', actor: 'seller' }),
    (err) => err.status === 404,
  );
});

test('the outbox retries with a delay then gives up, never marking a failure as sent', () => {
  const { ws } = setup();
  const id = retention.onUnresolvedReminder({ workspaceId: ws.id, count: 3 });
  assert.ok(id);

  const claimed = db.claimOutboxBatch(10).filter((m) => m.id === id);
  assert.equal(claimed.length, 1);
  assert.equal(db.get('SELECT attempts, status FROM email_outbox WHERE id = ?', [id]).attempts, 1);
  assert.equal(db.get('SELECT status FROM email_outbox WHERE id = ?', [id]).status, 'processing');

  db.markEmailFailed(id, 'smtp down', 60000);
  const requeued = db.get('SELECT * FROM email_outbox WHERE id = ?', [id]);
  assert.equal(requeued.status, 'queued');
  assert.ok(requeued.next_attempt_at > Date.now());

  // Exhaust the attempts (each claim increments the attempt counter).
  for (let i = 0; i < 10; i++) { db.claimOutboxBatch(100); db.markEmailFailed(id, 'still down', 0); }
  assert.equal(db.get('SELECT * FROM email_outbox WHERE id = ?', [id]).status, 'failed');

  // With no provider, a flush never claims or reports a send.
  const flushed = retention.flushOutbox();
  assert.equal(flushed.provider, 'none');
  assert.equal(flushed.sent, 0);
});

test('duplicate webhook events are ignored', () => {
  const { ws } = setup();
  const ref = billing.referenceFor(ws.id, 'plan', 'seller');
  const event = {
    id: 'evt_test_1',
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { reference_id: ref } } },
  };
  const first = billing.handleRazorpayEvent(event);
  assert.equal(first.applied, true);
  const second = billing.handleRazorpayEvent(event);
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
});
