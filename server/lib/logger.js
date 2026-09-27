'use strict';

const { config } = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, msg, meta) {
  if (LEVELS[level] > threshold) return;
  const line = { ts: new Date().toISOString(), level, msg };
  if (meta !== undefined) line.meta = sanitize(meta);
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

function sanitize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

module.exports = {
  error: (msg, meta) => write('error', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
};
