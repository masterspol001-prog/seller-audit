'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(os.tmpdir(), `sp-jobs-test-${crypto.randomUUID()}`);
process.env.APP_SECRET = 'test-secret-value-1234567890';

const db = require('../server/db');
const storage = require('../server/storage');
const { processAudit } = require('../server/services/processAudit');
const { retryFailedAuditJobs } = require('../server/services/auditJobs');
const { runLifecycleSweep } = require('../server/services/lifecycle');
const { SAMPLE } = require('./helpers');

function countFindings(auditId) {
  return db.get('SELECT COUNT(*) AS n FROM findings WHERE audit_id = ?', [auditId]).n;
}

test('audit processing is idempotent and retryable', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = db.createUser({
    email: `jobs-${suffix}@example.com`,
    name: 'Jobs',
    passwordHash: 'x',
    passwordSalt: 'y',
  });
  const ws = db.createWorkspace({ name: 'Jobs ws', ownerId: user.id });
  const audit = db.createAudit({
    workspaceId: ws.id,
    userId: user.id,
    name: 'Jobs audit',
    fileName: 'settlement-sample.csv',
  });
  db.createAuditJob(audit.id, ws.id);

  // Park the file where the retry sweep expects to find it.
  const dest = storage.finalPath(ws.id, audit.id, '.csv');
  fs.copyFileSync(SAMPLE, dest);

  const first = processAudit({ auditId: audit.id, workspaceId: ws.id, filePath: dest, originalName: 'settlement-sample.csv' });
  assert.equal(first.ok, true);

  const firstAudit = db.getAudit(audit.id);
  assert.equal(firstAudit.status, 'completed');
  const baseline = countFindings(audit.id);
  assert.ok(baseline > 0, 'expected findings from the sample');
  assert.equal(db.getAuditJob(audit.id).status, 'completed');
  assert.equal(db.getAuditJob(audit.id).attempts, 1);

  // Simulate a crash: the audit is marked failed and the job is retryable.
  db.updateAudit(audit.id, { status: 'failed' });
  db.updateAuditJob(audit.id, { status: 'failed', last_error: 'simulated crash' });

  const retried = retryFailedAuditJobs();
  assert.equal(retried, 1);

  // Re-processing must not duplicate findings for the same audit.
  assert.equal(countFindings(audit.id), baseline);
  assert.equal(db.getAudit(audit.id).status, 'completed');
  const job = db.getAuditJob(audit.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 2);
});

test('a job that exhausted its attempts is not retried', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = db.createUser({ email: `jobs2-${suffix}@example.com`, name: 'Jobs2', passwordHash: 'x', passwordSalt: 'y' });
  const ws = db.createWorkspace({ name: 'Jobs ws 2', ownerId: user.id });
  const audit = db.createAudit({ workspaceId: ws.id, userId: user.id, name: 'Dead audit' });
  db.createAuditJob(audit.id, ws.id);
  db.updateAuditJob(audit.id, { status: 'failed', attempts: 3, last_error: 'gave up' });

  retryFailedAuditJobs();
  const job = db.getAuditJob(audit.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 3);
});

test('lifecycle sweep queues one monthly value report per period', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = db.createUser({ email: `life-${suffix}@example.com`, name: 'Life', passwordHash: 'x', passwordSalt: 'y' });
  const ws = db.createWorkspace({ name: 'Life ws', ownerId: user.id });
  db.addLedger({ workspaceId: ws.id, entryDate: db.now(), type: 'recovery', amount: 100, currency: 'INR', note: 'test' });

  const before = db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE idempotency_key LIKE 'monthly:%'").n;
  const first = runLifecycleSweep();
  assert.ok(first.workspaces >= 1);
  const afterFirst = db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE idempotency_key LIKE 'monthly:%'").n;
  assert.equal(afterFirst, before + 1);

  // A second sweep in the same period must not queue a duplicate.
  runLifecycleSweep();
  const afterSecond = db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE idempotency_key LIKE 'monthly:%'").n;
  assert.equal(afterSecond, afterFirst);
});
