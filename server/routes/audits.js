'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const db = require('../db');
const storage = require('../storage');
const plans = require('../plans');
const { config } = require('../config');
const { ok, fail, paginate, loadWorkspace } = require('../lib/respond');
const { asyncHandler, badRequest, conflict, notFound } = require('../lib/errors');
const { str, oneOf } = require('../lib/validation');
const { toCsv, sendCsv } = require('../lib/csv');
const { ingestAudit, findCompletedAuditByHash, isAllowedFile } = require('../services/ingest');

const router = express.Router({ mergeParams: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.tmpDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 8)}`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const FINDING_STATUSES = ['open', 'confirmed', 'dismissed', 'resolved'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

function auditView(a, { includeSummary = false } = {}) {
  const view = {
    id: a.id,
    name: a.name,
    status: a.status,
    source: a.source,
    createdAt: a.created_at,
    completedAt: a.completed_at,
    marketplace: a.marketplace,
    periodStart: a.period_start,
    periodEnd: a.period_end,
    depositDate: a.deposit_date,
    currency: a.currency,
    fileName: a.file_name,
    fileSize: a.file_size,
    encoding: a.encoding,
    delimiter: a.delimiter,
    rowCount: a.row_count,
    txCount: a.tx_count,
    findingsCount: a.findings_count,
    recoverableTotal: a.recoverable_total,
    error: a.error || null,
    reportKind: db.safeJson(a.summary_json)?.reportKind || null,
  };
  if (includeSummary) view.summary = db.safeJson(a.summary_json);
  return view;
}

/* ---------- upload ---------- */

router.post('/', loadWorkspace(), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded. Attach the settlement file as the "file" field.');
  if (!isAllowedFile(req.file.originalname)) {
    storage.removeFileQuietly(req.file.path);
    throw badRequest('Unsupported file type. Upload a .csv, .tsv, .txt or .xlsx file.');
  }

  const hash = storage.sha256File(req.file.path);
  const existing = findCompletedAuditByHash(req.workspace.id, hash);
  if (existing && req.body.force !== 'true') {
    storage.removeFileQuietly(req.file.path);
    return res.status(200).json({
      ok: true,
      data: { audit: auditView(existing), duplicate: true },
    });
  }

  const name = req.body.name ? str(req.body.name, 'name', { required: false, max: 160 }) : req.file.originalname;
  try {
    plans.assertCanRunAudit(req.workspace.id);
  } catch (err) {
    storage.removeFileQuietly(req.file.path);
    throw err;
  }
  const audit = ingestAudit({
    workspaceId: req.workspace.id,
    userId: req.user.id,
    tmpFilePath: req.file.path,
    originalName: req.file.originalname,
    name,
  });
  db.logEvent('info', 'audit.uploaded', { auditId: audit.id, workspaceId: req.workspace.id, bytes: req.file.size });
  return res.status(202).json({ ok: true, data: { audit: auditView(audit), duplicate: false } });
}));

/* ---------- list & detail ---------- */

router.get('/', loadWorkspace(), asyncHandler(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  const audits = db.listAudits(req.workspace.id, { limit, offset });
  return ok(res, { audits: audits.map((a) => auditView(a)), limit, offset });
}));

router.get('/:auditId', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  return ok(res, { audit: auditView(audit, { includeSummary: true }) });
}));

router.get('/:auditId/status', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  return ok(res, { id: audit.id, status: audit.status, findingsCount: audit.findings_count, error: audit.error || null });
}));

/* ---------- findings ---------- */

router.get('/:auditId/findings', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  const { severity, category, status, q } = req.query;
  if (severity) oneOf(severity, 'severity', SEVERITIES);
  if (status) oneOf(status, 'status', FINDING_STATUSES);
  const findings = db.listFindings(audit.id, {
    severity: severity || undefined,
    category: category || undefined,
    status: status || undefined,
    q: q ? String(q).slice(0, 120) : undefined,
  });
  return ok(res, { findings, audit: auditView(audit) });
}));

router.patch('/:auditId/findings/:findingId', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  const status = oneOf(req.body.status, 'status', FINDING_STATUSES);
  const finding = db.getFindingForAudit(req.params.findingId, audit.id);
  if (!finding) throw notFound('Finding not found');
  db.updateFindingStatus(finding.id, audit.id, status);
  return ok(res, { finding: { ...finding, status } });
}));

/* ---------- delete ---------- */

router.delete('/:auditId', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  db.deleteAudit(audit.id);
  storage.removeAuditFiles(req.workspace.id, audit.id);
  db.logEvent('info', 'audit.deleted', { auditId: audit.id, workspaceId: req.workspace.id });
  return ok(res, { deleted: true });
}));

/* ---------- exports ---------- */

const FINDING_COLUMNS = [
  { key: 'id', label: 'finding_id' },
  { key: 'rule_id', label: 'rule' },
  { key: 'severity', label: 'severity' },
  { key: 'confidence', label: 'confidence' },
  { key: 'category', label: 'category' },
  { key: 'title', label: 'title' },
  { key: 'sku', label: 'sku' },
  { key: 'order_id', label: 'order_id' },
  { key: 'amount', label: 'amount' },
  { key: 'currency', label: 'currency' },
  { key: 'recoverable', label: 'recoverable' },
  { key: 'status', label: 'status' },
  { key: 'detail', label: 'detail' },
  { key: 'evidence_json', label: 'evidence' },
];

router.get('/:auditId/export', loadWorkspace(), asyncHandler(async (req, res) => {
  const audit = db.getAuditForWorkspace(req.params.auditId, req.workspace.id);
  if (!audit) throw notFound('Audit not found');
  const format = String(req.query.format || 'csv').toLowerCase();
  const base = `settleproof-${audit.id.slice(0, 8)}`;
  const findings = db.listFindings(audit.id, {});

  if (format === 'json') {
    plans.assertExport(req.workspace.id, 'json');
    const payload = {
      generatedAt: new Date().toISOString(),
      audit: auditView(audit),
      summary: db.safeJson(audit.summary_json),
      findings,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.send(JSON.stringify(payload, null, 2));
  }

  if (format === 'settlements') {
    plans.assertExport(req.workspace.id, 'settlements');
    const summary = db.safeJson(audit.summary_json) || {};
    const rows = (summary.settlements || []).map((s) => ({
      settlement_id: s.id,
      period_start: s.start,
      period_end: s.end,
      deposit_date: s.deposit,
      currency: s.currency,
      rows: s.rows,
      net_amount: s.net,
    }));
    const csv = toCsv(rows, [
      { key: 'settlement_id', label: 'settlement_id' },
      { key: 'period_start', label: 'period_start' },
      { key: 'period_end', label: 'period_end' },
      { key: 'deposit_date', label: 'deposit_date' },
      { key: 'currency', label: 'currency' },
      { key: 'rows', label: 'transaction_rows' },
      { key: 'net_amount', label: 'net_amount' },
    ]);
    return sendCsv(res, `${base}-settlements.csv`, csv);
  }

  if (format !== 'csv') return fail(res, 400, 'bad_request', 'format must be csv, json or settlements');
  const csv = toCsv(findings, FINDING_COLUMNS);
  return sendCsv(res, `${base}-findings.csv`, csv);
}));

/* ---------- sample ---------- */

router.post('/demo', loadWorkspace(), asyncHandler(async (req, res) => {
  const sample = path.join(config.root, 'data', 'sample', 'settlement-sample.csv');
  const fs = require('fs');
  if (!fs.existsSync(sample)) throw conflict('Sample file is not bundled in this build');
  plans.assertCanRunAudit(req.workspace.id);
  const tmp = path.join(storage.tmpDir, `${crypto.randomUUID()}.csv`);
  fs.copyFileSync(sample, tmp);
  const audit = ingestAudit({
    workspaceId: req.workspace.id,
    userId: req.user.id,
    tmpFilePath: tmp,
    originalName: 'settlement-sample.csv',
    name: 'Sample settlement audit',
    source: 'demo',
  });
  return res.status(202).json({ ok: true, data: { audit: auditView(audit) } });
}));

module.exports = { router, auditView };
