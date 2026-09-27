'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(os.tmpdir(), `sp-value-test-${crypto.randomUUID()}`);
process.env.APP_SECRET = 'test-secret-value-1234567890';

const db = require('../server/db');
const value = require('../server/value');
const plans = require('../server/plans');

function setupWorkspace() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = db.createUser({
    email: `value-${suffix}@example.com`,
    name: 'Value Tester',
    passwordHash: 'x', passwordSalt: 'y',
  });
  const ws = db.createWorkspace({ name: 'Value WS', ownerId: user.id });
  return ws;
}

function seedFinding(ws, { orderId = null, sku = null, category = 'fee_audit', status = 'open' } = {}) {
  const audit = db.createAudit({ workspaceId: ws.id, userId: ws.owner_id, name: 'Prior audit' });
  db.insertFindings(audit.id, [{
    ruleId: 'R005', category, severity: 'medium', confidence: 'medium',
    title: `Flag for ${sku || orderId || 'audit'}`, detail: 'test fixture',
    sku, orderId, amount: 12.5, currency: 'USD', recoverable: true, evidence: { sourceRows: [2] },
  }]);
  const finding = db.listFindings(audit.id, {})[0];
  if (status !== 'open') db.updateFindingStatus(finding.id, audit.id, status);
  return { audit, finding };
}

test('detectRecoveries closes an open finding when a later reimbursement matches by order id', () => {
  const ws = setupWorkspace();
  const { audit, finding } = seedFinding(ws, { orderId: 'ORDER-1', category: 'fee_audit' });

  const result = value.detectRecoveries({
    workspaceId: ws.id,
    auditId: 'newer-audit',
    transactions: [
      { category: 'reimbursement', amount: 12.5, orderId: 'ORDER-1', currency: 'USD', sourceRow: 5, settlementId: 'S9', transactionType: 'Reimbursement', raw: [] },
    ],
  });

  assert.equal(result.matched, 1);
  assert.equal(result.recovered, 12.5);
  assert.equal(result.currency, 'USD');

  const resolutions = db.listResolutions(ws.id);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'auto_detected');
  assert.equal(resolutions[0].evidence.matchedBy, 'order_id');
  assert.equal(db.listFindings(audit.id, {})[0].status, 'resolved');

  const totals = db.ledgerTotals(ws.id);
  assert.equal(totals.recovered, 12.5);
  assert.equal(totals.entries, 1);
});

test('detectRecoveries never double-counts and ignores non-recovery rows', () => {
  const ws = setupWorkspace();
  seedFinding(ws, { sku: 'SKU-A', category: 'storage' });

  const tx = { category: 'reimbursement', amount: 3.25, sku: 'SKU-A', currency: 'USD', sourceRow: 7, raw: [] };
  const first = value.detectRecoveries({ workspaceId: ws.id, auditId: 'a2', transactions: [tx] });
  assert.equal(first.matched, 1);

  const second = value.detectRecoveries({ workspaceId: ws.id, auditId: 'a3', transactions: [tx] });
  assert.equal(second.matched, 0);
  assert.equal(db.listResolutions(ws.id).length, 1);

  const sale = { category: 'sale', amount: 40, sku: 'SKU-A', currency: 'USD', sourceRow: 8, raw: [] };
  const third = value.detectRecoveries({ workspaceId: ws.id, auditId: 'a4', transactions: [sale] });
  assert.equal(third.matched, 0);
});

test('detectRecoveries ignores a SKU match for a non-reimbursable category', () => {
  const ws = setupWorkspace();
  seedFinding(ws, { sku: 'SKU-B', category: 'duplicate' });

  const result = value.detectRecoveries({
    workspaceId: ws.id,
    auditId: 'a5',
    transactions: [{ category: 'reimbursement', amount: 9, sku: 'SKU-B', currency: 'USD', sourceRow: 9, raw: [] }],
  });
  assert.equal(result.matched, 0);
});

test('a manual resolution records a recovery the file did not contain', () => {
  const ws = setupWorkspace();
  const { audit, finding } = seedFinding(ws, { orderId: 'ORDER-2' });

  const resolution = value.recordManualResolution({
    workspaceId: ws.id,
    findingId: finding.id,
    recoveredAmount: 50,
    currency: 'USD',
    note: 'Account credit',
  });
  assert.ok(resolution);
  assert.equal(resolution.kind, 'seller_confirmed');
  assert.equal(db.listFindings(audit.id, {})[0].status, 'resolved');
  assert.equal(db.ledgerTotals(ws.id).recovered, 50);
});

test('valueReport quantifies totals and ROI for the current month', () => {
  const ws = setupWorkspace();
  const { finding } = seedFinding(ws, { orderId: 'ORDER-3' });
  value.recordManualResolution({ workspaceId: ws.id, findingId: finding.id, recoveredAmount: 20, currency: 'USD' });

  const report = value.valueReport(ws.id, { planPrice: 10, planCurrency: 'USD' });
  assert.equal(report.totals.recovered, 20);
  assert.equal(report.thisMonth.roi, 2.0);
  assert.equal(report.resolutions.length, 1);
  assert.match(report.headline, /20/);
});

test('free plan allows two audits a month then asks for an upgrade', () => {
  const ws = setupWorkspace();
  const period = plans.currentPeriod();
  assert.equal(plans.getEntitlements(ws.id).remaining, 2);

  db.incrementUsage(ws.id, period);
  db.incrementUsage(ws.id, period);
  assert.throws(() => plans.assertCanRunAudit(ws.id), (err) => err.status === 402 && err.code === 'payment_required');

  db.addReportCredits(ws.id, 1);
  assert.doesNotThrow(() => plans.assertCanRunAudit(ws.id));
  db.incrementUsage(ws.id, period);
  plans.consumeAuditCredit(ws.id);
  assert.equal(plans.getEntitlements(ws.id).reportCredits, 0);
  assert.throws(() => plans.assertCanRunAudit(ws.id), (err) => err.status === 402);

  db.setSubscription(ws.id, { plan: 'seller', status: 'active', current_period_end: Date.now() + 86_400_000 });
  const ent = plans.getEntitlements(ws.id);
  assert.equal(ent.unlimited, true);
  assert.equal(plans.isPaid(ent), true);
  assert.doesNotThrow(() => plans.assertCanRunAudit(ws.id));
});

test('paid plans unlock COGS and the extended export formats', () => {
  const ws = setupWorkspace();
  assert.throws(() => plans.assertFeature(ws.id, 'cogs'), (err) => err.status === 402);
  assert.throws(() => plans.assertExport(ws.id, 'json'), (err) => err.status === 402);

  db.setSubscription(ws.id, { plan: 'seller', status: 'active', current_period_end: Date.now() + 86_400_000 });
  assert.doesNotThrow(() => plans.assertFeature(ws.id, 'cogs'));
  assert.doesNotThrow(() => plans.assertExport(ws.id, 'json'));
});
