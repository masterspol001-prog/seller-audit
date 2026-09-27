'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  PRIMARY KEY (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  marketplace TEXT,
  period_start TEXT,
  period_end TEXT,
  deposit_date TEXT,
  currency TEXT,
  file_name TEXT,
  file_hash TEXT,
  file_size INTEGER,
  encoding TEXT,
  delimiter TEXT,
  row_count INTEGER,
  tx_count INTEGER,
  findings_count INTEGER DEFAULT 0,
  recoverable_total REAL DEFAULT 0,
  summary_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audits_workspace ON audits(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  marketplace TEXT,
  sku TEXT,
  order_id TEXT,
  amount REAL,
  currency TEXT,
  recoverable INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id, severity);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(audit_id, status);
CREATE TABLE IF NOT EXISTS cogs (
  workspace_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit_cost REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, sku)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  msg TEXT NOT NULL,
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'manual',
  provider_ref TEXT,
  current_period_start INTEGER,
  current_period_end INTEGER,
  seats INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_workspace ON payments(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  payment_id TEXT,
  plan TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  customer_name TEXT,
  customer_email TEXT,
  customer_gstin TEXT,
  customer_state TEXT,
  customer_state_code TEXT,
  seller_name TEXT,
  seller_gstin TEXT,
  seller_state TEXT,
  seller_state_code TEXT,
  place_of_supply TEXT,
  currency TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  is_tax_invoice INTEGER NOT NULL DEFAULT 0,
  line_json TEXT,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace ON invoices(workspace_id, issued_at DESC);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_counters (
  workspace_id TEXT NOT NULL,
  period TEXT NOT NULL,
  audits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period)
);
CREATE TABLE IF NOT EXISTS resolutions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL UNIQUE,
  audit_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  recovered_amount REAL,
  currency TEXT,
  detected_source TEXT,
  evidence_json TEXT,
  detected_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resolutions_workspace ON resolutions(workspace_id, detected_at DESC);
CREATE TABLE IF NOT EXISTS value_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entry_date INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  finding_id TEXT,
  audit_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_workspace ON value_ledger(workspace_id, entry_date DESC);
