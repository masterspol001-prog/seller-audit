'use strict';

const { tooMany } = require('./errors');

// Simple in-memory fixed-window limiter. Adequate for a single-instance launch;
// swap for Redis when running multiple instances.
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60 * 1000).unref();

function hit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return { count: bucket.count, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

function limiter({ max, windowMs, keyFn }) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || 'unknown');
    const result = hit(key, max, windowMs);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (result.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
      return next(tooMany());
    }
    return next();
  };
}

module.exports = { limiter, hit, _buckets: buckets };
