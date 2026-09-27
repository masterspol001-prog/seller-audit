'use strict';

// Billing with two modes.
//
//  - razorpay: when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set we create real
//    payment links over the REST API and verify webhooks with the webhook secret.
//  - manual:   otherwise we record an intent and hand the operator a payment
//    link to send by hand. This lets the product take its first customers before
//    the gateway is wired, without pretending a charge happened.
//
// No SDK is used; Razorpay's REST endpoints are called directly with fetch.

const crypto = require('crypto');
const { config } = require('./config');
const db = require('./db');
const retention = require('./retention');
const invoices = require('./invoices');
const { PLANS, REPORT_PRICE, planFor } = require('./plans');
const { AppError } = require('./lib/errors');

function provider() {
  if (config.stripeSecretKey) return 'stripe';
  if (config.razorpayKeyId && config.razorpayKeySecret) return 'razorpay';
  return 'manual';
}

function applyPaidPayment({ workspaceId, kind, plan, provider: prov, providerRef }) {
  const existing = db.get('SELECT * FROM payments WHERE provider_ref = ? ORDER BY created_at DESC LIMIT 1', [providerRef]);
  if (existing && existing.status === 'paid') {
    return { kind, duplicate: true };
  }
  db.markPaymentPaid(providerRef, 'paid');
  if (kind === 'plan' && plan) {
    return { subscription: activatePlan({ workspaceId, plan, provider: prov, providerRef }), kind: 'plan' };
  }
  if (kind === 'report') {
    const sub = db.addReportCredits(workspaceId, 1);
    db.logEvent('info', 'plan.report_credit', { workspaceId, provider: prov, providerRef });
    return { subscription: sub, kind: 'report', reportCredits: sub.report_credits };
  }
  return { kind };
}

function referenceFor(workspaceId, kind, plan) {
  const nonce = crypto.randomBytes(4).toString('hex');
  return kind === 'report'
    ? `sp:${workspaceId}:report:${nonce}`
    : `sp:${workspaceId}:plan:${plan}:${nonce}`;
}

function parseReference(ref) {
  const parts = String(ref || '').split(':');
  if (parts[0] !== 'sp' || parts.length < 3) return null;
  const workspaceId = parts[1];
  const kind = parts[2];
  if (kind === 'report') return { workspaceId, kind, plan: null };
  if (kind === 'plan') return { workspaceId, kind, plan: parts[3] || null };
  return null;
}

// Creates a checkout for a plan upgrade or a one-off report purchase.
async function createCheckout({ workspaceId, kind = 'plan', plan = 'seller' }) {
  if (kind === 'plan' && !PLANS[plan]) throw new AppError(400, 'bad_request', `Unknown plan "${plan}"`);
  const amount = kind === 'report' ? REPORT_PRICE.amount : PLANS[plan].price;
  const currency = kind === 'report' ? REPORT_PRICE.currency : PLANS[plan].currency;
  const reference = referenceFor(workspaceId, kind, plan);
  const description = kind === 'report' ? 'SettleProof single settlement audit' : `SettleProof ${PLANS[plan].label} plan (monthly)`;

  const payment = db.insertPayment({
    workspaceId, provider: provider(), providerRef: reference, amount, currency, kind, status: 'created',
    meta: { plan: kind === 'plan' ? plan : null },
  });

  if (provider() === 'manual') {
    return {
      provider: 'manual',
      paymentId: payment.id,
      reference,
      amount,
      currency,
      simulate: config.env !== 'production',
      instructions: `Send ${amount} ${currency} with note "${reference}". `
        + `In production an admin marks it paid. This app never charges a card itself.`,
    };
  }

  if (provider() === 'stripe') {
    const params = new URLSearchParams({
      mode: 'payment',
      success_url: `${config.publicBaseUrl}/#/app/plans?status=success`,
      cancel_url: `${config.publicBaseUrl}/#/app/plans?status=cancel`,
      client_reference_id: reference,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': String(currency).toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
      'line_items[0][price_data][product_data][name]': description,
      'metadata[workspace_id]': workspaceId,
      'metadata[kind]': kind,
      'metadata[plan]': kind === 'plan' ? plan : '',
      'metadata[reference]': reference,
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError(502, 'gateway_error', `Payment gateway rejected the request (${res.status}).`, { detail: text.slice(0, 300) });
    }
    const session = await res.json();
    db.run('UPDATE payments SET provider_ref = ? WHERE id = ?', [reference, payment.id]);
    return { provider: 'stripe', paymentId: payment.id, reference, url: session.url, amount, currency };
  }

  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency,
      description,
      reference_id: reference,
      callback_url: `${config.publicBaseUrl}/#/app/plans?status=success`,
      callback_method: 'get',
      notes: { workspace_id: workspaceId, kind, plan: kind === 'plan' ? plan : '' },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(502, 'gateway_error', `Payment gateway rejected the request (${res.status}).`, { detail: text.slice(0, 300) });
  }
  const link = await res.json();
  db.run('UPDATE payments SET provider_ref = ? WHERE id = ?', [link.reference_id || reference, payment.id]);
  return { provider: 'razorpay', paymentId: payment.id, reference: link.reference_id || reference, url: link.short_url, amount, currency };
}