CREATE TABLE IF NOT EXISTS referrals (
  code TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_events (
  id TEXT PRIMARY KEY,
  code TEXT,
  referred_workspace_id TEXT,
  status TEXT NOT NULL,
  credit REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  to_email TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON email_outbox(status, created_at);
CREATE TABLE IF NOT EXISTS finding_events (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT,
  note TEXT,
  evidence_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finding_events_finding ON finding_events(finding_id, created_at);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT,
  reference TEXT,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_jobs (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

db.exec(SCHEMA);

// Additive migrations for databases created by earlier versions. CREATE TABLE IF
// NOT EXISTS will not add new columns to existing tables, so we do it explicitly.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn('findings', 'recovery_state', "TEXT NOT NULL DEFAULT 'POTENTIAL'");
ensureColumn('findings', 'case_ref', 'TEXT');
ensureColumn('findings', 'next_action', 'TEXT');
ensureColumn('findings', 'owner', 'TEXT');
ensureColumn('findings', 'updated_at', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_findings_recovery ON findings(audit_id, recovery_state)');

ensureColumn('email_outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('email_outbox', 'max_attempts', 'INTEGER NOT NULL DEFAULT 5');
ensureColumn('email_outbox', 'next_attempt_at', 'INTEGER');
ensureColumn('email_outbox', 'last_error', 'TEXT');
ensureColumn('email_outbox', 'idempotency_key', 'TEXT');

ensureColumn('referral_events', 'rewarded_at', 'INTEGER');
ensureColumn('referral_events', 'referrer_workspace_id', 'TEXT');
ensureColumn('payments', 'updated_at', 'INTEGER');

ensureColumn('subscriptions', 'cancel_at_period_end', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('subscriptions', 'report_credits', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sessions', 'csrf_token', 'TEXT');

// Billing / GST profile captured on the workspace so invoices can be issued.
ensureColumn('workspaces', 'gstin', 'TEXT');
ensureColumn('workspaces', 'legal_name', 'TEXT');
ensureColumn('workspaces', 'billing_address', 'TEXT');
ensureColumn('workspaces', 'billing_state', 'TEXT');
ensureColumn('workspaces', 'billing_state_code', 'TEXT');
ensureColumn('workspaces', 'spapi_seller_id', 'TEXT');
ensureColumn('workspaces', 'spapi_last_sync_at', 'INTEGER');

// Indexes added after migrations so they can reference migrated columns.
db.exec('CREATE INDEX IF NOT EXISTS idx_audits_workspace_status ON audits(workspace_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at DESC)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idem ON email_outbox(idempotency_key) WHERE idempotency_key IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_finding ON value_ledger(finding_id)');

const now = () => Date.now();
const id = () => crypto.randomUUID();

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/* ---------- users & sessions ---------- */

function createUser({ email, name, passwordHash, passwordSalt }) {
  const userId = id();
  run(
    'INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?,?,?,?,?,?)',
    [userId, email, name || '', passwordHash, passwordSalt, now()],
  );
  return getUserById(userId);
}

function getUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = ?', [email]);
}
function getUserById(userId) {
  return get('SELECT id, email, name, created_at FROM users WHERE id = ?', [userId]);
}

function createSession({ userId, ip, userAgent, csrf }) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const created = now();
  run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent, csrf_token) VALUES (?,?,?,?,?,?,?)',
    [sid, userId, created, created + config.sessionTtlMs, ip || '', userAgent || '', csrf || null],
  );
  return sid;
}
function getSessionRaw(sid) {
  return get('SELECT * FROM sessions WHERE id = ?', [sid]);
}
function deleteSession(sid) {
  run('DELETE FROM sessions WHERE id = ?', [sid]);
}
function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at <= ?', [now()]);
}

/* ---------- workspaces ---------- */

function createWorkspace({ name, ownerId }) {
  return tx(() => {
    const wsId = id();
    run('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?,?,?,?)', [wsId, name, ownerId, now()]);
    run('INSERT INTO memberships (user_id, workspace_id, role) VALUES (?,?,?)', [ownerId, wsId, 'owner']);
    return getWorkspace(wsId);
  });
}

function getWorkspace(wsId) {
  return get('SELECT * FROM workspaces WHERE id = ?', [wsId]);
}

function listWorkspacesForUser(userId) {
  return all(
    `SELECT w.*, m.role FROM workspaces w
     JOIN memberships m ON m.workspace_id = w.id
     WHERE m.user_id = ? ORDER BY w.created_at ASC`,
    [userId],
  );
}

function getMembership(userId, wsId) {
  return get('SELECT * FROM memberships WHERE user_id = ? AND workspace_id = ?', [userId, wsId]);
}

function renameWorkspace(wsId, name) {
  run('UPDATE workspaces SET name = ? WHERE id = ?', [name, wsId]);
}

// Stores the GST / billing identity used on invoices.
function updateWorkspaceBilling(wsId, fields) {
  const allowed = ['gstin', 'legal_name', 'billing_address', 'billing_state', 'billing_state_code'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length) {
    run(`UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => fields[k]), wsId]);
  }
  return getWorkspace(wsId);
}

function setWorkspaceSpapi(wsId, { sellerId, lastSyncAt }) {
  run('UPDATE workspaces SET spapi_seller_id = ?, spapi_last_sync_at = ? WHERE id = ?',
    [sellerId || null, lastSyncAt || null, wsId]);
  return getWorkspace(wsId);
}

/* ---------- audits ---------- */

function createAudit({ workspaceId, userId, name, source = 'upload', fileName = null }) {
  const auditId = id();
  run(
    `INSERT INTO audits (id, workspace_id, user_id, name, status, source, created_at, started_at, file_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [auditId, workspaceId, userId, name, 'processing', source, now(), now(), fileName],
  );
  return getAudit(auditId);
}

function getAudit(auditId) {
  return get('SELECT * FROM audits WHERE id = ?', [auditId]);
}

function getAuditForWorkspace(auditId, workspaceId) {
  return get('SELECT * FROM audits WHERE id = ? AND workspace_id = ?', [auditId, workspaceId]);
}

function listAudits(workspaceId, { limit = 50, offset = 0 } = {}) {
  return all(
    'SELECT * FROM audits WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [workspaceId, limit, offset],
  );
}

function updateAudit(auditId, fields) {
  const allowed = [
    'status', 'completed_at', 'marketplace', 'period_start', 'period_end', 'deposit_date',
    'currency', 'file_name', 'file_hash', 'file_size', 'encoding', 'delimiter', 'row_count',
    'tx_count', 'findings_count', 'recoverable_total', 'summary_json', 'error', 'name',
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE audits SET ${sets} WHERE id = ?`, [...keys.map((k) => fields[k]), auditId]);
}

function deleteAudit(auditId) {
  tx(() => {
    run('DELETE FROM findings WHERE audit_id = ?', [auditId]);
    run('DELETE FROM audits WHERE id = ?', [auditId]);
  });
}

/* ---------- findings ---------- */

// Removes any prior findings (and their timeline events) for an audit so a
// retried background job produces exactly one set of findings.
function clearFindingsForAudit(auditId) {
  tx(() => {
    run('DELETE FROM finding_events WHERE finding_id IN (SELECT id FROM findings WHERE audit_id = ?)', [auditId]);
    run('DELETE FROM findings WHERE audit_id = ?', [auditId]);
  });
}

function insertFindings(auditId, findings) {
  return tx(() => {
    const stmt = db.prepare(
      `INSERT INTO findings (id, audit_id, rule_id, category, severity, confidence, title, detail,
        marketplace, sku, order_id, amount, currency, recoverable, status, recovery_state, evidence_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const ts = now();
    for (const f of findings) {
      stmt.run(
        id(), auditId, f.ruleId, f.category, f.severity, f.confidence, f.title, f.detail,
        f.marketplace || null, f.sku || null, f.orderId || null,
        f.amount ?? null, f.currency || null, f.recoverable ? 1 : 0,
        'open', 'POTENTIAL', JSON.stringify(f.evidence || {}), ts, ts,
      );
    }
  });
}

function listFindings(auditId, { severity, category, status, q } = {}) {
  let sql = 'SELECT * FROM findings WHERE audit_id = ?';
  const params = [auditId];
  if (severity) { sql += ' AND severity = ?'; params.push(severity); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q) {
    sql += ' AND (title LIKE ? OR detail LIKE ? OR sku LIKE ? OR order_id LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, COALESCE(amount,0) DESC";
  return all(sql, params).map(hydrateFinding);
}

function getFindingForAudit(findingId, auditId) {
  const row = get('SELECT * FROM findings WHERE id = ? AND audit_id = ?', [findingId, auditId]);
  return row ? hydrateFinding(row) : null;
}

// Open (unresolved) findings across every audit in a workspace. Used by the
// recovery loop to match a later reimbursement against an earlier finding.
function listOpenFindingsForWorkspace(wsId, { excludeAuditId = null, limit = 2000 } = {}) {
  let sql = `SELECT f.* FROM findings f
             JOIN audits a ON a.id = f.audit_id
             WHERE a.workspace_id = ? AND f.status = 'open' AND f.confidence != 'insufficient'`;
  const params = [wsId];
  if (excludeAuditId) { sql += ' AND f.audit_id != ?'; params.push(excludeAuditId); }
  sql += ' ORDER BY f.created_at DESC LIMIT ?';
  params.push(limit);
  return all(sql, params).map(hydrateFinding);
}

function updateFindingStatus(findingId, auditId, status) {
  run('UPDATE findings SET status = ? WHERE id = ? AND audit_id = ?', [status, findingId, auditId]);
}

function hydrateFinding(row) {
  return { ...row, recoverable: !!row.recoverable, evidence: safeJson(row.evidence_json) };
}

/* ---------- cogs ---------- */

function upsertCogs(workspaceId, entries) {
  return tx(() => {
    const stmt = db.prepare(
      `INSERT INTO cogs (workspace_id, sku, unit_cost, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(workspace_id, sku) DO UPDATE SET unit_cost = excluded.unit_cost, updated_at = excluded.updated_at`,
    );
    let n = 0;
    for (const e of entries) { stmt.run(workspaceId, e.sku, e.unitCost, now()); n += 1; }
    return n;
  });
}

function listCogs(workspaceId) {
  return all('SELECT sku, unit_cost FROM cogs WHERE workspace_id = ?', [workspaceId]);
}

/* ---------- events ---------- */

function logEvent(level, msg, meta) {
  try {
    run('INSERT INTO events (ts, level, msg, meta_json) VALUES (?,?,?,?)', [
      now(), level, msg, meta ? JSON.stringify(meta) : null,
    ]);
  } catch { /* logging must never crash a request */ }
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ---------- subscriptions, usage & payments ---------- */

function getSubscription(wsId) {
  return get('SELECT * FROM subscriptions WHERE workspace_id = ?', [wsId]);
}

function ensureSubscription(wsId, plan = 'free', provider = 'manual') {
  const existing = getSubscription(wsId);
  if (existing) return existing;
  run(
    `INSERT INTO subscriptions (workspace_id, plan, status, provider, current_period_start, current_period_end, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [wsId, plan, 'active', provider, null, null, now(), now()],
  );
  return getSubscription(wsId);
}

function setSubscription(wsId, fields) {
  const allowed = ['plan', 'status', 'provider', 'provider_ref', 'current_period_start', 'current_period_end', 'seats', 'report_credits'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getSubscription(wsId);
  ensureSubscription(wsId);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE subscriptions SET ${sets}, updated_at = ? WHERE workspace_id = ?`,
    [...keys.map((k) => fields[k]), now(), wsId]);
  return getSubscription(wsId);
}

function incrementUsage(wsId, period) {
  run(
    `INSERT INTO usage_counters (workspace_id, period, audits) VALUES (?,?,1)
     ON CONFLICT(workspace_id, period) DO UPDATE SET audits = audits + 1`,
    [wsId, period],
  );
  return getUsage(wsId, period);
}

function getUsage(wsId, period) {
  const row = get('SELECT audits FROM usage_counters WHERE workspace_id = ? AND period = ?', [wsId, period]);
  return row ? row.audits : 0;
}

function insertPayment(p) {
  const pid = id();
  run(
    `INSERT INTO payments (id, workspace_id, provider, provider_ref, amount, currency, kind, status, meta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [pid, p.workspaceId, p.provider, p.providerRef || null, p.amount, p.currency, p.kind, p.status,
      p.meta ? JSON.stringify(p.meta) : null, now()],
  );
  return get('SELECT * FROM payments WHERE id = ?', [pid]);
}

function listPayments(wsId, limit = 50) {
  return all('SELECT * FROM payments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', [wsId, limit]);
}

function markPaymentPaid(providerRef, status = 'paid') {
  run('UPDATE payments SET status = ? WHERE provider_ref = ?', [status, providerRef]);
  return get('SELECT * FROM payments WHERE provider_ref = ? ORDER BY created_at DESC LIMIT 1', [providerRef]);
}

function getPaymentById(paymentId) {
  return get('SELECT * FROM payments WHERE id = ?', [paymentId]);
}

function addReportCredits(wsId, delta) {
  ensureSubscription(wsId);
  run(
    'UPDATE subscriptions SET report_credits = MAX(0, COALESCE(report_credits, 0) + ?), updated_at = ? WHERE workspace_id = ?',
    [delta, now(), wsId],
  );
  return getSubscription(wsId);
}

function getReportCredits(wsId) {
  const row = ensureSubscription(wsId);
  return row && row.report_credits ? row.report_credits : 0;
}

/* ---------- invoices ---------- */

// Atomically increments a named counter and returns the new value.
function nextCounter(name) {
  return tx(() => {
    run('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [name]);
    run('UPDATE counters SET value = value + 1 WHERE name = ?', [name]);
    return get('SELECT value FROM counters WHERE name = ?', [name]).value;
  });
}

function createInvoice(inv) {
  const iid = id();
  run(
    `INSERT INTO invoices (id, number, workspace_id, payment_id, plan, kind, status, customer_name,
       customer_email, customer_gstin, customer_state, customer_state_code, seller_name, seller_gstin,
       seller_state, seller_state_code, place_of_supply, currency, subtotal, tax_rate, cgst, sgst, igst,
       total, is_tax_invoice, line_json, issued_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [iid, inv.number, inv.workspaceId, inv.paymentId || null, inv.plan || null, inv.kind, inv.status || 'issued',
      inv.customerName || null, inv.customerEmail || null, inv.customerGstin || null, inv.customerState || null,
      inv.customerStateCode || null, inv.sellerName || null, inv.sellerGstin || null, inv.sellerState || null,
      inv.sellerStateCode || null, inv.placeOfSupply || null, inv.currency, inv.subtotal, inv.taxRate || 0,
      inv.cgst || 0, inv.sgst || 0, inv.igst || 0, inv.total, inv.isTaxInvoice ? 1 : 0,
      inv.line ? JSON.stringify(inv.line) : null, inv.issuedAt || now(), now()],
  );
  return get('SELECT * FROM invoices WHERE id = ?', [iid]);
}

function listInvoices(wsId, limit = 100) {
  return all('SELECT * FROM invoices WHERE workspace_id = ? ORDER BY issued_at DESC LIMIT ?', [wsId, limit]);
}

function getInvoiceForWorkspace(invoiceId, wsId) {
  return get('SELECT * FROM invoices WHERE id = ? AND workspace_id = ?', [invoiceId, wsId]);
}

function findInvoiceForPayment(paymentId) {
  return get('SELECT * FROM invoices WHERE payment_id = ? ORDER BY created_at DESC LIMIT 1', [paymentId]);
}

/* ---------- value loop: resolutions & ledger ---------- */

function insertResolution(r) {
  const existing = get('SELECT id FROM resolutions WHERE finding_id = ?', [r.findingId]);
  if (existing) return null;
  const rid = id();
  run(
    `INSERT INTO resolutions (id, finding_id, audit_id, workspace_id, kind, recovered_amount, currency,
       detected_source, evidence_json, detected_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [rid, r.findingId, r.auditId, r.workspaceId, r.kind, r.recoveredAmount ?? null, r.currency || null,
      r.detectedSource || null, r.evidence ? JSON.stringify(r.evidence) : null, r.detectedAt || now(), now()],
  );
  return get('SELECT * FROM resolutions WHERE id = ?', [rid]);
}

function listResolutions(wsId, limit = 200) {
  return all('SELECT * FROM resolutions WHERE workspace_id = ? ORDER BY detected_at DESC LIMIT ?', [wsId, limit])
    .map((r) => ({ ...r, evidence: safeJson(r.evidence_json) }));
}

function addLedger(entry) {
  const lid = id();
  run(
    `INSERT INTO value_ledger (id, workspace_id, entry_date, type, amount, currency, finding_id, audit_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [lid, entry.workspaceId, entry.entryDate || now(), entry.type, entry.amount || 0, entry.currency || null,
      entry.findingId || null, entry.auditId || null, entry.note || null, now()],
  );
  return lid;
}

function listLedger(wsId, limit = 200) {
  return all('SELECT * FROM value_ledger WHERE workspace_id = ? ORDER BY entry_date DESC LIMIT ?', [wsId, limit]);
}

function ledgerTotals(wsId) {
  const row = get(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'recovery' THEN amount ELSE 0 END), 0) AS recovered,
       COALESCE(SUM(CASE WHEN type = 'fee_avoided' THEN amount ELSE 0 END), 0) AS feeAvoided,
       COUNT(*) AS entries
     FROM value_ledger WHERE workspace_id = ?`,
    [wsId],
  );
  const currency = get('SELECT currency FROM value_ledger WHERE workspace_id = ? AND currency IS NOT NULL ORDER BY entry_date DESC LIMIT 1', [wsId]);
  return { recovered: round2(row.recovered || 0), feeAvoided: round2(row.feeAvoided || 0), entries: row.entries || 0, currency: currency ? currency.currency : null };
}

function ledgerByMonth(wsId) {
  return all(
    `SELECT strftime('%Y-%m', entry_date / 1000, 'unixepoch') AS period,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS entries
     FROM value_ledger WHERE workspace_id = ?
     GROUP BY period ORDER BY period DESC LIMIT 24`,
    [wsId],
  ).map((r) => ({ ...r, amount: round2(r.amount || 0) }));
}

/* ---------- referrals ---------- */

function getOrCreateReferralCode(wsId) {
  const existing = get('SELECT * FROM referrals WHERE workspace_id = ?', [wsId]);
  if (existing) return existing;
  const code = crypto.randomBytes(5).toString('hex');
  run('INSERT INTO referrals (code, workspace_id, created_at) VALUES (?,?,?)', [code, wsId, now()]);
  return get('SELECT * FROM referrals WHERE code = ?', [code]);
}

function getReferralByCode(code) {
  return get('SELECT * FROM referrals WHERE code = ?', [code]);
}

function recordReferralEvent({ code, referredWorkspaceId, status, credit = 0 }) {
  const rid = id();
  run(
    'INSERT INTO referral_events (id, code, referred_workspace_id, status, credit, created_at) VALUES (?,?,?,?,?,?)',
    [rid, code || null, referredWorkspaceId || null, status, credit, now()],
  );
  return rid;
}

function referralStats(wsId) {
  const code = get('SELECT code FROM referrals WHERE workspace_id = ?', [wsId]);
  if (!code) return { code: null, signedUp: 0, activated: 0, credit: 0 };
  const rows = all('SELECT status, credit FROM referral_events WHERE code = ?', [code.code]);
  return {
    code: code.code,
    signedUp: rows.filter((r) => r.status === 'signed_up').length,
    activated: rows.filter((r) => r.status === 'activated' || r.status === 'rewarded').length,
    rewarded: rows.filter((r) => r.status === 'rewarded').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    credit: round2(rows.reduce((s, r) => s + (r.credit || 0), 0)),
  };
}

/* ---------- email outbox (retention nudges) ---------- */

function enqueueEmail({ workspaceId = null, to, subject, body, kind }) {
  const eid = id();
  run(
    'INSERT INTO email_outbox (id, workspace_id, to_email, subject, body, kind, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [eid, workspaceId, to || null, subject, body, kind, 'queued', now()],
  );
  return eid;
}

function listOutbox({ status = 'queued', limit = 100 } = {}) {
  return all('SELECT * FROM email_outbox WHERE status = ? ORDER BY created_at ASC LIMIT ?', [status, limit]);
}

function markEmail(id_, status, sentAt = now()) {
  run('UPDATE email_outbox SET status = ?, sent_at = ? WHERE id = ?', [status, sentAt, id_]);
}

/* ---------- recovery state machine persistence ---------- */

function getFindingForWorkspace(findingId, wsId) {
  return get(
    `SELECT f.*, a.workspace_id, a.name AS audit_name, a.period_start, a.period_end
       FROM findings f JOIN audits a ON a.id = f.audit_id
      WHERE f.id = ? AND a.workspace_id = ?`,
    [findingId, wsId],
  );
}

function listWorkspaceFindings(wsId, { limit = 100, offset = 0, state, severity, status } = {}) {
  let sql = `SELECT f.*, a.name AS audit_name, a.period_start, a.period_end
               FROM findings f JOIN audits a ON a.id = f.audit_id
              WHERE a.workspace_id = ?`;
  const params = [wsId];
  if (state) { sql += ' AND f.recovery_state = ?'; params.push(state); }
  if (severity) { sql += ' AND f.severity = ?'; params.push(severity); }
  if (status) { sql += ' AND f.status = ?'; params.push(status); }
  sql += ' ORDER BY f.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return all(sql, params).map(hydrateFinding);
}

function updateFindingRecovery(findingId, auditId, fields) {
  const allowed = ['recovery_state', 'case_ref', 'next_action', 'owner', 'status'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getFindingForAudit(findingId, auditId);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE findings SET ${sets}, updated_at = ? WHERE id = ? AND audit_id = ?`,
    [...keys.map((k) => fields[k]), now(), findingId, auditId]);
  return getFindingForAudit(findingId, auditId);
}

function insertFindingEvent(e) {
  const eid = id();
  run(
    `INSERT INTO finding_events (id, finding_id, workspace_id, from_state, to_state, actor, source, note, evidence_ref, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [eid, e.findingId, e.workspaceId, e.fromState || null, e.toState, e.actor, e.source || null,
      e.note || null, e.evidenceRef || null, e.createdAt || now()],
  );
  return get('SELECT * FROM finding_events WHERE id = ?', [eid]);
}

function listFindingEvents(findingId, limit = 100) {
  return all('SELECT * FROM finding_events WHERE finding_id = ? ORDER BY created_at ASC LIMIT ?', [findingId, limit]);
}

function listRecentFindingEvents(wsId, limit = 20) {
  return all(
    `SELECT e.*, f.title, f.severity, f.category
       FROM finding_events e JOIN findings f ON f.id = e.finding_id
      WHERE e.workspace_id = ? ORDER BY e.created_at DESC LIMIT ?`,
    [wsId, limit],
  );
}

function recoveryBuckets(wsId) {
  return all(
    `SELECT f.recovery_state AS state, COUNT(*) AS count, COALESCE(SUM(f.amount), 0) AS amount
       FROM findings f JOIN audits a ON a.id = f.audit_id
      WHERE a.workspace_id = ?
      GROUP BY f.recovery_state`,
    [wsId],
  );
}

function countFindingsForWorkspace(wsId, state) {
  const row = get(
    `SELECT COUNT(*) AS n FROM findings f JOIN audits a ON a.id = f.audit_id
      WHERE a.workspace_id = ? AND f.recovery_state = ?`,
    [wsId, state],
  );
  return row ? row.n : 0;
}

/* ---------- idempotent webhooks ---------- */

function hasWebhookEvent(id_) {
  return !!get('SELECT id FROM webhook_events WHERE id = ?', [id_]);
}

function recordWebhookEvent({ id: eid, provider, eventType, reference }) {
  run('INSERT OR IGNORE INTO webhook_events (id, provider, event_type, reference, received_at) VALUES (?,?,?,?,?)',
    [eid, provider, eventType || null, reference || null, now()]);
}

/* ---------- audit jobs (retryable background work) ---------- */

function createAuditJob(auditId, workspaceId) {
  const jid = id();
  run('INSERT INTO audit_jobs (id, audit_id, workspace_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [jid, auditId, workspaceId, 'queued', now(), now()]);
  return jid;
}

function updateAuditJob(auditId, fields) {
  const allowed = ['status', 'attempts', 'last_error'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  run(`UPDATE audit_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE audit_id = ?`,
    [...keys.map((k) => fields[k]), now(), auditId]);
}

function getAuditJob(auditId) {
  return get('SELECT * FROM audit_jobs WHERE audit_id = ?', [auditId]);
}

function listFailedAuditJobs(limit = 50) {
  return all("SELECT * FROM audit_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?", [limit]);
}

/* ---------- referral audit trail ---------- */

function listReferralEvents(code) {
  return all('SELECT * FROM referral_events WHERE code = ? ORDER BY created_at DESC', [code]);
}

function getReferralEventForWorkspace(referredWorkspaceId) {
  return get('SELECT * FROM referral_events WHERE referred_workspace_id = ? ORDER BY created_at DESC LIMIT 1', [referredWorkspaceId]);
}

function markReferralRewarded(eventId) {
  run("UPDATE referral_events SET status = 'rewarded', rewarded_at = ? WHERE id = ?", [now(), eventId]);
}

/* ---------- email outbox reliability ---------- */

function claimOutboxBatch(limit = 25) {
  const due = all(
    `SELECT * FROM email_outbox
      WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT ?`,
    [now(), limit],
  );
  for (const row of due) {
    run("UPDATE email_outbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?", [row.id]);
  }
  return due;
}

function markEmailSent(id_, sentAt = now()) {
  run("UPDATE email_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", [sentAt, id_]);
}

function markEmailFailed(id_, error, retryDelayMs) {
  const row = get('SELECT attempts, max_attempts FROM email_outbox WHERE id = ?', [id_]);
  const attempts = row ? row.attempts : 1;
  const exhausted = row && attempts >= row.max_attempts;
  if (exhausted) {
    run("UPDATE email_outbox SET status = 'failed', last_error = ?, next_attempt_at = NULL WHERE id = ?", [error || 'unknown', id_]);
  } else {
    run("UPDATE email_outbox SET status = 'queued', last_error = ?, next_attempt_at = ? WHERE id = ?",
      [error || 'unknown', now() + retryDelayMs, id_]);
  }
  return { exhausted: !!exhausted, attempts };
}

module.exports = {
  db, run, get, all, tx, id, now,
  createUser, getUserByEmail, getUserById,
  createSession, getSessionRaw, deleteSession, purgeExpiredSessions,
  createWorkspace, getWorkspace, listWorkspacesForUser, getMembership, renameWorkspace,
  updateWorkspaceBilling, setWorkspaceSpapi,
  createAudit, getAudit, getAuditForWorkspace, listAudits, updateAudit, deleteAudit,
  insertFindings, clearFindingsForAudit, listFindings, getFindingForAudit, listOpenFindingsForWorkspace, updateFindingStatus,
  upsertCogs, listCogs, logEvent, safeJson,
  getSubscription, ensureSubscription, setSubscription, incrementUsage, getUsage,
  insertPayment, listPayments, markPaymentPaid, getPaymentById,
  addReportCredits, getReportCredits,
  nextCounter, createInvoice, listInvoices, getInvoiceForWorkspace, findInvoiceForPayment,
  insertResolution, listResolutions, addLedger, listLedger, ledgerTotals, ledgerByMonth,
  getOrCreateReferralCode, getReferralByCode, recordReferralEvent, referralStats,
  enqueueEmail, listOutbox, markEmail,
  getFindingForWorkspace, listWorkspaceFindings, updateFindingRecovery,
  insertFindingEvent, listFindingEvents, listRecentFindingEvents,
  recoveryBuckets, countFindingsForWorkspace,
  hasWebhookEvent, recordWebhookEvent,
  createAuditJob, updateAuditJob, getAuditJob, listFailedAuditJobs,
  listReferralEvents, getReferralEventForWorkspace, markReferralRewarded,
  claimOutboxBatch, markEmailSent, markEmailFailed,
};
