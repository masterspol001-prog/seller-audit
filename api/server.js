'use strict';

if (!process.env.DATA_DIR) process.env.DATA_DIR = '/tmp/settleproof-data';
if (!process.env.TRUST_PROXY) process.env.TRUST_PROXY = 'true';

const { createApp } = require('../server/app');
const { seedDemoAccount } = require('../server/seedDemo');

const app = createApp();
try {
  seedDemoAccount();
} catch (err) {
  console.error('demo seed failed', err && err.message);
}

module.exports = app;
