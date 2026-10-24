// server/middleware/rateLimiter.js — In-memory auth rate limiting
'use strict';

/**
 * Factory for in-memory sliding-window rate limiters.
 *
 * @param {Object} options
 * @param {number} [options.windowMs=900000] Time window in ms (default: 15 min)
 * @param {number} [options.max=30] Maximum allowed requests per window
 * @param {string} [options.message='Too many authentication attempts, please try again later.']
 * @returns {Function} Express middleware
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max || 30;
  const message = options.message || 'Too many authentication attempts, please try again later.';

  const clients = new Map();

  const middleware = function (req, res, next) {
    // In test environment, skip unless explicitly enabled via enableInTest option
    if (process.env.NODE_ENV === 'test' && !options.enableInTest) {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const now = Date.now();

    let client = clients.get(ip);
    if (!client || now - client.windowStart > windowMs) {
      client = { windowStart: now, count: 1 };
      clients.set(ip, client);
    } else {
      client.count += 1;
    }

    if (client.count > max) {
      res.setHeader('Retry-After', Math.ceil((client.windowStart + windowMs - now) / 1000));
      return res.status(429).json({
        success: false,
        message,
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    next();
  };

  middleware.reset = function () {
    clients.clear();
  };

  return middleware;
}

// Default auth limiter (30 attempts per 15 minutes)
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many authentication attempts, please try again later.',
});

module.exports = {
  createRateLimiter,
  authLimiter,
};
