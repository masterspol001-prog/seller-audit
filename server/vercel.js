'use strict';

if (!process.env.DATA_DIR) process.env.DATA_DIR = '/tmp/settleproof-data';
if (!process.env.TRUST_PROXY) process.env.TRUST_PROXY = 'true';

const { createApp } = require('./app');
const { seedDemoAccount } = require('./seedDemo');

const app = createApp();
seedDemoAccount();

module.exports = app;
