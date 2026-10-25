// server/controllers/authController.js — Registration, Login & Profile logic
'use strict';

const { User } = require('../models');
const { getJwtConfig } = require('../config/env');
const {
  hashPassword,
  comparePassword,
  sanitizeUserDto,
  generateToken,
  validatePasswordStrength,
} = require('../utils/authUtils');

// Standard input validation regexes
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9+\-\s()]{7,20}$/;

// Strict list of allowed fields for public registration
const ALLOWED_REGISTRATION_FIELDS = new Set(['name', 'email', 'phone', 'password']);

/**
 * POST /api/auth/register
 * Public user registration. Always assigns role: 'user'.
 * Strictly rejects unexpected, privileged, or unknown fields (e.g. role, passwordHash, owner, isAdmin).
 */
async function register(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    // 1. Strict check: reject unexpected, privileged, or unknown fields
    const bodyKeys = Object.keys(req.body);
    const forbiddenOrUnknown = bodyKeys.filter((key) => !ALLOWED_REGISTRATION_FIELDS.has(key));
    if (forbiddenOrUnknown.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Registration payload contains forbidden or unrecognized fields.',
        code: 'FORBIDDEN_FIELDS',
      });
    }

    const { name, email, phone, password } = req.body;

    // 2. Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Name must be between 2 and 100 characters.',
        code: 'INVALID_NAME',
      });
    }

    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'A valid email address is required.',
        code: 'INVALID_EMAIL',
      });
    }

    if (!phone || typeof phone !== 'string' || !PHONE_REGEX.test(phone.trim())) {
      return res.status(400).json({
        success: false,
        message: 'A valid phone number is required.',
        code: 'INVALID_PHONE',
      });
    }

    try {
      validatePasswordStrength(password);
    } catch (pwErr) {
      return res.status(pwErr.statusCode || 400).json({
        success: false,
        message: pwErr.message,
        code: 'INVALID_PASSWORD',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const cleanPhone = phone.trim();

    // 3. Hash password asynchronously with bcrypt (documented cost: 10 rounds)
    const passwordHash = await hashPassword(password);

    // 4. Create user — strictly role: 'user'
    let user;
    try {
      user = await User.create({
        name: cleanName,
        email: normalizedEmail,
        phone: cleanPhone,
        passwordHash,
        role: 'user',
      });
    } catch (dbErr) {
      if (dbErr.code === 11000 || /duplicate key/i.test(dbErr.message)) {
        return res.status(409).json({
          success: false,
          message: 'Email already registered.',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }
      return res.status(400).json({
        success: false,
        message: 'Could not create account with provided information.',
        code: 'REGISTRATION_FAILED',
      });
    }

    // 5. Issue JWT
    const jwtConfig = getJwtConfig();
    const token = generateToken(user, jwtConfig);

    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      token,
      user: sanitizeUserDto(user),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred during registration.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/auth/login
 * User & Admin authentication. Returns generic invalid-credential message on any failure.
 */
async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
        code: 'MISSING_CREDENTIALS',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Explicitly select passwordHash for verification since it is hidden by default in the schema
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
    if (!user) {
      // Generic invalid-credential response prevents user enumeration
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    const isValid = await comparePassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Issue JWT
    const jwtConfig = getJwtConfig();
    const token = generateToken(user, jwtConfig);

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      user: sanitizeUserDto(user),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred during login.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * GET /api/auth/me
 * Retrieve currently authenticated user profile.
 */
async function getProfile(req, res) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    });
  }

  return res.status(200).json({
    success: true,
    user: sanitizeUserDto(req.user),
  });
}

module.exports = {
  register,
  login,
  getProfile,
  ALLOWED_REGISTRATION_FIELDS,
};
