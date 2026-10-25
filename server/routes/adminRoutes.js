// server/routes/adminRoutes.js — Admin-only location, slot, summary & booking routes (Stage 5)
'use strict';

const express = require('express');
const router = express.Router();

const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  adminListLocations,
  adminCreateLocation,
  adminUpdateLocation,
  adminListSlots,
  adminCreateSlot,
  adminUpdateSlot,
  adminSummary,
  adminListBookings,
} = require('../controllers/locationController');

// All admin routes require authentication and admin role
router.use(requireAuth, requireAdmin);

// ── Admin Location Routes ──────────────────────────────────────
// GET  /api/admin/locations
// POST /api/admin/locations
router.get('/locations', adminListLocations);
router.post('/locations', adminCreateLocation);

// PATCH /api/admin/locations/:locationId
router.patch('/locations/:locationId', adminUpdateLocation);

// ── Admin Slot Routes (scoped by locationId) ──────────────────
// GET  /api/admin/locations/:locationId/slots
// POST /api/admin/locations/:locationId/slots
router.get('/locations/:locationId/slots', adminListSlots);
router.post('/locations/:locationId/slots', adminCreateSlot);

// PATCH /api/admin/locations/:locationId/slots/:slotId
router.patch('/locations/:locationId/slots/:slotId', adminUpdateSlot);

// ── Admin Summary & Bookings ──────────────────────────────────
// GET /api/admin/summary
router.get('/summary', adminSummary);

// GET /api/admin/bookings?location=&status=&page=&limit=
router.get('/bookings', adminListBookings);

module.exports = router;
