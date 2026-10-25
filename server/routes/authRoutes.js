// server/routes/authRoutes.js — Authentication routes definition
'use strict';

const express = require('express');
const router = express.Router();

const { register, login, getProfile } = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Public auth endpoints with rate limiting
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);

// Protected user profile
router.get('/me', requireAuth, getProfile);

module.exports = router;
