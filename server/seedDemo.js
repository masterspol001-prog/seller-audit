'use strict';

const db = require('./db');
const auth = require('./auth');
const logger = require('./lib/logger');
const { config } = require('./config');

const DEMO_EMAIL = 'demo@settleproof.app';
const DEMO_PASSWORD = 'password123';
const DEMO_NAME = 'Demo';
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_WS_ID = '00000000-0000-4000-8000-000000000002';

function seedDemoAccount({ force = false } = {}) {
  if (!force && config.env === 'test') return null;
  const existing = db.getUserByEmail(DEMO_EMAIL);
  if (existing) return existing;

  const { hash, salt } = auth.hashPassword(DEMO_PASSWORD);
  const user = db.createUser({
    id: DEMO_USER_ID,
    email: DEMO_EMAIL,
    name: DEMO_NAME,
    passwordHash: hash,
    passwordSalt: salt,
  });
  db.createWorkspace({ id: DEMO_WS_ID, name: "Demo's workspace", ownerId: user.id });
  logger.info('seeded demo account', { email: DEMO_EMAIL });
  return user;
}

module.exports = { seedDemoAccount, DEMO_EMAIL, DEMO_PASSWORD };
