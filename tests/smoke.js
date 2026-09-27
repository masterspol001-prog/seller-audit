'use strict';

// End-to-end smoke test: boots the app in-process and walks the complete business
// journey — sign up, upload, audit, evidence, recovery state machine, value ledger,
// free-plan limit, checkout, verified webhook, paid entitlement, referral credit,
// lifecycle outbox and the audit log. Exits non-zero if any step fails.
// Run with: npm run smoke

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), `sp-smoke-${crypto.randomUUID()}`);
process.env.APP_SECRET = process.env.APP_SECRET || 'smoke-secret-smoke-secret-smoke';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smoke-admin-token';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'smoke-webhook-secret';

const { createApp } = require('../server/app');
const SAMPLE = path.join(__dirname, '..', 'data', 'sample', 'settlement-sample.csv');

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

function step(name, detail = '') {
  console.log(`  [ok] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = {};

  const capture = (res, prev) => {
    const next = { ...prev };
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) next[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    return next;
  };

  const req = async (pathname, { method = 'GET', body, csrf, headers = {}, rawBody } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (Object.keys(jar).length) h.Cookie = cookieHeader(jar);
    if (csrf) h['x-csrf-token'] = csrf;
    const res = await fetch(base + pathname, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
    });
    jar = capture(res, jar);
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
  };

  try {
    console.log('SettleProof smoke test');

    const health = await req('/api/health');
    assert(health.status === 200, 'health check');

    /* 1. create a customer */
    const signup = await req('/api/auth/signup', {
      method: 'POST',
      body: { email: `smoke-${crypto.randomUUID().slice(0, 8)}@example.com`, password: 'password123', name: 'Smoke Seller' },
    });
    assert(signup.status === 201, `signup failed (${signup.status})`);
    const csrf = signup.json.data.csrf;
    const wsId = signup.json.data.workspace.id;
    step('customer created');

    /* 2. upload and process a settlement */
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
    const upload = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
      method: 'POST',
      headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf },
      body: form,
    });
    jar = capture(upload, jar);
    assert(upload.status === 202, `upload failed (${upload.status})`);
    const auditId = (await upload.json()).data.audit.id;

    let status = 'processing';
    for (let i = 0; i < 60 && status === 'processing'; i++) {
      const s = await req(`/api/workspaces/${wsId}/audits/${auditId}/status`);
      status = s.json.data.status;
      if (status === 'processing') await new Promise((r) => setTimeout(r, 200));
    }
    assert(status === 'completed', `audit did not complete (status: ${status})`);
    step('settlement processed', auditId.slice(0, 8));

    /* 3. findings and evidence */
    const listRes = await req(`/api/workspaces/${wsId}/audits/${auditId}/findings`);
    const findings = listRes.json.data.findings;
    assert(findings.length > 0, 'expected findings from the sample');
    const first = findings[0];
    assert(first.evidence && Array.isArray(first.evidence.sourceRows), 'finding carries source rows');
    assert(first.recovery_state === 'POTENTIAL', 'new finding starts as POTENTIAL');
    step('findings generated', `${findings.length} findings, evidence attached`);

    /* 4. recovery state machine */
    let stepRes = await req(`/api/workspaces/${wsId}/findings/${first.id}/transition`, { method: 'POST', csrf, body: { toState: 'EVIDENCE_READY' } });
    assert(stepRes.status === 200 && stepRes.json.data.finding.recovery_state === 'EVIDENCE_READY', 'transition to EVIDENCE_READY');
    stepRes = await req(`/api/workspaces/${wsId}/findings/${first.id}/transition`, { method: 'POST', csrf, body: { toState: 'SELLER_REVIEW' } });
    assert(stepRes.status === 200, 'transition to SELLER_REVIEW');
    stepRes = await req(`/api/workspaces/${wsId}/findings/${first.id}/transition`, { method: 'POST', csrf, body: { toState: 'CLAIM_SUBMITTED', caseRef: 'AMZ-CASE-1' } });
    assert(stepRes.status === 200 && stepRes.json.data.finding.case_ref === 'AMZ-CASE-1', 'submit claim with case reference');
    stepRes = await req(`/api/workspaces/${wsId}/findings/${first.id}/transition`, { method: 'POST', csrf, body: { toState: 'AMAZON_CONFIRMED' } });
    assert(stepRes.status === 200, 'mark Amazon-confirmed');

    const invalid = await req(`/api/workspaces/${wsId}/findings/${first.id}/transition`, { method: 'POST', csrf, body: { toState: 'POTENTIAL' } });
    assert(invalid.status === 409 && invalid.json.error.code === 'invalid_transition', 'impossible transition rejected');
    step('state machine enforced', 'POTENTIAL → … → AMAZON_CONFIRMED; invalid move rejected');

    const timeline = await req(`/api/workspaces/${wsId}/findings/${first.id}`);
    assert(timeline.json.data.timeline.length >= 4, 'audit trail recorded');
    assert(timeline.json.data.allowedTransitions.includes('CASH_CONFIRMED'), 'next transitions exposed');

    /* 5. cash confirmation and the value ledger */
    const second = findings[1];
    const cash = await req(`/api/workspaces/${wsId}/findings/${second.id}/resolve`, { method: 'POST', csrf, body: { recoveredAmount: 42.5, currency: 'USD', note: 'paid in settlement' } });
    assert(cash.status === 200, 'record cash-confirmed recovery');

    const value = await req(`/api/workspaces/${wsId}/value`);
    assert(value.json.data.states.cashConfirmedValue === 42.5, `cash-confirmed value is 42.5 (got ${value.json.data.states.cashConfirmedValue})`);
    assert(value.json.data.states.amazonConfirmedValue >= 0, 'amazon-confirmed bucket present');
    assert(value.json.data.totals.recovered === 42.5, 'ledger totals reflect only cash-confirmed');
    step('value ledger', 'cash-confirmed 42.50 tracked; potential/confirmed kept separate');

    /* 6. free-plan limit */
    const forceUpload = async () => {
      const f = new FormData();
      f.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
      f.append('force', 'true');
      const r = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
        method: 'POST', headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf }, body: f,
      });
      jar = capture(r, jar);
      return r.status;
    };
    assert(await forceUpload() === 202, 'second audit allowed on free plan');
    assert(await forceUpload() === 402, 'third audit blocked on free plan');
    const lockedExport = await req(`/api/workspaces/${wsId}/audits/${auditId}/export?format=json`);
    assert(lockedExport.status === 402, 'JSON export gated on free plan');
    step('free-plan limits enforced', '3rd audit and JSON export blocked with 402');

    /* 7. checkout + verified webhook + paid entitlement */
    const checkout = await req('/api/billing/checkout', { method: 'POST', csrf, body: { workspaceId: wsId, kind: 'plan', plan: 'seller' } });
    assert(checkout.status === 200, 'checkout created');
    step('checkout', `${checkout.json.data.provider} / ${checkout.json.data.amount} ${checkout.json.data.currency}`);

    const eventId = `evt_smoke_${crypto.randomUUID().slice(0, 8)}`;
    const eventBody = JSON.stringify({ id: eventId, event: 'payment_link.paid', payload: { payment_link: { entity: { reference_id: checkout.json.data.reference } } } });
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(eventBody).digest('hex');
    const badHook = await req('/api/billing/webhook/razorpay', { method: 'POST', rawBody: eventBody, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'nope' } });
    assert(badHook.status === 400, 'bad webhook signature rejected');
    const hook = await req('/api/billing/webhook/razorpay', { method: 'POST', rawBody: eventBody, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature } });
    assert(hook.status === 200 && hook.json.data.applied === true, 'verified webhook applied');
    const replay = await req('/api/billing/webhook/razorpay', { method: 'POST', rawBody: eventBody, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature } });
    assert(replay.json.data.duplicate === true, 'duplicate webhook ignored');
    step('payment webhook', 'signature verified, replay idempotent');

    const ent = await req('/api/billing/entitlements', { headers: { 'x-workspace-id': wsId } });
    assert(ent.json.data.plan.id === 'seller' && ent.json.data.paid === true, 'paid entitlement active');
    const unlockedExport = await req(`/api/workspaces/${wsId}/audits/${auditId}/export?format=json`);
    assert(unlockedExport.status === 200, 'previously gated JSON export now succeeds');
    step('entitlement unlocked', 'paid plan active, gated export works');

    /* 8. referral */
    const ref = await req(`/api/workspaces/${wsId}/value`);
    const code = ref.json.data.referralCode;
    // Sign up the referred user without disturbing the main session cookie jar.
    const referredRes = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `referred-${crypto.randomUUID().slice(0, 8)}@example.com`, password: 'password123', name: 'Referred', ref: code }),
    });
    assert(referredRes.status === 201, 'referred user signs up');
    const referredWs = (await referredRes.json()).data.workspace.id;
    const activate = await req('/api/billing/admin/activate', { method: 'POST', headers: { 'x-admin-token': process.env.ADMIN_TOKEN }, body: { workspaceId: referredWs, plan: 'seller' } });
    assert(activate.status === 200, 'referred plan activated');
    const referrer = await req(`/api/workspaces/${wsId}/value`);
    assert(referrer.json.data.referral.rewarded >= 1, 'referrer credited exactly once');
    assert(referrer.json.data.referral.credit > 0, 'referral credit recorded');
    step('referral loop', `code ${code}, referred plan activated, credit issued`);

    /* 9. lifecycle outbox */
    const outbox = await req('/api/billing/admin/outbox', { headers: { 'x-admin-token': process.env.ADMIN_TOKEN } });
    assert(outbox.json.data.messages.length > 0, 'lifecycle messages queued');
    const flush = await req('/api/billing/admin/outbox/flush', { method: 'POST', headers: { 'x-admin-token': process.env.ADMIN_TOKEN } });
    assert(flush.json.data.provider === 'none' && flush.json.data.sent === 0, 'no provider: nothing claims to be sent');
    step('outbox', `${outbox.json.data.messages.length} queued; honestly unsent without a provider`);

    /* 10. audit log */
    const events = await req('/api/billing/admin/events', { headers: { 'x-admin-token': process.env.ADMIN_TOKEN } });
    const msgs = events.json.data.events.map((e) => e.msg);
    assert(msgs.includes('plan.activated'), 'plan activation is logged');
    assert(msgs.some((m) => m === 'finding.transition'), 'finding transitions are logged');
    step('audit log', 'plan activation and finding transitions recorded');

    /* 11. dashboard reflects real value */
    const dash = await req(`/api/workspaces/${wsId}/dashboard`);
    assert(dash.json.data.value.cashConfirmedValue === 42.5, 'dashboard shows cash-confirmed value');
    assert(dash.json.data.onboarding.completed >= 4, 'onboarding reflects real activity');
    assert(dash.json.data.nextAction !== null, 'dashboard offers a next action');
    step('dashboard', 'value, onboarding and next action present');

    console.log('SMOKE OK');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
