'use strict';

const express = require('express');
const db = require('../db');
const plans = require('../plans');
const billing = require('../billing');
const retention = require('../retention');
const { config } = require('../config');
const { ok, fail } = require('../lib/respond');
const { asyncHandler, badRequest, notFound, forbidden } = require('../lib/errors');
const { str, oneOf } = require('../lib/validation');
const { requireAuth } = require('../auth');

const router = express.Router({ mergeParams: true });

function workspaceFromHeader(req) {
  const wsId = req.get('x-workspace-id') || (req.body && req.body.workspaceId);
  if (!wsId) throw badRequest('x-workspace-id header is required');
  if (!db.getMembership(req.user.id, wsId)) throw notFound('Workspace not found');
  return wsId;
}

/* ---------- public catalog ---------- */

router.get('/catalog', asyncHandler(async (req, res) => {
  return ok(res, { ...plans.planCatalog(), provider: billing.provider() });
}));

/* ---------- entitlements ---------- */

router.get('/entitlements', requireAuth, asyncHandler(async (req, res) => {
  const wsId = workspaceFromHeader(req);
  const ent = plans.getEntitlements(wsId);
  return ok(res, {
    plan: ent.plan,
    subscription: ent.subscription,
    period: ent.period,
    used: ent.used,
    remaining: ent.remaining,
    remainingAudits: ent.remainingAudits,
    unlimited: ent.unlimited,
    paid: plans.isPaid(ent),
    reportCredits: ent.reportCredits,
    reportPrice: plans.REPORT_PRICE,
    provider: billing.provider(),
  });
}));

/* ---------- checkout ---------- */

router.post('/checkout', requireAuth, asyncHandler(async (req, res) => {
  const wsId = workspaceFromHeader(req);
  const kind = oneOf(req.body.kind || 'plan', 'kind', ['plan', 'report']);
  const plan = req.body.plan ? oneOf(req.body.plan, 'plan', plans.PLAN_ORDER) : 'seller';
  if (kind === 'plan' && plan === 'free') throw badRequest('The free plan does not require checkout');
  const checkout = await billing.createCheckout({ workspaceId: wsId, kind, plan });
  return ok(res, checkout);
}));

// Non-production only: complete a manual checkout so the funnel can be tested
// end-to-end without a payment gateway. Never available in production.
router.post('/confirm', requireAuth, asyncHandler(async (req, res) => {
  if (config.env === 'production') throw forbidden('Manual confirmation is disabled in production');
  const wsId = workspaceFromHeader(req);
  const paymentId = str(req.body.paymentId, 'paymentId', { min: 1, max: 64 });
  const payment = db.getPaymentById(paymentId);
  if (!payment || payment.workspace_id !== wsId) throw notFound('Payment not found');
  if (payment.provider !== 'manual') throw forbidden('Only manual payments can be confirmed here');
  const result = billing.fulfillPayment(payment);
  const ent = plans.getEntitlements(wsId);
  return ok(res, { ...result, entitlements: { plan: ent.plan.id, reportCredits: ent.reportCredits, remaining: ent.remaining, unlimited: ent.unlimited } });
}));

/* ---------- Razorpay webhook (raw body, signature verified) ---------- */

router.post('/webhook/razorpay', asyncHandler(async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!billing.verifyWebhook(raw, signature)) {
    return fail(res, 400, 'bad_signature', 'Invalid webhook signature');
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'bad_request', 'Invalid JSON payload'); }
  const result = billing.handleRazorpayEvent(event);
  return ok(res, result);
}));

router.post('/webhook/stripe', asyncHandler(async (req, res) => {
  const signature = req.get('stripe-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!billing.verifyStripeWebhook(raw, signature)) {
    return fail(res, 400, 'bad_signature', 'Invalid webhook signature');
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return fail(res, 400, 'bad_request', 'Invalid JSON payload'); }
  const result = billing.handleStripeEvent(event);
  return ok(res, result);
}));

/* ---------- admin operations (token protected) ---------- */

function requireAdmin(req, res, next) {
  if (!config.adminToken) return next(forbidden('Admin token is not configured on this server'));
  const token = req.get('x-admin-token');
  if (!token || token !== config.adminToken) return next(forbidden('Invalid admin token'));
  return next();
}

router.post('/admin/activate', requireAdmin, asyncHandler(async (req, res) => {
  const workspaceId = str(req.body.workspaceId, 'workspaceId', { min: 1, max: 64 });
  const plan = oneOf(req.body.plan, 'plan', ['seller', 'accountant']);
  const subscription = billing.activatePlan({ workspaceId, plan, provider: 'manual' });
  return ok(res, { subscription });
}));

router.post('/admin/cancel', requireAdmin, asyncHandler(async (req, res) => {
  const workspaceId = str(req.body.workspaceId, 'workspaceId', { min: 1, max: 64 });
  return ok(res, { subscription: billing.cancelPlan({ workspaceId }) });
}));

router.get('/admin/outbox', requireAdmin, asyncHandler(async (req, res) => {
  const status = req.query.status ? oneOf(req.query.status, 'status', ['queued', 'processing', 'sent', 'failed']) : 'queued';
  return ok(res, { messages: db.listOutbox({ status, limit: 100 }) });
}));

// Marks a queued message as sent after it has been delivered out of band.
// Used to keep the outbox truthful when email is handled manually.
router.post('/admin/outbox/:id/send', requireAdmin, asyncHandler(async (req, res) => {
  const message = retention.markEmailSentByAdmin(req.params.id);
  if (!message) throw notFound('Message not found');
  return ok(res, { message });
}));

// Runs a flush attempt and reports honestly what happened.
router.post('/admin/outbox/flush', requireAdmin, asyncHandler(async (req, res) => {
  return ok(res, retention.flushOutbox());
}));

// Recent audit trail of plan/payment/referral events.
router.get('/admin/events', requireAdmin, asyncHandler(async (req, res) => {
  const rows = db.all(
    "SELECT * FROM events WHERE msg LIKE 'plan.%' OR msg LIKE 'finding.%' OR msg LIKE 'user.%' ORDER BY ts DESC LIMIT 100",
  );
  return ok(res, { events: rows.map((e) => ({ ...e, meta: db.safeJson(e.meta_json) })) });
}));

module.exports = router;
