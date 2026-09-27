'use strict';

const express = require('express');
const db = require('../db');
const plans = require('../plans');
const recovery = require('../recovery');
const { ok } = require('../lib/respond');
const { asyncHandler, badRequest } = require('../lib/errors');
const { str, number } = require('../lib/validation');
const { loadWorkspace } = require('../lib/respond');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  return ok(res, { workspaces: db.listWorkspacesForUser(req.user.id) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 120 });
  const workspace = db.createWorkspace({ name, ownerId: req.user.id });
  return ok(res, { workspace }, 201);
}));

router.patch('/:workspaceId', loadWorkspace(), asyncHandler(async (req, res) => {
  const name = str(req.body.name, 'name', { min: 1, max: 120 });
  db.renameWorkspace(req.workspace.id, name);
  return ok(res, { workspace: db.getWorkspace(req.workspace.id) });
}));

/* ---------- COGS ---------- */

router.get('/:workspaceId/cogs', loadWorkspace(), asyncHandler(async (req, res) => {
  const rows = db.listCogs(req.workspace.id).map((c) => ({ sku: c.sku, unitCost: c.unit_cost }));
  return ok(res, { cogs: rows });
}));

router.put('/:workspaceId/cogs', loadWorkspace(), asyncHandler(async (req, res) => {
  plans.assertFeature(req.workspace.id, 'cogs');
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!entries.length) throw badRequest('entries must be a non-empty array');
  if (entries.length > 5000) throw badRequest('Too many entries in one request (max 5000)');

  const normalized = entries.map((e, i) => {
    const sku = str(e.sku, `entries[${i}].sku`, { min: 1, max: 80 });
    const unitCost = number(e.unitCost, `entries[${i}].unitCost`, { min: 0, max: 10_000_000 });
    return { sku, unitCost };
  });

  const count = db.upsertCogs(req.workspace.id, normalized);
  return ok(res, { saved: count, cogs: db.listCogs(req.workspace.id).map((c) => ({ sku: c.sku, unitCost: c.unit_cost })) });
}));

/* ---------- dashboard aggregate ---------- */

router.get('/:workspaceId/dashboard', loadWorkspace(), asyncHandler(async (req, res) => {
  const audits = db.listAudits(req.workspace.id, { limit: 200 });
  const completed = audits.filter((a) => a.status === 'completed');
  const sum = (fn) => Math.round(completed.reduce((s, a) => s + (fn(a) || 0), 0) * 100) / 100;

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = {};
  for (const a of completed) {
    const summary = db.safeJson(a.summary_json) || {};
    for (const [k, v] of Object.entries(summary.severityCounts || {})) {
      bySeverity[k] = (bySeverity[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(summary.categoryCounts || {})) {
      byCategory[k] = (byCategory[k] || 0) + v;
    }
  }

  const latest = completed[0] || null;
  const latestSummary = latest ? db.safeJson(latest.summary_json) : null;
  const entitlements = plans.getEntitlements(req.workspace.id);

  // One prioritized next action: highest severity unresolved finding.
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const open = db.listWorkspaceFindings(req.workspace.id, { limit: 200 })
    .filter((f) => !['CLOSED', 'CASH_CONFIRMED', 'REJECTED', 'EXPIRED'].includes(f.recovery_state))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
  const top = open[0] || null;

  return ok(res, {
    audits: audits.slice(0, 10),
    totals: {
      audits: completed.length,
      processing: audits.filter((a) => a.status === 'processing').length,
      failed: audits.filter((a) => a.status === 'failed').length,
      findings: sum((a) => a.findings_count),
      recoverable: sum((a) => a.recoverable_total),
    },
    value: recovery.valueSummary(req.workspace.id),
    onboarding: recovery.onboardingStatus(req.workspace.id),
    recentActivity: db.listRecentFindingEvents(req.workspace.id, 12),
    nextAction: top ? { findingId: top.id, auditId: top.audit_id, title: top.title, severity: top.severity, ...recovery.nextAction(top) } : null,
    bySeverity,
    byCategory,
    latestSummary,
    latestAuditId: latest ? latest.id : null,
    entitlements: {
      plan: entitlements.plan,
      used: entitlements.used,
      remaining: entitlements.remaining,
      remainingAudits: entitlements.remainingAudits,
      unlimited: entitlements.unlimited,
      reportCredits: entitlements.reportCredits,
      paid: plans.isPaid(entitlements),
    },
  });
}));

module.exports = router;
