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

function signSession({ userId, csrf, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({ u: userId, c: csrf, e: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.appSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function unsignSession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.appSecret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.u || !data.e || data.e <= Date.now()) return null;
    return { user_id: data.u, csrf_token: data.c || null, expires_at: data.e };
  } catch {
    return null;
  }
}

function setCookie(res, name, value, { maxAgeMs, httpOnly = true, req } = {}) {
  const proto = String((req && req.get && req.get('x-forwarded-proto')) || '').split(',')[0].trim();
  const https = config.isProd || proto === 'https';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', https ? 'SameSite=None' : 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (https) parts.push('Secure');
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
}

function startSession(res, user, req) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  let sid;
  try {
    sid = db.createSession({ userId: user.id, ip: req.ip, userAgent: req.get('user-agent'), csrf });
  } catch {
    sid = null;
  }
  const expiresAt = Date.now() + config.sessionTtlMs;
  const token = signSession({ userId: user.id, csrf, expiresAt });
  setCookie(res, COOKIE, token, { maxAgeMs: config.sessionTtlMs, req });
  setCookie(res, CSRF_COOKIE, csrf, { maxAgeMs: config.sessionTtlMs, httpOnly: false, req });
  return { sid: token, csrf, dbSid: sid };
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
  try {
    const session = db.getSessionRaw(sid);
    if (session) {
      if (session.expires_at <= Date.now()) {
        db.deleteSession(sid);
        return null;
      }
      return session;
    }
  } catch { /* sqlite may be empty on a fresh serverless instance */ }
  return unsignSession(sid);
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