function periodEnd(days = 30) {
  return Date.now() + days * 24 * 3600 * 1000;
}

// Activates a paid plan. Idempotent per plan activation.
function activatePlan({ workspaceId, plan, provider: prov = 'manual', providerRef = null, days = 30 }) {
  if (!PLANS[plan]) throw new AppError(400, 'bad_request', `Unknown plan "${plan}"`);
  const before = db.getSubscription(workspaceId);
  const sub = db.setSubscription(workspaceId, {
    plan,
    status: 'active',
    provider: prov,
    provider_ref: providerRef,
    current_period_start: Date.now(),
    current_period_end: periodEnd(days),
  });
  if (!before || before.plan !== plan) {
    retention.onUpgrade({ workspaceId, planLabel: planFor(plan).label });
    db.logEvent('info', 'plan.activated', { workspaceId, from: before ? before.plan : 'free', to: plan, provider: prov });
  }
  activateReferral(workspaceId);
  return sub;
}

function cancelPlan({ workspaceId }) {
  const before = db.getSubscription(workspaceId);
  const sub = db.setSubscription(workspaceId, { plan: 'free', status: 'active', provider_ref: null, current_period_end: null });
  db.logEvent('info', 'plan.cancelled', { workspaceId, from: before ? before.plan : null, to: 'free' });
  return sub;
}

// Downgrades any paid plan whose period has lapsed. Razorpay autopay renewals
// also refresh current_period_end via webhook, so this only catches misses.
function expireSubscriptions(now = Date.now()) {
  const rows = db.all(
    "SELECT * FROM subscriptions WHERE plan != 'free' AND current_period_end IS NOT NULL AND current_period_end < ?",
    [now],
  );
  for (const row of rows) {
    db.setSubscription(row.workspace_id, { plan: 'free', status: 'active', provider_ref: null, current_period_end: null });
  }
  return rows.length;
}

// If this workspace arrived through a referral code, credit the referrer once.
// Fraud guard: the referrer and the referred workspace must have different owners.
function activateReferral(referredWorkspaceId) {
  const ev = db.getReferralEventForWorkspace(referredWorkspaceId);
  if (!ev || ev.status === 'rewarded' || ev.status === 'activated') return 0;
  const referral = db.getReferralByCode(ev.code);
  if (!referral) return 0;
  const referredWs = db.getWorkspace(referredWorkspaceId);
  const referrerWs = db.getWorkspace(referral.workspace_id);
  if (!referredWs || !referrerWs || referredWs.owner_id === referrerWs.owner_id) {
    db.run("UPDATE referral_events SET status = 'rejected' WHERE id = ?", [ev.id]);
    return 0;
  }
  db.run(
    "UPDATE referral_events SET status = 'rewarded', credit = ?, referrer_workspace_id = ?, rewarded_at = ? WHERE id = ?",
    [config.referralCredit, referral.workspace_id, Date.now(), ev.id],
  );
  try {
    retention.onReferralActivated({
      referrerWorkspaceId: referral.workspace_id,
      credit: config.referralCredit,
    });
  } catch { /* notifications must never break activation */ }
  return 1;
}

