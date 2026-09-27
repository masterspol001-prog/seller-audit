'use strict';

const { config, validate } = require('./config');
const logger = require('./lib/logger');
const db = require('./db');
const storage = require('./storage');
const retention = require('./retention');
const billing = require('./billing');
const { retryFailedAuditJobs } = require('./services/auditJobs');
const { runLifecycleSweep } = require('./services/lifecycle');
const { createApp } = require('./app');
const { seedDemoAccount } = require('./seedDemo');

const problems = validate();
if (problems.length) {
  for (const p of problems) logger.warn('config', { problem: p });
}

db.purgeExpiredSessions();

const removed = storage.cleanupExpiredUploads();
if (removed) logger.info('retention cleanup', { filesRemoved: removed, retentionDays: config.retentionDays });

// Pick up any audit that crashed mid-processing on a previous run.
try {
  const retriedAtBoot = retryFailedAuditJobs();
  if (retriedAtBoot) logger.info('audit jobs retried at boot', { count: retriedAtBoot });
} catch (err) { logger.error('boot audit retry failed', { error: String(err) }); }

// Daily retention sweep: expire uploads and sessions, lapse overdue plans, and
// try to drain the retention outbox (a no-op until an email provider is wired).
setInterval(() => {
  try {
    storage.cleanupExpiredUploads();
db.purgeExpiredSessions();
seedDemoAccount();
    const expired = billing.expireSubscriptions();
    if (expired) logger.info('subscriptions expired', { count: expired });
    const retried = retryFailedAuditJobs();
    if (retried) logger.info('audit jobs retried', { count: retried });
    const lifecycle = runLifecycleSweep();
    logger.info('lifecycle sweep', lifecycle);
    retention.flushOutbox();
  } catch (err) { logger.error('retention sweep failed', { error: String(err) }); }
}, 24 * 3600 * 1000).unref();

const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('settleproof listening', { port: config.port, env: config.env });
  console.log(`SettleProof running on http://localhost:${config.port} (env: ${config.env})`);
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
