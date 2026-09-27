'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
const payloadTooLarge = (message = 'Upload too large') => new AppError(413, 'payload_too_large', message);
const conflict = (message) => new AppError(409, 'conflict', message);
const paymentRequired = (message = 'Upgrade required', details) => new AppError(402, 'payment_required', message, details);
const tooMany = (message = 'Too many requests') => new AppError(429, 'rate_limited', message);

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  payloadTooLarge,
  conflict,
  paymentRequired,
  tooMany,
  asyncHandler,
};
