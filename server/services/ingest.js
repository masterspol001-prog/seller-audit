'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const storage = require('../storage');
const { processAudit } = require('./processAudit');
const { badRequest } = require('../lib/errors');
const { currentPeriod, consumeAuditCredit } = require('../plans');

const ALLOWED_EXT = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls']);

function isAllowedFile(name) {
  return ALLOWED_EXT.has(path.extname(String(name || '')).toLowerCase());
}

// Creates an audit record, parks the file in the workspace folder and kicks off
// processing in the background. Returns the audit row so the client can poll.
function ingestAudit({ workspaceId, userId, tmpFilePath, originalName, name, source = 'upload' }) {
  if (!isAllowedFile(originalName)) {
    throw badRequest('Unsupported file type. Upload a .csv, .tsv, .txt or .xlsx file.');
  }
  const ext = path.extname(originalName).toLowerCase();
  const audit = db.createAudit({
    workspaceId,
    userId,
    name: name || originalName,
    source,
    fileName: originalName,
  });
  db.createAuditJob(audit.id, workspaceId);
  const dest = storage.finalPath(workspaceId, audit.id, ext);
  storage.moveFile(tmpFilePath, dest);

  let size = 0;
  try { size = fs.statSync(dest).size; } catch { /* ignore */ }
  const hash = storage.sha256File(dest);

  db.updateAudit(audit.id, { file_name: originalName, file_hash: hash, file_size: size });
  db.incrementUsage(workspaceId, currentPeriod());
  consumeAuditCredit(workspaceId);

  setImmediate(() => {
    processAudit({ auditId: audit.id, workspaceId, filePath: dest, originalName });
  });

  return db.getAudit(audit.id);
}

function findCompletedAuditByHash(workspaceId, hash) {
  return db.get(
    "SELECT * FROM audits WHERE workspace_id = ? AND file_hash = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
    [workspaceId, hash],
  );
}

module.exports = { ingestAudit, isAllowedFile, findCompletedAuditByHash, ALLOWED_EXT };
