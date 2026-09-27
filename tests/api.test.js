'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(os.tmpdir(), `sp-api-test-${crypto.randomUUID()}`);
process.env.APP_SECRET = 'test-secret-value-1234567890';
process.env.ALLOW_SIGNUP = 'true';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';

const { createApp } = require('../server/app');
const { SAMPLE } = require('./helpers');

let server;
let base;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

function cookiesFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

async function jreq(pathname, { method = 'GET', body, jar, csrf, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar) headers.Cookie = cookieHeader(jar);
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { res, json, jar: { ...(jar || {}), ...cookiesFrom(res) } };
}

test('health endpoint responds', async () => {
  const { res, json } = await jreq('/api/health');
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
});

test('full API journey: signup, upload, audit, findings, export, cogs, delete', async () => {
  /* --- signup --- */
  const signup = await jreq('/api/auth/signup', {
    method: 'POST',
    body: { email: 'seller@example.com', name: 'Seller One', password: 'password123' },
  });
  assert.equal(signup.res.status, 201);
  assert.equal(signup.json.data.user.email, 'seller@example.com');
  const jar = signup.jar;
  const csrf = signup.json.data.csrf;
  assert.ok(csrf, 'csrf token returned');
  assert.ok(jar.sp_session, 'session cookie set');
  assert.equal(jar.sp_csrf, csrf, 'csrf cookie matches token');
  const wsId = signup.json.data.workspace.id;

  /* --- identity --- */
  const me = await jreq('/api/auth/me', { jar });
  assert.equal(me.json.data.user.email, 'seller@example.com');

  /* --- unauthenticated access is refused --- */
  const unauth = await jreq(`/api/workspaces/${wsId}/audits`);
  assert.equal(unauth.res.status, 401);

  /* --- CSRF protection on mutations --- */
  const noCsrf = await jreq(`/api/workspaces/${wsId}/audits`, { method: 'POST', jar, body: {} });
  assert.equal(noCsrf.res.status, 401);

  /* --- upload the sample settlement --- */
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
  form.append('name', 'Sample journey');
  const uploadRes = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
    method: 'POST',
    headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf },
    body: form,
  });
  assert.equal(uploadRes.status, 202);
  const upload = await uploadRes.json();
  const auditId = upload.data.audit.id;
  assert.equal(upload.data.duplicate, false);

  /* --- wait for processing --- */
  let status;
  for (let i = 0; i < 40; i++) {
    const s = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/status`, { jar });
    status = s.json.data.status;
    if (status === 'completed' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(status, 'completed', 'audit completes');

  /* --- audit detail carries a summary --- */
  const detail = await jreq(`/api/workspaces/${wsId}/audits/${auditId}`, { jar });
  const audit = detail.json.data.audit;
  assert.equal(audit.rowCount, 20);
  assert.equal(audit.currency, 'USD');
  assert.ok(audit.summary.counts.rows === 20);
  assert.equal(audit.summary.recoverableTotal, 0, 'no invented recoverable amounts');

  /* --- findings are traceable --- */
  const findings = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/findings`, { jar });
  assert.ok(findings.json.data.findings.length > 0);
  const first = findings.json.data.findings[0];
  assert.ok(Array.isArray(first.evidence.sourceRows) && first.evidence.sourceRows.length > 0);

  /* --- finding status can be updated --- */
  const patched = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/findings/${first.id}`, {
    method: 'PATCH', jar, csrf, body: { status: 'confirmed' },
  });
  assert.equal(patched.json.data.finding.status, 'confirmed');

  /* --- exports --- */
  const csv = await fetch(`${base}/api/workspaces/${wsId}/audits/${auditId}/export?format=csv`, { headers: { Cookie: cookieHeader(jar) } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /finding_id/);

  const jsonExport = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/export?format=json`, { jar });
  assert.equal(jsonExport.res.status, 402);
  assert.equal(jsonExport.json.error.code, 'payment_required');

  const settlements = await fetch(`${base}/api/workspaces/${wsId}/audits/${auditId}/export?format=settlements`, { headers: { Cookie: cookieHeader(jar) } });
  assert.equal(settlements.status, 402);

  /* --- duplicate detection --- */
  const form2 = new FormData();
  form2.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
  const dupRes = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
    method: 'POST',
    headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf },
    body: form2,
  });
  const dup = await dupRes.json();
  assert.equal(dup.data.duplicate, true);
  assert.equal(dup.data.audit.id, auditId);

  /* --- product costs are a paid feature --- */
  const lockedCogs = await jreq(`/api/workspaces/${wsId}/cogs`, {
    method: 'PUT', jar, csrf, body: { entries: [{ sku: 'SKU-RED', unitCost: 6.5 }] },
  });
  assert.equal(lockedCogs.res.status, 402);
  assert.equal(lockedCogs.json.error.details.feature, 'cogs');

  /* --- plan catalog is public --- */
  const catalog = await jreq('/api/billing/catalog');
  assert.equal(catalog.res.status, 200);
  assert.equal(catalog.json.data.plans.length, 3);
  assert.equal(catalog.json.data.reportPrice.amount, 10);
  assert.equal(catalog.json.data.reportPrice.currency, 'USD');
  assert.equal(catalog.json.data.plans.find((p) => p.id === 'seller').price, 10);

  /* --- free entitlements --- */
  const freeEnt = await jreq('/api/billing/entitlements', { jar, headers: { 'x-workspace-id': wsId } });
  assert.equal(freeEnt.json.data.plan.id, 'free');
  assert.equal(freeEnt.json.data.used, 1);
  assert.equal(freeEnt.json.data.remaining, 1);

  /* --- checkout records an intent (manual provider in tests) --- */
  const checkout = await jreq('/api/billing/checkout', { method: 'POST', jar, csrf, body: { workspaceId: wsId, kind: 'plan', plan: 'seller' } });
  assert.equal(checkout.res.status, 200);
  assert.equal(checkout.json.data.provider, 'manual');
  assert.equal(checkout.json.data.amount, 10);
  assert.equal(checkout.json.data.currency, 'USD');
  assert.equal(checkout.json.data.simulate, true);

  const reportCheckout = await jreq('/api/billing/checkout', { method: 'POST', jar, csrf, body: { workspaceId: wsId, kind: 'report' } });
  assert.equal(reportCheckout.res.status, 200);
  assert.equal(reportCheckout.json.data.amount, 10);
  const confirmed = await jreq('/api/billing/confirm', {
    method: 'POST', jar, csrf, body: { workspaceId: wsId, paymentId: reportCheckout.json.data.paymentId },
  });
  assert.equal(confirmed.res.status, 200);
  assert.equal(confirmed.json.data.applied, true);
  assert.equal(confirmed.json.data.entitlements.reportCredits, 1);

  /* --- admin activation unlocks paid features --- */
  const noToken = await jreq('/api/billing/admin/activate', { method: 'POST', body: { workspaceId: wsId, plan: 'seller' } });
  assert.equal(noToken.res.status, 403);
  const activated = await jreq('/api/billing/admin/activate', {
    method: 'POST', body: { workspaceId: wsId, plan: 'seller' }, headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(activated.res.status, 200);
  assert.equal(activated.json.data.subscription.plan, 'seller');

  const paidEnt = await jreq('/api/billing/entitlements', { jar, headers: { 'x-workspace-id': wsId } });
  assert.equal(paidEnt.json.data.plan.id, 'seller');
  assert.equal(paidEnt.json.data.paid, true);
  assert.equal(paidEnt.json.data.unlimited, true);

  /* --- paid exports now succeed --- */
  const jsonExport2 = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/export?format=json`, { jar });
  assert.equal(jsonExport2.res.status, 200);
  assert.equal(jsonExport2.json.findings.length, findings.json.data.findings.length);

  const settlements2 = await fetch(`${base}/api/workspaces/${wsId}/audits/${auditId}/export?format=settlements`, { headers: { Cookie: cookieHeader(jar) } });
  assert.equal(settlements2.status, 200);
  assert.match(await settlements2.text(), /net_amount/);

  /* --- product costs now work --- */
  const cogs = await jreq(`/api/workspaces/${wsId}/cogs`, {
    method: 'PUT', jar, csrf, body: { entries: [{ sku: 'SKU-RED', unitCost: 6.5 }, { sku: 'SKU-MUG', unitCost: 4 }] },
  });
  assert.equal(cogs.json.data.saved, 2);
  const cogsList = await jreq(`/api/workspaces/${wsId}/cogs`, { jar });
  assert.equal(cogsList.json.data.cogs.length, 2);

  /* --- retention outbox received the upgrade nudge --- */
  const outbox = await jreq('/api/billing/admin/outbox', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.equal(outbox.res.status, 200);
  assert.ok(outbox.json.data.messages.some((m) => m.kind === 'upgrade'));

  /* --- value report proves the loop --- */
  const value = await jreq(`/api/workspaces/${wsId}/value`, { jar });
  assert.equal(value.res.status, 200);
  assert.equal(value.json.data.plan.id, 'seller');
  assert.ok(value.json.data.referralCode);

  /* --- dashboard --- */
  const dash = await jreq(`/api/workspaces/${wsId}/dashboard`, { jar });
  assert.equal(dash.json.data.totals.audits, 1);
  assert.ok(dash.json.data.totals.findings > 0);

  /* --- validation --- */
  const badcogs = await jreq(`/api/workspaces/${wsId}/cogs`, { method: 'PUT', jar, csrf, body: { entries: [] } });
  assert.equal(badcogs.res.status, 400);

  /* --- delete --- */
  const del = await jreq(`/api/workspaces/${wsId}/audits/${auditId}`, { method: 'DELETE', jar, csrf });
  assert.equal(del.json.data.deleted, true);
  const after = await jreq(`/api/workspaces/${wsId}/audits/${auditId}`, { jar });
  assert.equal(after.res.status, 404);

  /* --- logout --- */
  const out = await jreq('/api/auth/logout', { method: 'POST', jar, csrf });
  assert.equal(out.json.data.loggedOut, true);
  const meAfter = await jreq('/api/auth/me', { jar: out.jar });
  assert.equal(meAfter.json.data.user, null);
});

test('seeded demo account can sign in', async () => {
  const { seedDemoAccount, DEMO_EMAIL, DEMO_PASSWORD } = require('../server/seedDemo');
  seedDemoAccount({ force: true });
  const bad = await jreq('/api/auth/login', { method: 'POST', body: { email: DEMO_EMAIL, password: 'wrong-pass' } });
  assert.equal(bad.res.status, 401);
  const good = await jreq('/api/auth/login', { method: 'POST', body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  assert.equal(good.res.status, 200);
  assert.equal(good.json.data.user.email, DEMO_EMAIL);
});

test('login rejects a wrong password', async () => {
  await jreq('/api/auth/signup', { method: 'POST', body: { email: 'login@example.com', password: 'password123' } });
  const bad = await jreq('/api/auth/login', { method: 'POST', body: { email: 'login@example.com', password: 'nope-nope-1' } });
  assert.equal(bad.res.status, 401);
  const good = await jreq('/api/auth/login', { method: 'POST', body: { email: 'login@example.com', password: 'password123' } });
  assert.equal(good.res.status, 200);
  assert.ok(good.json.data.csrf);
  assert.ok(good.json.data.sessionToken);
});

test('session header works when cookies are blocked', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const signup = await jreq('/api/auth/signup', {
    method: 'POST', body: { email: `header-${suffix}@example.com`, password: 'password123' },
  });
  assert.equal(signup.res.status, 201);
  const token = signup.json.data.sessionToken;
  const csrf = signup.json.data.csrf;
  assert.ok(token);

  const me = await jreq('/api/auth/me', { headers: { 'x-session-token': token } });
  assert.equal(me.res.status, 200);
  assert.equal(me.json.data.user.email, `header-${suffix}@example.com`);
  assert.equal(me.json.data.csrf, csrf);

  const wsId = signup.json.data.workspace.id;
  const renamed = await jreq(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    csrf,
    body: { name: 'Cookie-less workspace' },
    headers: { 'x-session-token': token },
  });
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.json.data.workspace.name, 'Cookie-less workspace');
});

test('a $10 report credit unlocks the next audit after the free quota', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const signup = await jreq('/api/auth/signup', {
    method: 'POST', body: { email: `credits-${suffix}@example.com`, password: 'password123' },
  });
  const jar = signup.jar;
  const csrf = signup.json.data.csrf;
  const wsId = signup.json.data.workspace.id;

  async function upload(force) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
    if (force) form.append('force', 'true');
    const res = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
      method: 'POST', headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf }, body: form,
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  assert.equal((await upload(false)).status, 202);
  assert.equal((await upload(true)).status, 202);
  assert.equal((await upload(true)).status, 402);

  const buy = await jreq('/api/billing/checkout', { method: 'POST', jar, csrf, body: { workspaceId: wsId, kind: 'report' } });
  const paid = await jreq('/api/billing/confirm', {
    method: 'POST', jar, csrf, body: { workspaceId: wsId, paymentId: buy.json.data.paymentId },
  });
  assert.equal(paid.json.data.entitlements.reportCredits, 1);
  assert.equal((await upload(true)).status, 202);

  const ent = await jreq('/api/billing/entitlements', { jar, headers: { 'x-workspace-id': wsId } });
  assert.equal(ent.json.data.reportCredits, 0);
  assert.equal((await upload(true)).status, 402);
});

test('the public demo creates a working account with sample data', async () => {
  const demo = await jreq('/api/demo', { method: 'POST' });
  assert.equal(demo.res.status, 201);
  assert.equal(demo.json.data.demo, true);
  const jar = demo.jar;
  const wsId = demo.json.data.workspace.id;
  const auditId = demo.json.data.auditId;
  let status;
  for (let i = 0; i < 40; i++) {
    const s = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/status`, { jar });
    status = s.json.data.status;
    if (status === 'completed' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(status, 'completed');
});