function verifyWebhook(rawBody, signature) {
  if (!config.razorpayWebhookSecret) return false;
  const expected = crypto.createHmac('sha256', config.razorpayWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyStripeWebhook(rawBody, header) {
  if (!config.stripeWebhookSecret) return false;
  const items = {};
  for (const part of String(header || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx > 0) items[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  if (!items.t || !items.v1) return false;
  const expected = crypto.createHmac('sha256', config.stripeWebhookSecret)
    .update(`${items.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(items.v1);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function handleStripeEvent(event) {
  const eventId = event && event.id;
  if (eventId && db.hasWebhookEvent(eventId)) {
    return { applied: false, duplicate: true, reason: 'already processed' };
  }
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  const ref = (obj && (obj.client_reference_id || (obj.metadata && obj.metadata.reference))) || null;
  const parsed = parseReference(ref);
  if (!parsed) {
    if (eventId) db.recordWebhookEvent({ id: eventId, provider: 'stripe', eventType: type, reference: ref });
    return { applied: false, reason: 'no reference' };
  }
  let result = { applied: false, reason: `unhandled event ${type}` };
  if (type === 'checkout.session.completed' || type === 'payment_intent.succeeded') {
    applyPaidPayment({
      workspaceId: parsed.workspaceId,
      kind: parsed.kind,
      plan: parsed.plan,
      provider: 'stripe',
      providerRef: ref,
    });
    result = { applied: true, kind: parsed.kind, plan: parsed.plan, workspaceId: parsed.workspaceId };
  }
  if (eventId) db.recordWebhookEvent({ id: eventId, provider: 'stripe', eventType: type, reference: ref });
  return result;
}

function fulfillPayment(payment) {
  if (!payment) throw new AppError(404, 'not_found', 'Payment not found');
  if (payment.status === 'paid') {
    return { applied: false, duplicate: true, payment };
  }
  const parsed = parseReference(payment.provider_ref);
  if (!parsed) throw new AppError(400, 'bad_request', 'Payment has no valid reference');
  const meta = typeof payment.meta_json === 'string' ? db.safeJson(payment.meta_json) : (payment.meta || null);
  const result = applyPaidPayment({
    workspaceId: parsed.workspaceId,
    kind: parsed.kind,
    plan: parsed.plan || (meta && meta.plan) || null,
    provider: payment.provider || provider(),
    providerRef: payment.provider_ref,
  });
  return { applied: true, ...result, payment: db.getPaymentById(payment.id) };
}

// Applies a verified Razorpay event. Returns a small result for logging.
// Idempotent: a repeated event id is ignored, so retries never double-activate.
function handleRazorpayEvent(event) {
  const eventId = event && (event.id || event.event_id);
  if (eventId && db.hasWebhookEvent(eventId)) {
    return { applied: false, duplicate: true, reason: 'already processed' };
  }
  const type = event && event.event;
  const paymentEntity = event?.payload?.payment?.entity;
  const linkEntity = event?.payload?.payment_link?.entity;
  const subEntity = event?.payload?.subscription?.entity;

  const ref = linkEntity?.reference_id || paymentEntity?.notes?.reference_id || subEntity?.notes?.reference_id || paymentEntity?.order_id;
  const parsed = parseReference(ref);
  if (!parsed) return { applied: false, reason: 'no reference' };

  let result = { applied: false, reason: `unhandled event ${type}` };
  if (['payment_link.paid', 'payment.captured', 'invoice.paid', 'subscription.charged', 'subscription.activated'].includes(type)) {
    applyPaidPayment({
      workspaceId: parsed.workspaceId,
      kind: parsed.kind,
      plan: parsed.plan,
      provider: 'razorpay',
      providerRef: ref,
    });
    result = { applied: true, kind: parsed.kind, plan: parsed.plan, workspaceId: parsed.workspaceId };
  } else if (['payment.failed', 'subscription.halted', 'subscription.cancelled'].includes(type)) {
    db.markPaymentPaid(ref, type === 'payment.failed' ? 'failed' : 'canceled');
    result = { applied: true, status: type };
  }

  if (eventId) db.recordWebhookEvent({ id: eventId, provider: 'razorpay', eventType: type, reference: ref });
  return result;
}

module.exports = {
  provider, createCheckout, activatePlan, cancelPlan, expireSubscriptions,
  verifyWebhook, handleRazorpayEvent, parseReference, referenceFor, activateReferral,
  applyPaidPayment, fulfillPayment, verifyStripeWebhook, handleStripeEvent,
};
