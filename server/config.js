'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrCreateSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(file)) {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 16) return s;
  }
  // Stable fallback so serverless/Vercel cold starts can still verify login tokens.
  const fallback = 'settleproof-dev-secret-change-me-32ch';
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return fallback;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  isProd: env === 'production',
  root: ROOT,
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'settleproof.db'),
  port: Math.floor(num(process.env.PORT, 3000)),
  appSecret: loadOrCreateSecret(),
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 24 * 14) * 3600 * 1000,
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: process.env.TRUST_PROXY !== 'false',
  rateLimit: {
    windowMs: num(process.env.RATE_WINDOW_MS, 60 * 1000),
    max: num(process.env.RATE_MAX, 120),
    authMax: num(process.env.RATE_AUTH_MAX, 20),
  },
  // Billing. Without Razorpay keys the app runs in manual-invoice mode.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || null,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  // Optional Razorpay subscription plan ids. When set, plan checkout creates a
  // recurring subscription (UPI Autopay / card) instead of a one-off link.
  razorpayPlanIds: {
    seller: process.env.RAZORPAY_PLAN_ID_SELLER || null,
    accountant: process.env.RAZORPAY_PLAN_ID_ACCOUNTANT || null,
  },
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  // Seller identity for GST invoices. Invoices are only issued as tax invoices
  // when these are configured; otherwise they are clearly labelled receipts.
  gst: {
    legalName: process.env.SELLER_LEGAL_NAME || null,
    gstin: process.env.SELLER_GSTIN || null,
    addressLine: process.env.SELLER_ADDRESS || null,
    city: process.env.SELLER_CITY || null,
    state: process.env.SELLER_STATE || null,
    stateCode: process.env.SELLER_STATE_CODE || null,
    pincode: process.env.SELLER_PINCODE || null,
    sacCode: process.env.SELLER_SAC_CODE || '998314',
    defaultRatePercent: num(process.env.GST_RATE_PERCENT, 18),
    invoicePrefix: process.env.INVOICE_PREFIX || 'SP',
  },
  // Amazon Selling Partner API (SP-API). All four are required to connect.
  spapi: {
    lwaClientId: process.env.SPAPI_LWA_CLIENT_ID || null,
    lwaClientSecret: process.env.SPAPI_LWA_CLIENT_SECRET || null,
    refreshToken: process.env.SPAPI_REFRESH_TOKEN || null,
    region: process.env.SPAPI_REGION || 'eu',
    marketplaceId: process.env.SPAPI_MARKETPLACE_ID || null,
  },
  adminToken: process.env.ADMIN_TOKEN || null,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${Math.floor(num(process.env.PORT, 3000))}`,
  referralCredit: num(process.env.REFERRAL_CREDIT, 500),
};

fs.mkdirSync(config.uploadDir, { recursive: true });

function validate() {
  const problems = [];
  if (!['development', 'test', 'production'].includes(config.env)) {
    problems.push(`NODE_ENV must be development|test|production (got "${config.env}")`);
  }
  if (config.isProd && !process.env.APP_SECRET) {
    problems.push('APP_SECRET should be set in production so sessions survive restarts');
  }
  if (config.isProd && config.allowSignup === false && !process.env.ALLOW_SIGNUP) {
    problems.push('ALLOW_SIGNUP is inconsistent');
  }
  if (config.maxUploadBytes < 1024) problems.push('MAX_UPLOAD_BYTES is too small');
  if (config.retentionDays < 1) problems.push('RETENTION_DAYS must be >= 1');
  if (config.isProd && !config.adminToken) {
    problems.push('ADMIN_TOKEN should be set in production so paid plans can be activated manually');
  }
  if (config.isProd && !config.publicBaseUrl.startsWith('https://')) {
    problems.push('PUBLIC_BASE_URL should be an https URL in production (used for payment callbacks)');
  }
  if (config.razorpayKeyId && !config.razorpayKeySecret) {
    problems.push('RAZORPAY_KEY_SECRET is required when RAZORPAY_KEY_ID is set');
  }
  if (config.razorpayKeyId && !config.razorpayWebhookSecret) {
    problems.push('RAZORPAY_WEBHOOK_SECRET is required so payment webhooks can be verified');
  }
  if (config.stripeSecretKey && !config.stripeWebhookSecret) {
    problems.push('STRIPE_WEBHOOK_SECRET is required so Stripe webhooks can be verified');
  }
  const sp = config.spapi;
  const spSet = [sp.lwaClientId, sp.lwaClientSecret, sp.refreshToken, sp.marketplaceId];
  if (spSet.some(Boolean) && !spSet.every(Boolean)) {
    problems.push('SP-API is partially configured: set SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN and SPAPI_MARKETPLACE_ID together');
  }
  if (config.isProd && config.gst.gstin && !config.gst.stateCode) {
    problems.push('SELLER_STATE_CODE is required with SELLER_GSTIN so GST invoices split CGST/SGST vs IGST correctly');
  }
  return problems;
}

module.exports = { config, validate };
