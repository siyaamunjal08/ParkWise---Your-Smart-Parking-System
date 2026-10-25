// server/routes/bookingRoutes.js — Stage 6 Booking Routes
'use strict';

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const {
  postCreateBooking,
  getMyBookings,
  patchCancelBooking,
} = require('../controllers/bookingController');

// POST /api/bookings — create a booking (authenticated)
router.post('/', requireAuth, postCreateBooking);

// GET /api/bookings/me — list caller's bookings (authenticated)
router.get('/me', requireAuth, getMyBookings);

// PATCH /api/bookings/:bookingId/cancel — cancel a booking (authenticated, owner only)
router.patch('/:bookingId/cancel', requireAuth, patchCancelBooking);

module.exports = router;
