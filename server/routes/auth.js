'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { config } = require('../config');
const { ok, fail } = require('../lib/respond');
const { asyncHandler, badRequest, unauthorized } = require('../lib/errors');
const { str, email: vEmail } = require('../lib/validation');
const { limiter } = require('../lib/rateLimit');

const router = express.Router();

const authLimiter = limiter({
  max: config.rateLimit.authMax,
  windowMs: config.rateLimit.windowMs,
  keyFn: (req) => `auth:${req.ip}`,
});

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.created_at };
}

router.post('/signup', authLimiter, asyncHandler(async (req, res) => {
  if (!config.allowSignup) return fail(res, 403, 'signup_disabled', 'Sign-ups are currently closed.');
  const email = vEmail(req.body.email);
  const name = str(req.body.name, 'name', { required: false, max: 120 });
  const password = str(req.body.password, 'password', { min: 8, max: 200 });

  if (db.getUserByEmail(email)) throw badRequest('An account with that email already exists');

  const { hash, salt } = auth.hashPassword(password);
  const user = db.createUser({ email, name, passwordHash: hash, passwordSalt: salt });
  const workspace = db.createWorkspace({ name: name ? `${name}'s workspace` : 'My workspace', ownerId: user.id });

  // Credit the referrer later, when this workspace activates a paid plan.
  const refCode = req.body.ref ? str(req.body.ref, 'ref', { required: false, max: 40 }) : null;
  if (refCode) {
    const referral = db.getReferralByCode(refCode);
    if (referral) {
      db.recordReferralEvent({ code: referral.code, referredWorkspaceId: workspace.id, status: 'signed_up' });
    }
  }

  const session = auth.startSession(res, user, req);
  db.logEvent('info', 'user.signup', { userId: user.id });
  return ok(res, { user: publicUser(user), workspace, csrf: session.csrf, sessionToken: session.sid }, 201);
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const email = vEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.getUserByEmail(email);
  if (!user || !auth.verifyPassword(password, user.password_hash, user.password_salt)) {
    db.logEvent('warn', 'user.login.failed', { email });
    throw unauthorized('Incorrect email or password');
  }
  const session = auth.startSession(res, user, req);
  const workspaces = db.listWorkspacesForUser(user.id);
  db.logEvent('info', 'user.login', { userId: user.id });
  return ok(res, { user: publicUser(user), workspaces, csrf: session.csrf, sessionToken: session.sid });
}));

router.post('/logout', auth.requireCsrf, asyncHandler(async (req, res) => {
  auth.endSession(req, res);
  return ok(res, { loggedOut: true });
}));

router.get('/me', asyncHandler(async (req, res) => {
  if (!req.user) return ok(res, { user: null });
  const workspaces = db.listWorkspacesForUser(req.user.id);
  const csrf = (req.session && req.session.csrf_token) || req.cookies?.[auth.CSRF_COOKIE] || null;
  return ok(res, { user: publicUser(req.user), workspaces, csrf });
}));

module.exports = { router, publicUser };
