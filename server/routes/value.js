'use strict';

const express = require('express');
const db = require('../db');
const plans = require('../plans');
const value = require('../value');
const recovery = require('../recovery');
const { config } = require('../config');
const { ok, paginate, loadWorkspace } = require('../lib/respond');
const { asyncHandler, notFound, badRequest } = require('../lib/errors');
const { str, number } = require('../lib/validation');

const router = express.Router({ mergeParams: true });

/* ---------- value report: the retention artifact ---------- */

router.get('/value', loadWorkspace(), asyncHandler(async (req, res) => {
  const ent = plans.getEntitlements(req.workspace.id);
  const paid = plans.isPaid(ent);
  const report = value.valueReport(req.workspace.id, {
    planPrice: paid ? ent.plan.price : 0,
    planCurrency: paid ? ent.plan.currency : null,
  });
  const referral = db.getOrCreateReferralCode(req.workspace.id);
  const stats = db.referralStats(req.workspace.id);
  return ok(res, {
    ...report,
    plan: ent.plan,
    used: ent.used,
    remaining: ent.remaining,
    reportCredits: ent.reportCredits,
    remainingAudits: ent.remainingAudits,
    referral: { ...stats, creditRate: config.referralCredit },
    referralCode: referral.code,
    stateLabels: recovery.LABELS,
    onboarding: recovery.onboardingStatus(req.workspace.id),
  });
}));

router.get('/value/ledger', loadWorkspace(), asyncHandler(async (req, res) => {
  return ok(res, { entries: db.listLedger(req.workspace.id, 200) });
}));

/* ---------- findings across the workspace, with recovery state ---------- */

router.get('/findings', loadWorkspace(), asyncHandler(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  if (req.query.state && !recovery.isState(req.query.state)) throw badRequest('Unknown recovery state');
  const findings = db.listWorkspaceFindings(req.workspace.id, {
    limit, offset,
    state: req.query.state || undefined,
    severity: req.query.severity || undefined,
  }).map((f) => ({ ...f, nextAction: recovery.nextAction(f) }));
  return ok(res, { findings, limit, offset, stateLabels: recovery.LABELS });
}));

router.get('/findings/:findingId', loadWorkspace(), asyncHandler(async (req, res) => {
  const finding = db.getFindingForWorkspace(req.params.findingId, req.workspace.id);
  if (!finding) throw notFound('Finding not found');
  return ok(res, {
    finding: { ...finding, nextAction: recovery.nextAction(finding) },
    timeline: db.listFindingEvents(finding.id),
    allowedTransitions: recovery.ALLOWED[finding.recovery_state] || [],
    stateLabels: recovery.LABELS,
  });
}));

/* ---------- the state machine, exposed ---------- */

router.post('/findings/:findingId/transition', loadWorkspace(), asyncHandler(async (req, res) => {
  const toState = str(req.body.toState, 'toState', { min: 3, max: 40 });
  if (!recovery.isState(toState)) throw badRequest(`Unknown recovery state "${toState}"`);
  const actor = req.body.actor && recovery.ACTORS.includes(req.body.actor) ? req.body.actor : 'seller';
  const note = req.body.note ? str(req.body.note, 'note', { required: false, max: 500 }) : '';
  const evidenceRef = req.body.evidenceRef ? str(req.body.evidenceRef, 'evidenceRef', { required: false, max: 200 }) : null;
  const caseRef = req.body.caseRef !== undefined ? str(req.body.caseRef, 'caseRef', { required: false, max: 120 }) : undefined;

  const result = recovery.transition({
    workspaceId: req.workspace.id,
    findingId: req.params.findingId,
    toState, actor, note, evidenceRef,
    caseRef,
    source: 'api',
  });
  db.logEvent('info', 'finding.transition', {
    workspaceId: req.workspace.id, findingId: req.params.findingId, toState, actor,
  });
  return ok(res, result);
}));

/* ---------- resolve a finding with a known recovery (legacy shorthand) ---------- */

router.post('/findings/:findingId/resolve', loadWorkspace(), asyncHandler(async (req, res) => {
  const amount = req.body.recoveredAmount === undefined || req.body.recoveredAmount === ''
    ? null
    : number(req.body.recoveredAmount, 'recoveredAmount', { min: 0, max: 1e12 });
  const currency = req.body.currency ? str(req.body.currency, 'currency', { min: 3, max: 3 }).toUpperCase() : null;
  const note = req.body.note ? str(req.body.note, 'note', { required: false, max: 300 }) : '';

  const resolution = value.recordManualResolution({
    workspaceId: req.workspace.id,
    findingId: req.params.findingId,
    recoveredAmount: amount,
    currency,
    note,
  });
  if (!resolution) throw notFound('Finding not found or already resolved');
  return ok(res, { resolution });
}));

module.exports = router;
