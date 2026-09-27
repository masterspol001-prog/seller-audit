'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const tmpDir = path.join(config.uploadDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

function workspaceDir(workspaceId) {
  const dir = path.join(config.uploadDir, workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function finalPath(workspaceId, auditId, ext) {
  const safeExt = /^\.[a-z0-9]{1,6}$/i.test(ext || '') ? ext.toLowerCase() : '.dat';
  return path.join(workspaceDir(workspaceId), `${auditId}${safeExt}`);
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw err;
    }
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read;
    do {
      read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read > 0) hash.update(buf.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function removeFileQuietly(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function removeAuditFiles(workspaceId, auditId) {
  const dir = path.join(config.uploadDir, workspaceId);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(`${auditId}.`)) removeFileQuietly(path.join(dir, name));
  }
}

function cleanupExpiredUploads() {
  const cutoff = Date.now() - config.retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) { fs.unlinkSync(full); removed += 1; }
      } catch { /* ignore */ }
    }
  };
  walk(config.uploadDir);
  return removed;
}

module.exports = {
  tmpDir, workspaceDir, finalPath, moveFile, sha256File,
  removeFileQuietly, removeAuditFiles, cleanupExpiredUploads,
};
