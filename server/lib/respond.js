'use strict';

const db = require('../db');
const { notFound } = require('./errors');

function ok(res, data, status = 200) {
  res.status(status).json({ ok: true, data });
}

function fail(res, status, code, message, details) {
  res.status(status).json({ ok: false, error: { code, message, details } });
}

function paginate(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

// Resolves :workspaceId (or x-workspace-id header) and asserts membership.
function loadWorkspace({ param = 'workspaceId', header = 'x-workspace-id' } = {}) {
  return (req, res, next) => {
    const wsId = req.params[param] || req.get(header);
    if (!wsId) return next(notFound('Workspace not specified'));
    const membership = db.getMembership(req.user.id, wsId);
    if (!membership) return next(notFound('Workspace not found'));
    req.workspace = db.getWorkspace(wsId);
    req.membership = membership;
    return next();
  };
}

module.exports = { ok, fail, paginate, loadWorkspace };
