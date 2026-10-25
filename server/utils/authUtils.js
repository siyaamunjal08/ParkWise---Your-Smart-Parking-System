// server/utils/authUtils.js — Authentication utilities, hashing & token helpers
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Documented cost factor: 10 salt rounds provides ~100ms calculation per hash on standard hardware,
// balancing strong brute-force resistance against event loop latency.
const BCRYPT_SALT_ROUNDS = 10;

// Password constraints
const MIN_PASSWORD_LENGTH = 8;
// Bcrypt algorithm truncates input after 72 bytes. Input exceeding 72 UTF-8 bytes must be rejected
// rather than silently truncated to prevent password ambiguity attacks.
const MAX_PASSWORD_BYTES = 72;

/**
 * Validate password length and byte length.
 * @param {string} password
 * @throws {Error} if invalid
 */
function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
    err.statusCode = 400;
    throw err;
  }

  const byteLength = Buffer.byteLength(password, 'utf8');
  if (byteLength > MAX_PASSWORD_BYTES) {
    const err = new Error(`Password must not exceed ${MAX_PASSWORD_BYTES} bytes (current: ${byteLength} bytes)`);
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Asynchronously hash a password using bcrypt.
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
async function hashPassword(plaintext) {
  validatePasswordStrength(plaintext);
  return bcrypt.hash(plaintext, BCRYPT_SALT_ROUNDS);
}

/**
 * Asynchronously compare plaintext against stored bcrypt hash.
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function comparePassword(plaintext, hash) {
  if (!plaintext || !hash || typeof plaintext !== 'string' || typeof hash !== 'string') {
    return false;
  }
  // Enforce byte check on login as well to avoid passing oversized payloads to bcrypt
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    return false;
  }
  return bcrypt.compare(plaintext, hash);
}

/**
 * Produce a safe, leak-proof User DTO.
 * Guarantees that passwordHash is never exposed, even when fed a lean query object.
 *
 * @param {Object} userDoc Mongoose document or plain object
 * @returns {Object} Clean user representation
 */
function sanitizeUserDto(userDoc) {
  if (!userDoc) return null;

  const raw = typeof userDoc.toObject === 'function' ? userDoc.toObject() : { ...userDoc };

  return {
    id: (raw._id || raw.id || '').toString(),
    name: raw.name,
    email: raw.email,
    phone: raw.phone,
    role: raw.role,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Sign a short-lived JSON Web Token for an authenticated user.
 *
 * @param {Object} user
 * @param {Object} jwtConfig { secret, expiresIn, algorithm }
 * @returns {string} Signed JWT
 */
function generateToken(user, jwtConfig) {
  const userId = (user._id || user.id).toString();
  const payload = {
    id: userId,
    email: user.email,
    role: user.role,
  };

  return jwt.sign(payload, jwtConfig.secret, {
    algorithm: jwtConfig.algorithm || 'HS256',
    expiresIn: jwtConfig.expiresIn || '1h',
  });
}

/**
 * Verify a JSON Web Token against secret and allowed algorithm.
 *
 * @param {string} token
 * @param {Object} jwtConfig { secret, algorithm }
 * @returns {Object} Decoded payload
 */
function verifyToken(token, jwtConfig) {
  return jwt.verify(token, jwtConfig.secret, {
    algorithms: [jwtConfig.algorithm || 'HS256'],
  });
}

module.exports = {
  BCRYPT_SALT_ROUNDS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  validatePasswordStrength,
  hashPassword,
  comparePassword,
  sanitizeUserDto,
  generateToken,
  verifyToken,
};
