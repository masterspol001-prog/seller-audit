'use strict';

const db = require('./db');
const auth = require('./auth');
const logger = require('./lib/logger');
const { config } = require('./config');

const DEMO_EMAIL = 'demo@settleproof.app';
const DEMO_PASSWORD = 'password123';
const DEMO_NAME = 'Demo';

function seedDemoAccount({ force = false } = {}) {
  if (!force && config.env === 'test') return null;
  if (db.getUserByEmail(DEMO_EMAIL)) return db.getUserByEmail(DEMO_EMAIL);

  const { hash, salt } = auth.hashPassword(DEMO_PASSWORD);
  const user = db.createUser({
    email: DEMO_EMAIL,
    name: DEMO_NAME,
    passwordHash: hash,
    passwordSalt: salt,
  });
  db.createWorkspace({ name: "Demo's workspace", ownerId: user.id });
  logger.info('seeded demo account', { email: DEMO_EMAIL });
  return user;
}

module.exports = { seedDemoAccount, DEMO_EMAIL, DEMO_PASSWORD };
