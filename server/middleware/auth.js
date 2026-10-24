// server/middleware/auth.js — Authentication and RBAC middleware
'use strict';

const { User } = require('../models');
const { getJwtConfig } = require('../config/env');
const { verifyToken } = require('../utils/authUtils');

/**
 * Require valid Bearer JWT.
 * Verifies signature, expiry, and algorithm (HS256).
 * Loads current user and role dynamically from database on every protected request.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    });
  }

  let jwtConfig;
  try {
    jwtConfig = getJwtConfig();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Authentication service configuration error.',
      code: 'AUTH_CONFIG_ERROR',
    });
  }

  let decoded;
  try {
    decoded = verifyToken(token, jwtConfig);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired.',
        code: 'TOKEN_EXPIRED',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token.',
      code: 'TOKEN_INVALID',
    });
  }

  if (!decoded || !decoded.id) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token payload.',
      code: 'TOKEN_PAYLOAD_INVALID',
    });
  }

  try {
    // Fresh lookup from DB on every protected request ensures updated roles and immediate revocation of deleted users
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User account no longer exists.',
        code: 'USER_NOT_FOUND',
      });
    }

    req.user = user;
    next();
  } catch (dbErr) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * Require admin role. Must be preceded by requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required.',
      code: 'FORBIDDEN',
    });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
};
