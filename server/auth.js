'use strict';

const crypto = require('crypto');
const { config } = require('./config');
const db = require('./db');
const { unauthorized } = require('./lib/errors');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { hash: derived.toString('hex'), salt };
}

function verifyPassword(password, hash, salt) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

const COOKIE = 'sp_session';
const CSRF_COOKIE = 'sp_csrf';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(res, name, value, { maxAgeMs, httpOnly = true, req } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  const proto = String((req && req.get && req.get('x-forwarded-proto')) || '').split(',')[0].trim();
  if (config.isProd || proto === 'https') parts.push('Secure');
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
}

function startSession(res, user, req) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const sid = db.createSession({ userId: user.id, ip: req.ip, userAgent: req.get('user-agent'), csrf });
  setCookie(res, COOKIE, sid, { maxAgeMs: config.sessionTtlMs, req });
  setCookie(res, CSRF_COOKIE, csrf, { maxAgeMs: config.sessionTtlMs, httpOnly: false, req });
  return { sid, csrf };
}

function endSession(req, res) {
  const sid = sessionIdFromRequest(req);
  if (sid) db.deleteSession(sid);
  clearCookie(res, COOKIE);
  clearCookie(res, CSRF_COOKIE);
}

function sessionIdFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE]) return cookies[COOKIE];
  const header = req.get('x-session-token');
  if (header) return header.trim();
  const authz = req.get('authorization') || '';
  if (authz.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim();
  return null;
}

function loadSession(req) {
  const sid = sessionIdFromRequest(req);
  if (!sid) return null;
  const session = db.getSessionRaw(sid);
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    db.deleteSession(sid);
    return null;
  }
  return session;
}

function loadUser(req) {
  const session = loadSession(req);
  if (!session) return null;
  return db.getUserById(session.user_id);
}

function attachUser(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.session = loadSession(req);
  req.user = req.session ? db.getUserById(req.session.user_id) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

// Double-submit CSRF: the value must be present as a readable cookie and in a header.
function requireCsrf(req, res, next) {
  if (!req.user) return next(unauthorized());
  const header = req.get('x-csrf-token');
  const expected = (req.session && req.session.csrf_token) || req.cookies?.[CSRF_COOKIE];
  if (!header || !expected || header !== expected) {
    return next(unauthorized('Invalid or missing CSRF token'));
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  parseCookies, setCookie, clearCookie,
  startSession, endSession, loadUser, loadSession, attachUser, requireAuth, requireCsrf,
  COOKIE, CSRF_COOKIE,
};
