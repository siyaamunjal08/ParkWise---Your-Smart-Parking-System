// server/controllers/bookingController.js — Stage 6 Booking API Controllers
'use strict';

const {
  createBooking,
  cancelBooking,
  getRecommendations,
  reconcileExpired,
  sanitizeBookingDto,
} = require('../services/bookingService');
const { Booking } = require('../models');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Fields that must never be accepted from the client (server-derived only) */
const FORBIDDEN_CLIENT_FIELDS = new Set([
  'user', 'price', 'pricePerHourPaise', 'startTime', 'endTime',
  'totalPaise', 'total', 'status', 'location_name', 'locationName',
  'slotCode', 'slot_code',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePage(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(raw, defaultVal = 20, max = 100) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

// ── POST /api/bookings ────────────────────────────────────────────────────────

/**
 * POST /api/bookings
 * Create a new immediate booking.
 *
 * Accepted fields: locationId, slotId, vehicleNumber, vehicleType, durationHours, requestId
 * Server-derived (rejected if client sends): user, price, startTime, endTime, totalPaise, status
 *
 * Returns 201 on success, 200 on idempotent retry.
 */
async function postCreateBooking(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    // Reject any server-derived fields sent by client
    const bodyKeys = Object.keys(req.body);
    const forbidden = bodyKeys.filter((k) => FORBIDDEN_CLIENT_FIELDS.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Request contains server-controlled fields that must not be set by the client: ${forbidden.join(', ')}.`,
        code: 'FORBIDDEN_FIELDS',
        fields: forbidden,
      });
    }

    const { locationId, slotId, vehicleNumber, vehicleType, durationHours, requestId } = req.body;

    // Basic presence check before passing to service
    if (!locationId || typeof locationId !== 'string' || !locationId.trim()) {
      return res.status(400).json({ success: false, message: 'locationId is required.', code: 'MISSING_FIELD' });
    }
    if (!slotId || typeof slotId !== 'string' || !slotId.trim()) {
      return res.status(400).json({ success: false, message: 'slotId is required.', code: 'MISSING_FIELD' });
    }
    if (!vehicleNumber || typeof vehicleNumber !== 'string') {
      return res.status(400).json({ success: false, message: 'vehicleNumber is required.', code: 'MISSING_FIELD' });
    }
    if (!vehicleType || typeof vehicleType !== 'string') {
      return res.status(400).json({ success: false, message: 'vehicleType is required.', code: 'MISSING_FIELD' });
    }
    if (durationHours === undefined || durationHours === null) {
      return res.status(400).json({ success: false, message: 'durationHours is required.', code: 'MISSING_FIELD' });
    }
    if (!requestId) {
      return res.status(400).json({ success: false, message: 'requestId is required.', code: 'MISSING_FIELD' });
    }

    const { booking, isIdempotentRetry } = await createBooking({
      userId: req.user._id.toString(),
      locationId: locationId.trim(),
      slotId: slotId.trim(),
      vehicleNumber,
      vehicleType,
      durationHours,
      requestId,
    });

    const statusCode = isIdempotentRetry ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      idempotentRetry: isIdempotentRetry,
      serverTime: new Date().toISOString(),
      booking: sanitizeBookingDto(booking),
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code || 'ERROR',
      });
    }
    console.error('[BookingController] createBooking error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create booking.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ── GET /api/bookings/me ──────────────────────────────────────────────────────

/**
 * GET /api/bookings/me
 * List all bookings for the authenticated user, newest first.
 * Reconciles expiry before responding so status is up to date.
 * Supports optional ?status= filter, ?search= / ?q= search, ?sort= sort, and pagination.
 */
async function getMyBookings(req, res) {
  try {
    // Reconcile before read so displayed statuses are current
    await reconcileExpired();

    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status, search, q, sort } = req.query;

    const filter = { user: req.user._id };
    const validStatuses = ['active', 'completed', 'cancelled'];
    if (status && validStatuses.includes(status)) {
      filter.status = status;
    }

    // Search query support with regex escaping across snapshots
    const rawSearch = search || q;
    if (typeof rawSearch === 'string' && rawSearch.trim()) {
      const safeSearch = rawSearch.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safeSearch, 'i');
      filter.$or = [
        { locationName: regex },
        { slotCode: regex },
        { 'vehicle.registrationNumber': regex },
        { 'vehicle.type': regex },
      ];
    }

    // Allowed sort options whitelist with unique _id tie-breaker for stable pagination
    // Using Map prevents inherited prototype properties (e.g. constructor, toString) from being accepted
    const ALLOWED_SORTS = new Map([
      ['newest', { createdAt: -1, _id: -1 }],
      ['oldest', { createdAt: 1, _id: -1 }],
      ['cost-high', { totalPaise: -1, _id: -1 }],
      ['cost-low', { totalPaise: 1, _id: -1 }],
      ['duration-high', { durationHours: -1, _id: -1 }],
    ]);
    const sortOption = (sort && ALLOWED_SORTS.has(sort))
      ? ALLOWED_SORTS.get(sort)
      : { createdAt: -1, _id: -1 };

    const skip = (page - 1) * limit;
    const [docs, total, activeCount, completedCount, cancelledCount, totalAllTime] = await Promise.all([
      Booking.find(filter).sort(sortOption).skip(skip).limit(limit).lean(),
      Booking.countDocuments(filter),
      Booking.countDocuments({ user: req.user._id, status: 'active' }),
      Booking.countDocuments({ user: req.user._id, status: 'completed' }),
      Booking.countDocuments({ user: req.user._id, status: 'cancelled' }),
      Booking.countDocuments({ user: req.user._id }),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page,
      limit,
      serverTime: new Date().toISOString(),
      counts: {
        total: totalAllTime,
        active: activeCount,
        completed: completedCount,
        cancelled: cancelledCount,
      },
      bookings: docs.map(sanitizeBookingDto),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve bookings.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ── PATCH /api/bookings/:bookingId/cancel ─────────────────────────────────────

/**
 * PATCH /api/bookings/:bookingId/cancel
 * Cancel an active booking. Only the owner can cancel.
 * Expired bookings at the time of cancel are marked completed, not cancelled.
 * Idempotent: repeated calls on already-settled bookings return the current state.
 */
async function patchCancelBooking(req, res) {
  try {
    const { bookingId } = req.params;

    if (!bookingId || typeof bookingId !== 'string' || !bookingId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'bookingId is required.',
        code: 'MISSING_FIELD',
      });
    }

    const { booking } = await cancelBooking(bookingId.trim(), req.user._id.toString());

    return res.status(200).json({
      success: true,
      serverTime: new Date().toISOString(),
      booking: sanitizeBookingDto(booking),
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code || 'ERROR',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to cancel booking.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ── GET /api/locations/:locationId/recommendations ───────────────────────────

/**
 * GET /api/locations/:locationId/recommendations
 * Return up to 3 ranked slot recommendations for an active location.
 * Public endpoint (no auth required).
 *
 * Query params:
 *   vehicleType          - Filter to matching type only
 *   maxPricePerHourPaise - Upper price bound in paise
 *   zone                 - Zone code filter
 */
async function getSlotRecommendations(req, res) {
  try {
    const { locationId } = req.params;

    const filters = {};
    const { vehicleType, maxPricePerHourPaise, zone } = req.query;
    if (vehicleType) filters.vehicleType = vehicleType;
    if (maxPricePerHourPaise !== undefined) filters.maxPricePerHourPaise = maxPricePerHourPaise;
    if (zone) filters.zone = zone;

    const { recommendations } = await getRecommendations(locationId, filters);

    return res.status(200).json({
      success: true,
      serverTime: new Date().toISOString(),
      recommendations,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code || 'ERROR',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve recommendations.',
      code: 'INTERNAL_ERROR',
    });
  }
}

module.exports = {
  postCreateBooking,
  getMyBookings,
  patchCancelBooking,
  getSlotRecommendations,
};
