'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const { config } = require('../config');
const { ok, fail } = require('../lib/respond');
const { asyncHandler, conflict } = require('../lib/errors');
const { limiter } = require('../lib/rateLimit');
const { ingestAudit } = require('../services/ingest');
const recovery = require('../recovery');

const router = express.Router();

// Waits (briefly) for the background audit to finish so the demo can pre-load a
// realistic recovery pipeline. Never throws; the demo still works if it times out.
function waitForAudit(auditId, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const a = db.getAudit(auditId);
      if (!a || a.status === 'completed' || a.status === 'failed') return resolve(a);
      if (Date.now() - start > timeoutMs) return resolve(a);
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Moves one finding along a chain of valid states. Failures are swallowed so the
// demo account is still usable even if a single step cannot be applied.
function advance(workspaceId, finding, chain, actor = 'seller') {
  for (const step of chain) {
    try {
      recovery.transition({
        workspaceId,
        findingId: finding.id,
        toState: step.to,
        actor,
        note: step.note || 'Demo data',
        caseRef: step.caseRef,
        source: 'demo',
      });
    } catch { /* ignore individual demo steps */ }
  }
}

const demoLimiter = limiter({
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => `demo:${req.ip}`,
});

// Creates a disposable account pre-loaded with the sample settlement so a
// visitor can see the product without signing up. The account has no password
// anyone can use; it is only reachable through the session created here.
router.post('/', demoLimiter, asyncHandler(async (req, res) => {
  if (!config.allowSignup) return fail(res, 403, 'signup_disabled', 'Demo is currently unavailable.');
  const sample = path.join(config.root, 'data', 'sample', 'settlement-sample.csv');
  if (!fs.existsSync(sample)) throw conflict('Sample file is not bundled in this build');

  const suffix = crypto.randomBytes(6).toString('hex');
  const password = crypto.randomBytes(24).toString('base64url');
  const { hash, salt } = auth.hashPassword(password);
  const user = db.createUser({
    email: `demo-${suffix}@demo.settleproof.app`,
    name: 'Demo user',
    passwordHash: hash,
    passwordSalt: salt,
  });
  const workspace = db.createWorkspace({ name: 'Demo workspace', ownerId: user.id });

  const tmp = path.join(storage.tmpDir, `${crypto.randomUUID()}.csv`);
  fs.copyFileSync(sample, tmp);
  const audit = ingestAudit({
    workspaceId: workspace.id,
    userId: user.id,
    tmpFilePath: tmp,
    originalName: 'settlement-sample.csv',
    name: 'Sample settlement audit',
    source: 'demo',
  });

  // Pre-load a realistic recovery pipeline so the demo shows the whole value
  // loop (potential -> submitted -> Amazon confirmed -> cash confirmed).
  try {
    await waitForAudit(audit.id);
    const findings = db.listWorkspaceFindings(workspace.id, { limit: 50 })
      .filter((f) => f.confidence !== 'insufficient');
    const withAmount = findings.filter((f) => f.amount && f.amount > 0);
    const picks = (withAmount.length ? withAmount : findings).slice(0, 3);
    if (picks[0]) {
      advance(workspace.id, picks[0], [
        { to: 'EVIDENCE_READY' },
        { to: 'SELLER_REVIEW' },
        { to: 'CLAIM_SUBMITTED', caseRef: 'DEMO-CASE-0001' },
        { to: 'AMAZON_CONFIRMED' },
        { to: 'CASH_CONFIRMED', note: 'Demo: seller confirmed reimbursement' },
      ]);
    }
    if (picks[1]) advance(workspace.id, picks[1], [{ to: 'CLAIM_SUBMITTED', caseRef: 'DEMO-CASE-0002' }]);
    if (picks[2]) advance(workspace.id, picks[2], [
      { to: 'CLAIM_SUBMITTED', caseRef: 'DEMO-CASE-0003' },
      { to: 'AMAZON_CONFIRMED' },
    ]);
  } catch (err) {
    db.logEvent('warn', 'demo.pipeline_failed', { userId: user.id, error: String(err && err.message) });
  }

  const session = auth.startSession(res, user, req);
  db.logEvent('info', 'demo.session', { userId: user.id, auditId: audit.id });
  return res.status(201).json({
    ok: true,
    data: {
      user: { id: user.id, name: user.name, email: user.email },
      workspace,
      csrf: session.csrf,
      sessionToken: session.sid,
      auditId: audit.id,
      demo: true,
    },
  });
}));

module.exports = router;
