'use strict';

const { badRequest } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(value, field, { min = 1, max = 200, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${field} is required`);
    return '';
  }
  const s = String(value).trim();
  if (required && s.length < min) throw badRequest(`${field} must be at least ${min} characters`);
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return s;
}

function email(value, field = 'email') {
  const s = str(value, field, { min: 3, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw badRequest(`${field} is not a valid email address`);
  return s;
}

function number(value, field, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

function oneOf(value, field, allowed) {
  const s = String(value);
  if (!allowed.includes(s)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return s;
}

module.exports = { str, email, number, oneOf, EMAIL_RE };
