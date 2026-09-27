'use strict';

const db = require('./db');
const { paymentRequired } = require('./lib/errors');

// Pricing is USD for a global $10 seller offer. Amounts are major units (dollars).
const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    price: 0,
    currency: 'USD',
    interval: null,
    auditsPerMonth: 2,
    retentionDays: 14,
    cogs: false,
    profitability: false,
    exports: ['csv'],
    workspaces: 1,
    seats: 1,
    support: 'community',
  },
  seller: {
    id: 'seller',
    label: 'Seller',
    price: 10,
    currency: 'USD',
    interval: 'month',
    auditsPerMonth: null, // unlimited
    retentionDays: 365,
    cogs: true,
    profitability: true,
    exports: ['csv', 'json', 'settlements'],
    workspaces: 1,
    seats: 2,
    support: 'priority',
  },
  accountant: {
    id: 'accountant',
    label: 'Accountant',
    price: 29,
    currency: 'USD',
    interval: 'month',
    auditsPerMonth: null,
    retentionDays: 730,
    cogs: true,
    profitability: true,
    exports: ['csv', 'json', 'settlements'],
    workspaces: 10,
    seats: 10,
    support: 'priority',
  },
};

// One-off audit price, used when a seller wants to pay per report.
const REPORT_PRICE = { amount: 10, currency: 'USD' };

const PLAN_ORDER = ['free', 'seller', 'accountant'];

function currentPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function planFor(planId) {
  return PLANS[planId] || PLANS.free;
}

// Resolves a workspace's effective plan, subscription row and usage this month.
function getEntitlements(wsId) {
  db.ensureSubscription(wsId, 'free');
  const subscription = db.getSubscription(wsId);
  const plan = planFor(subscription.plan);
  const period = currentPeriod();
  const used = db.getUsage(wsId, period);
  const limit = plan.auditsPerMonth;
  const reportCredits = subscription.report_credits || 0;
  const remainingPlan = limit === null ? null : Math.max(0, limit - used);
  return {
    plan,
    subscription,
    period,
    used,
    limit,
    remaining: remainingPlan,
    remainingAudits: remainingPlan === null ? null : remainingPlan + reportCredits,
    unlimited: limit === null,
    reportCredits,
  };
}

function isPaid(entitlements) {
  return entitlements.plan.id !== 'free' && entitlements.subscription.status === 'active';
}

// Spends a prepaid report credit only when the monthly quota is already exhausted.
function consumeAuditCredit(wsId) {
  const ent = getEntitlements(wsId);
  if (ent.unlimited) return ent;
  if (ent.used > ent.limit && ent.reportCredits > 0) {
    db.addReportCredits(wsId, -1);
    return getEntitlements(wsId);
  }
  return ent;
}

// Throws 402 with an upgrade hint when the workspace is out of audits this month.
function assertCanRunAudit(wsId) {
  const ent = getEntitlements(wsId);
  if (ent.unlimited) return ent;
  if (ent.used < ent.limit) return ent;
  if (ent.reportCredits > 0) return ent;
  throw paymentRequired(
    `Your ${ent.plan.label} plan includes ${ent.limit} audits per month and you have used all of them. Pay $10 for one more report, or $10/month for unlimited.`,
    {
      reason: 'audit_limit_reached',
      plan: ent.plan.id,
      used: ent.used,
      limit: ent.limit,
      upgradeTo: 'seller',
      price: PLANS.seller.price,
      currency: PLANS.seller.currency,
      reportPrice: REPORT_PRICE.amount,
    },
  );
}

function assertFeature(wsId, feature, message) {
  const ent = getEntitlements(wsId);
  if (!ent.plan[feature]) {
    throw paymentRequired(message || `That feature is not included in your ${ent.plan.label} plan.`, {
      reason: 'feature_locked',
      feature,
      plan: ent.plan.id,
      upgradeTo: feature === 'cogs' || feature === 'profitability' ? 'seller' : 'seller',
    });
  }
  return ent;
}

function assertExport(wsId, format) {
  const ent = getEntitlements(wsId);
  if (!ent.plan.exports.includes(format)) {
    throw paymentRequired(`The "${format}" export is available on paid plans.`, {
      reason: 'export_locked', format, plan: ent.plan.id, upgradeTo: 'seller',
    });
  }
  return ent;
}

function planCatalog() {
  return {
    plans: PLAN_ORDER.map((id) => PLANS[id]),
    reportPrice: REPORT_PRICE,
  };
}

module.exports = {
  PLANS, PLAN_ORDER, REPORT_PRICE,
  planFor, getEntitlements, isPaid, currentPeriod,
  consumeAuditCredit, assertCanRunAudit, assertFeature, assertExport, planCatalog,
};
