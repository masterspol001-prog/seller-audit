'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { config } = require('./config');
const logger = require('./lib/logger');
const { attachUser, requireAuth, requireCsrf } = require('./auth');
const { limiter } = require('./lib/rateLimit');
const { AppError } = require('./lib/errors');
const { fail } = require('./lib/respond');

const authRoutes = require('./routes/auth').router;
const workspaceRoutes = require('./routes/workspaces');
const auditsRoutes = require('./routes/audits').router;
const demoRoutes = require('./routes/demo');
const billingRoutes = require('./routes/billing');
const valueRoutes = require('./routes/value');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  // Correlate every request with its logs and error responses.
  app.use((req, res, next) => {
    req.id = String(req.headers['x-request-id'] || crypto.randomUUID());
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // The payment webhook needs the raw body to verify its HMAC signature, so it
  // is parsed before the JSON body parser runs for every other route.
  app.use('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(limiter({ max: config.rateLimit.max, windowMs: config.rateLimit.windowMs }));
  app.use(attachUser);

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, data: { status: 'ok', env: config.env, time: new Date().toISOString() } });
  });

  // CSRF: every state-changing API call must carry the double-submit token,
  // except the unauthenticated entry points and the signed payment webhook and
  // admin routes (which authenticate with a secret header, not an ambient cookie).
  const CSRF_EXEMPT = new Set([
    '/auth/login', '/auth/signup', '/demo', '/billing/webhook/razorpay',
    '/billing/webhook/stripe',
    '/billing/admin/activate', '/billing/admin/cancel',
  ]);
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (CSRF_EXEMPT.has(req.path)) return next();
    // Admin routes authenticate with a secret header, not an ambient cookie, so
    // CSRF does not apply to them.
    if (req.path.startsWith('/billing/admin/')) return next();
    return requireCsrf(req, res, next);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/demo', demoRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/workspaces', requireAuth, workspaceRoutes);
  app.use('/api/workspaces/:workspaceId/audits', requireAuth, auditsRoutes);
  app.use('/api/workspaces/:workspaceId', requireAuth, valueRoutes);

  app.use('/api', (req, res) => fail(res, 404, 'not_found', 'Unknown API route'));

  const publicDir = path.join(config.root, 'public');
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));

  // SPA fallback for non-API GET requests.
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  // 404 for anything that reached here (e.g. non-GET unmatched).
  app.use((req, res) => fail(res, 404, 'not_found', 'Not found'));

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 413, 'payload_too_large', `File is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`);
      }
      return fail(res, 400, 'upload_error', err.message);
    }
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error('request error', { requestId: req.id, code: err.code, message: err.message });
      return fail(res, err.status, err.code, err.message, err.status >= 500 ? { requestId: req.id } : err.details);
    }
    logger.error('unhandled error', { requestId: req.id, error: err && err.stack ? err.stack : String(err) });
    return fail(res, 500, 'internal_error', 'Something went wrong on our side.', { requestId: req.id });
  });

  return app;
}

module.exports = { createApp };