test('a referral is credited when the referred workspace activates a paid plan', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const referrer = await jreq('/api/auth/signup', {
    method: 'POST', body: { email: `referrer-${suffix}@example.com`, password: 'password123', name: 'Referrer' },
  });
  assert.equal(referrer.res.status, 201);
  const refWs = referrer.json.data.workspace.id;

  const codeRes = await jreq(`/api/workspaces/${refWs}/value`, { jar: referrer.jar });
  const code = codeRes.json.data.referralCode;
  assert.ok(code);

  const referred = await jreq('/api/auth/signup', {
    method: 'POST',
    body: { email: `referred-${suffix}@example.com`, password: 'password123', name: 'Referred', ref: code },
  });
  assert.equal(referred.res.status, 201);
  const referredWs = referred.json.data.workspace.id;

  const notYet = await jreq(`/api/workspaces/${refWs}/value`, { jar: referrer.jar });
  assert.equal(notYet.json.data.referral.signedUp, 1);
  assert.equal(notYet.json.data.referral.activated, 0);

  const activate = await jreq('/api/billing/admin/activate', {
    method: 'POST', body: { workspaceId: referredWs, plan: 'seller' }, headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(activate.res.status, 200);

  const after = await jreq(`/api/workspaces/${refWs}/value`, { jar: referrer.jar });
  assert.equal(after.json.data.referral.activated, 1);
  assert.ok(after.json.data.referral.credit > 0);
});

test('the recovery state machine is exposed over HTTP and tenant-scoped', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const signup = await jreq('/api/auth/signup', { method: 'POST', body: { email: `fsm-${suffix}@example.com`, password: 'password123' } });
  const csrf = signup.json.data.csrf;
  const jar = signup.jar;
  const wsId = signup.json.data.workspace.id;

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(SAMPLE)]), 'settlement-sample.csv');
  const up = await fetch(`${base}/api/workspaces/${wsId}/audits`, {
    method: 'POST', headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf }, body: form,
  });
  const auditId = (await up.json()).data.audit.id;
  let status;
  for (let i = 0; i < 40; i++) {
    const s = await jreq(`/api/workspaces/${wsId}/audits/${auditId}/status`, { jar });
    status = s.json.data.status;
    if (status === 'completed' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(status, 'completed');

  const findings = await jreq(`/api/workspaces/${wsId}/findings`, { jar });
  const finding = findings.json.data.findings[0];
  assert.equal(finding.recovery_state, 'POTENTIAL');
  assert.ok(finding.nextAction.action);

  const moved = await jreq(`/api/workspaces/${wsId}/findings/${finding.id}/transition`, {
    method: 'POST', jar, csrf, body: { toState: 'EVIDENCE_READY' },
  });
  assert.equal(moved.res.status, 200);
  assert.equal(moved.json.data.finding.recovery_state, 'EVIDENCE_READY');

  const bad = await jreq(`/api/workspaces/${wsId}/findings/${finding.id}/transition`, {
    method: 'POST', jar, csrf, body: { toState: 'NOT_A_STATE' },
  });
  assert.equal(bad.res.status, 400);

  const detail = await jreq(`/api/workspaces/${wsId}/findings/${finding.id}`, { jar });
  assert.equal(detail.json.data.timeline.length, 1);
  assert.ok(detail.json.data.allowedTransitions.includes('SELLER_REVIEW'));

  // Another user cannot transition this finding.
  const other = await jreq('/api/auth/signup', { method: 'POST', body: { email: `other-${suffix}@example.com`, password: 'password123' } });
  const idor = await jreq(`/api/workspaces/${other.json.data.workspace.id}/findings/${finding.id}/transition`, {
    method: 'POST', jar: other.jar, csrf: other.json.data.csrf, body: { toState: 'SELLER_REVIEW' },
  });
  assert.equal(idor.res.status, 404);

  const dash = await jreq(`/api/workspaces/${wsId}/dashboard`, { jar });
  assert.ok(dash.json.data.value);
  assert.ok(dash.json.data.onboarding);
  assert.ok(dash.json.data.nextAction);
});

test('a signed Razorpay webhook activates the plan and an unsigned one is rejected', async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const signup = await jreq('/api/auth/signup', {
    method: 'POST', body: { email: `hook-${suffix}@example.com`, password: 'password123' },
  });
  const wsId = signup.json.data.workspace.id;
  const csrf = signup.json.data.csrf;
  const jar = signup.jar;

  const checkout = await jreq('/api/billing/checkout', {
    method: 'POST', jar, csrf, body: { workspaceId: wsId, kind: 'plan', plan: 'accountant' },
  });
  assert.equal(checkout.res.status, 200);
  const reference = checkout.json.data.reference;

  const event = JSON.stringify({
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { reference_id: reference } } },
  });
  const signature = crypto.createHmac('sha256', 'test-webhook-secret').update(event).digest('hex');

  const bad = await fetch(`${base}/api/billing/webhook/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body: event,
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${base}/api/billing/webhook/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature }, body: event,
  });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.data.applied, true);

  const ent = await jreq('/api/billing/entitlements', { jar, headers: { 'x-workspace-id': wsId } });
  assert.equal(ent.json.data.plan.id, 'accountant');
  assert.equal(ent.json.data.paid, true);
});


