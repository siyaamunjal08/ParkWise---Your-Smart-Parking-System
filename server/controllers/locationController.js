// server/controllers/locationController.js — Location & Slot API logic (Stage 5)
'use strict';

const mongoose = require('mongoose');
const { ParkingLocation, ParkingSlot, Booking, User } = require('../models');

// ── Constants ─────────────────────────────────────────────────

/** Maximum characters for free-text search query */
const MAX_QUERY_LENGTH = 200;

/** Default and maximum page sizes for list endpoints */
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

/** Allowed fields for admin location creation/edit */
const ALLOWED_LOCATION_WRITE_FIELDS = new Set([
  'name',
  'category',
  'address',
  'city',
  'area',
  'contactPhone',
  'latitude',
  'longitude',
  'facilities',
]);

/** Allowed fields for admin slot creation/edit */
const ALLOWED_SLOT_WRITE_FIELDS = new Set([
  'code',
  'zone',
  'floor',
  'vehicleType',
  'pricePerHourPaise',
  'distanceFromEntry',
  'features',
]);

// ── Helpers ───────────────────────────────────────────────────

/**
 * Parse a positive integer page query parameter.
 * Returns 1 on invalid/missing input.
 */
function parsePage(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Parse a bounded positive integer limit parameter.
 */
function parseLimit(raw, defaultVal = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

/**
 * Produce a safe public DTO for a ParkingLocation document.
 * Omits internal bookingRevision, isDemo, createdBy.
 */
function sanitizeLocationDto(doc) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  return {
    id: (raw._id || raw.id || '').toString(),
    slug: raw.slug,
    name: raw.name,
    category: raw.category,
    address: raw.address,
    city: raw.city,
    area: raw.area,
    contactPhone: raw.contactPhone,
    latitude: raw.latitude,
    longitude: raw.longitude,
    facilities: raw.facilities || [],
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Produce a safe public DTO for a ParkingSlot document.
 * Does not expose the internal activeBooking ObjectId to public callers.
 */
function sanitizeSlotDto(doc, { includeBookingRef = false } = {}) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const dto = {
    id: (raw._id || raw.id || '').toString(),
    location: raw.location ? raw.location.toString() : null,
    code: raw.code,
    zone: raw.zone,
    floor: raw.floor,
    vehicleType: raw.vehicleType,
    pricePerHourPaise: raw.pricePerHourPaise,
    distanceFromEntry: raw.distanceFromEntry,
    features: raw.features || [],
    serviceStatus: raw.serviceStatus,
    available: raw.serviceStatus === 'enabled' && !raw.activeBooking,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (includeBookingRef) {
    dto.activeBooking = raw.activeBooking ? raw.activeBooking.toString() : null;
  }
  return dto;
}

/**
 * Sanitize a booking document for admin listing.
 * Exposes only safe user fields (no passwordHash, no internal tokens).
 */
function sanitizeBookingForAdmin(doc) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };

  let safeUser = null;
  if (raw.user && typeof raw.user === 'object') {
    safeUser = {
      id: (raw.user._id || raw.user.id || '').toString(),
      name: raw.user.name,
      email: raw.user.email,
      phone: raw.user.phone,
    };
  } else if (raw.user) {
    safeUser = { id: raw.user.toString() };
  }

  return {
    id: (raw._id || raw.id || '').toString(),
    user: safeUser,
    location: raw.location ? raw.location.toString() : null,
    locationName: raw.locationName,
    slot: raw.slot ? raw.slot.toString() : null,
    slotCode: raw.slotCode,
    vehicle: raw.vehicle,
    pricePerHourPaise: raw.pricePerHourPaise,
    startTime: raw.startTime,
    endTime: raw.endTime,
    durationHours: raw.durationHours,
    totalPaise: raw.totalPaise,
    status: raw.status,
    requestId: raw.requestId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Safely generate a unique slug derived from a location name.
 * If the base slug already exists, appends suffixes: -2, -3, ...
 * Returns candidate string or null if max attempts exceeded.
 */
async function resolveUniqueSlug(baseSlug, maxAttempts = 100) {
  let candidate = baseSlug;
  let counter = 1;

  while (counter <= maxAttempts) {
    const exists = await ParkingLocation.exists({ slug: candidate });
    if (!exists) {
      return candidate;
    }
    counter += 1;
    candidate = `${baseSlug}-${counter}`;
  }
  return null;
}

/**
 * Validate all required publish preconditions for a location.
 * Validates in-memory/target state on `locOrId` (or loads document if an ID was passed),
 * and verifies that at least one enabled slot exists in MongoDB.
 * Returns array of human-readable violation strings (empty = publishable).
 */
async function checkPublishPreconditions(locOrId) {
  let loc = locOrId;
  if (!loc || typeof loc !== 'object' || (typeof loc.toObject !== 'function' && !loc._id)) {
    loc = await ParkingLocation.findById(locOrId);
  }
  if (!loc) return ['Location not found.'];

  const violations = [];

  const address = loc.address ? String(loc.address).trim() : '';
  const city = loc.city ? String(loc.city).trim() : '';
  const area = loc.area ? String(loc.area).trim() : '';

  if (!address) violations.push('Address is required to publish.');
  if (!city) violations.push('City is required to publish.');
  if (!area) violations.push('Area is required to publish.');

  // Coordinates must be valid finite numbers within range (0,0 is explicitly allowed)
  if (
    loc.latitude === undefined ||
    loc.latitude === null ||
    !Number.isFinite(loc.latitude) ||
    loc.latitude < -90 ||
    loc.latitude > 90
  ) {
    violations.push('Valid latitude (-90 to 90) is required to publish.');
  }
  if (
    loc.longitude === undefined ||
    loc.longitude === null ||
    !Number.isFinite(loc.longitude) ||
    loc.longitude < -180 ||
    loc.longitude > 180
  ) {
    violations.push('Valid longitude (-180 to 180) is required to publish.');
  }

  // Must have at least one enabled slot
  const locationId = loc._id || loc.id;
  const enabledSlotCount = await ParkingSlot.countDocuments({
    location: locationId,
    serviceStatus: 'enabled',
  });
  if (enabledSlotCount < 1) {
    violations.push('At least one enabled slot is required to publish.');
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/locations
 * Public search. Returns active and closed facilities (never drafts or archives).
 * Closed locations are returned with an explicit unavailable flag.
 *
 * Query: q (literal), city, area, page, limit
 */
async function listPublicLocations(req, res) {
  try {
    const { q, city, area } = req.query;
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);

    // Build filter: only active + closed for public
    const filter = { status: { $in: ['active', 'closed'] } };

    // Literal text search — escape regex special characters to prevent injection
    if (q && typeof q === 'string' && q.trim().length > 0) {
      const trimmedQ = q.trim().slice(0, MAX_QUERY_LENGTH);
      // Escaped literal pattern (no arbitrary regex from user input)
      const escaped = trimmedQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { area: { $regex: escaped, $options: 'i' } },
        { city: { $regex: escaped, $options: 'i' } },
        { address: { $regex: escaped, $options: 'i' } },
      ];
    }

    if (city && typeof city === 'string' && city.trim().length > 0) {
      const escaped = city.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.city = { $regex: escaped, $options: 'i' };
    }

    if (area && typeof area === 'string' && area.trim().length > 0) {
      const escaped = area.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.area = { $regex: escaped, $options: 'i' };
    }

    const skip = (page - 1) * limit;
    const [docs, total] = await Promise.all([
      ParkingLocation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ParkingLocation.countDocuments(filter),
    ]);

    // Derive per-location availability and total counts from non-archived slots
    const locationIds = docs.map((d) => d._id);
    const slotAggs = await ParkingSlot.aggregate([
      {
        $match: {
          location: { $in: locationIds },
          serviceStatus: { $ne: 'archived' },
        },
      },
      {
        $group: {
          _id: '$location',
          totalSlots: { $sum: 1 },
          availableSlots: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$serviceStatus', 'enabled'] },
                    { $eq: ['$activeBooking', null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const slotMap = {};
    for (const agg of slotAggs) {
      slotMap[agg._id.toString()] = {
        totalSlots: agg.totalSlots,
        availableSlots: agg.availableSlots,
      };
    }

    const results = docs.map((raw) => {
      const dto = sanitizeLocationDto(raw);
      const counts = slotMap[raw._id.toString()] || { totalSlots: 0, availableSlots: 0 };
      dto.totalSlots = counts.totalSlots;
      dto.availableSlots = counts.availableSlots;
      // Explicit unavailable marker for closed facilities
      if (raw.status === 'closed') {
        dto.unavailable = true;
        dto.unavailableReason = 'This parking facility is temporarily closed.';
      }
      return dto;
    });

    return res.status(200).json({
      success: true,
      total,
      page,
      limit,
      locations: results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve locations.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * GET /api/locations/:locationId
 * Public location detail. Rejects drafts and archives with 404.
 */
async function getPublicLocation(req, res) {
  try {
    const { locationId } = req.params;

    let doc;
    try {
      doc = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({
        success: false,
        message: 'Location not found.',
        code: 'NOT_FOUND',
      });
    }

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'Location not found.',
        code: 'NOT_FOUND',
      });
    }

    // Drafts and archived locations are completely hidden from public routes
    if (doc.status === 'draft' || doc.status === 'archived') {
      return res.status(404).json({
        success: false,
        message: 'Location not found.',
        code: 'NOT_FOUND',
      });
    }

    const dto = sanitizeLocationDto(doc);

    // Counts for public detail:
    // totalSlots: count of non-archived slots at that location
    // availableSlots: enabled slots with activeBooking=null
    const [totalSlots, availableSlots] = await Promise.all([
      ParkingSlot.countDocuments({
        location: doc._id,
        serviceStatus: { $ne: 'archived' },
      }),
      ParkingSlot.countDocuments({
        location: doc._id,
        serviceStatus: 'enabled',
        activeBooking: null,
      }),
    ]);
    dto.totalSlots = totalSlots;
    dto.availableSlots = availableSlots;

    if (doc.status === 'closed') {
      dto.unavailable = true;
      dto.unavailableReason = 'This parking facility is temporarily closed.';
    }

    return res.status(200).json({ success: true, location: dto });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve location.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * GET /api/locations/:locationId/slots
 * Public slot listing for an active location only.
 * Returns only enabled slots with derived availability.
 */
async function getPublicSlots(req, res) {
  try {
    const { locationId } = req.params;

    let location;
    try {
      location = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({
        success: false,
        message: 'Location not found.',
        code: 'NOT_FOUND',
      });
    }

    if (!location || location.status === 'draft' || location.status === 'archived') {
      return res.status(404).json({
        success: false,
        message: 'Location not found.',
        code: 'NOT_FOUND',
      });
    }

    const { zone, status } = req.query;

    if (status !== undefined && status !== '') {
      if (status !== 'available' && status !== 'occupied') {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter. Allowed values: 'available', 'occupied'.",
          code: 'INVALID_STATUS_FILTER',
        });
      }
    }

    if (location.status === 'closed') {
      return res.status(200).json({
        success: true,
        locationStatus: 'closed',
        unavailable: true,
        unavailableReason: 'This parking facility is temporarily closed.',
        slots: [],
      });
    }

    // Only enabled slots are shown publicly
    const filter = {
      location: location._id,
      serviceStatus: 'enabled',
    };

    if (zone && typeof zone === 'string' && zone.trim()) {
      filter.zone = zone.trim().toUpperCase();
    }

    if (status === 'available') {
      filter.activeBooking = null;
    } else if (status === 'occupied') {
      filter.activeBooking = { $ne: null };
    }

    const slots = await ParkingSlot.find(filter)
      .sort({ zone: 1, code: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      locationStatus: location.status,
      slots: slots.map((s) => sanitizeSlotDto(s)),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve slots.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — LOCATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/admin/locations
 * Admin: list all locations (all statuses).
 */
async function adminListLocations(req, res) {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status } = req.query;

    const filter = {};
    const validStatuses = ['draft', 'active', 'closed', 'archived'];
    if (status && validStatuses.includes(status)) {
      filter.status = status;
    }

    const skip = (page - 1) * limit;
    const [docs, total] = await Promise.all([
      ParkingLocation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ParkingLocation.countDocuments(filter),
    ]);

    // Include slot counts for admin convenience
    const locationIds = docs.map((d) => d._id);
    const slotAggs = await ParkingSlot.aggregate([
      { $match: { location: { $in: locationIds } } },
      {
        $group: {
          _id: '$location',
          totalSlots: { $sum: 1 },
          enabledSlots: { $sum: { $cond: [{ $eq: ['$serviceStatus', 'enabled'] }, 1, 0] } },
          availableSlots: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$serviceStatus', 'enabled'] },
                    { $eq: ['$activeBooking', null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const slotMap = {};
    for (const agg of slotAggs) {
      slotMap[agg._id.toString()] = {
        totalSlots: agg.totalSlots,
        enabledSlots: agg.enabledSlots,
        availableSlots: agg.availableSlots,
      };
    }

    const results = docs.map((raw) => {
      const dto = sanitizeLocationDto(raw);
      dto.bookingRevision = raw.bookingRevision;
      dto.isDemo = raw.isDemo;
      const counts = slotMap[raw._id.toString()] || { totalSlots: 0, enabledSlots: 0, availableSlots: 0 };
      dto.totalSlots = counts.totalSlots;
      dto.enabledSlots = counts.enabledSlots;
      dto.availableSlots = counts.availableSlots;
      return dto;
    });

    return res.status(200).json({ success: true, total, page, limit, locations: results });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve locations.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/admin/locations
 * Admin: create a new draft location.
 * Only allowed fields are accepted; unknown fields are rejected.
 * New locations always start as 'draft'.
 */
async function adminCreateLocation(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    const bodyKeys = Object.keys(req.body);
    const forbidden = bodyKeys.filter((k) => !ALLOWED_LOCATION_WRITE_FIELDS.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Request contains forbidden or unrecognized fields.',
        code: 'FORBIDDEN_FIELDS',
      });
    }

    const {
      name, category, address, city, area,
      contactPhone, latitude, longitude, facilities,
    } = req.body;

    // Derive base slug from name
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Location name is required.',
        code: 'INVALID_NAME',
      });
    }

    let baseSlug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!baseSlug) {
      baseSlug = 'location';
    }

    // Validate coordinates when supplied
    if (latitude !== undefined || longitude !== undefined) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({
          success: false,
          message: 'Latitude must be a finite number between -90 and 90.',
          code: 'INVALID_COORDINATES',
        });
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({
          success: false,
          message: 'Longitude must be a finite number between -180 and 180.',
          code: 'INVALID_COORDINATES',
        });
      }
    }

    let candidateSlug = await resolveUniqueSlug(baseSlug);
    if (!candidateSlug) {
      return res.status(409).json({
        success: false,
        message: 'Could not generate a unique slug for this location.',
        code: 'SLUG_GENERATION_FAILED',
      });
    }

    let doc;
    const MAX_COLLISION_RETRIES = 10;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
      try {
        doc = await ParkingLocation.create({
          slug: candidateSlug,
          name: name.trim(),
          category,
          address: address ? String(address).trim() : undefined,
          city: city ? String(city).trim() : undefined,
          area: area ? String(area).trim() : undefined,
          contactPhone: contactPhone ? String(contactPhone).trim() : undefined,
          latitude: latitude !== undefined ? parseFloat(latitude) : undefined,
          longitude: longitude !== undefined ? parseFloat(longitude) : undefined,
          facilities: Array.isArray(facilities) ? facilities : [],
          status: 'draft',
          createdBy: req.user._id,
        });
        break;
      } catch (dbErr) {
        if (dbErr.code === 11000 || /duplicate key/i.test(dbErr.message)) {
          candidateSlug = await resolveUniqueSlug(baseSlug);
          if (!candidateSlug) {
            return res.status(409).json({
              success: false,
              message: 'Could not resolve unique slug due to concurrent collision.',
              code: 'SLUG_GENERATION_FAILED',
            });
          }
          continue;
        }
        if (dbErr.name === 'ValidationError') {
          const first = Object.values(dbErr.errors)[0];
          return res.status(400).json({
            success: false,
            message: first ? first.message : 'Validation error.',
            code: 'VALIDATION_ERROR',
          });
        }
        return res.status(400).json({
          success: false,
          message: 'Could not create location with provided information.',
          code: 'CREATE_FAILED',
        });
      }
    }

    if (!doc) {
      return res.status(409).json({
        success: false,
        message: 'Could not generate a unique slug for this location after multiple attempts.',
        code: 'SLUG_GENERATION_FAILED',
      });
    }

    return res.status(201).json({ success: true, location: sanitizeLocationDto(doc) });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create location.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * PATCH /api/admin/locations/:locationId
 * Admin: update location fields and/or lifecycle status.
 *
 * Lifecycle transitions:
 *   draft   → active  (requires publish preconditions)
 *   active  → closed
 *   closed  → active  (reopen)
 *   active | closed → archived (only if no active bookings)
 *
 * Rejected transitions: anything → draft, archived → anything.
 */
async function adminUpdateLocation(req, res) {
  try {
    const { locationId } = req.params;

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    // Determine allowed patch fields: write fields + optional status
    const allowedPatch = new Set([...ALLOWED_LOCATION_WRITE_FIELDS, 'status']);
    const bodyKeys = Object.keys(req.body);
    const forbidden = bodyKeys.filter((k) => !allowedPatch.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Request contains forbidden or unrecognized fields.',
        code: 'FORBIDDEN_FIELDS',
      });
    }

    let doc;
    try {
      doc = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }

    // Archived locations cannot be edited
    if (doc.status === 'archived') {
      return res.status(409).json({
        success: false,
        message: 'Archived locations cannot be modified.',
        code: 'ARCHIVED_IMMUTABLE',
      });
    }

    const { status: newStatus, ...editableFields } = req.body;

    // Validate and apply coordinates if provided
    if (editableFields.latitude !== undefined || editableFields.longitude !== undefined) {
      const lat = parseFloat(editableFields.latitude);
      const lng = parseFloat(editableFields.longitude);
      if (editableFields.latitude !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
        return res.status(400).json({
          success: false,
          message: 'Latitude must be a finite number between -90 and 90.',
          code: 'INVALID_COORDINATES',
        });
      }
      if (editableFields.longitude !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
        return res.status(400).json({
          success: false,
          message: 'Longitude must be a finite number between -180 and 180.',
          code: 'INVALID_COORDINATES',
        });
      }
      if (editableFields.latitude !== undefined) editableFields.latitude = lat;
      if (editableFields.longitude !== undefined) editableFields.longitude = lng;
    }

    // Apply editable fields
    const safeEditKeys = [...ALLOWED_LOCATION_WRITE_FIELDS].filter((k) => editableFields[k] !== undefined);
    for (const key of safeEditKeys) {
      if (key === 'facilities') {
        doc.facilities = Array.isArray(editableFields.facilities) ? editableFields.facilities : doc.facilities;
      } else {
        doc[key] = editableFields[key];
      }
    }

    // Handle lifecycle status transitions
    if (newStatus !== undefined) {
      const from = doc.status;

      const ALLOWED_TRANSITIONS = {
        draft: ['active'],
        active: ['closed', 'archived'],
        closed: ['active', 'archived'],
        archived: [], // no transitions out of archived
      };

      if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].includes(newStatus)) {
        return res.status(409).json({
          success: false,
          message: `Cannot transition location from '${from}' to '${newStatus}'.`,
          code: 'INVALID_STATUS_TRANSITION',
        });
      }

      // Publishing (draft → active) requires preconditions
      if (newStatus === 'active') {
        const violations = await checkPublishPreconditions(doc);
        if (violations.length > 0) {
          return res.status(422).json({
            success: false,
            message: 'Location cannot be published. Preconditions not met.',
            violations,
            code: 'PUBLISH_PRECONDITIONS_FAILED',
          });
        }
      }

      // Archiving requires no active bookings and must be coordinated atomically with booking creation
      if (newStatus === 'archived') {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const updateSet = { status: 'archived' };
            for (const key of safeEditKeys) {
              if (key === 'facilities') {
                updateSet.facilities = Array.isArray(editableFields.facilities) ? editableFields.facilities : doc.facilities;
              } else {
                updateSet[key] = editableFields[key];
              }
            }

            const locInTx = await ParkingLocation.findOneAndUpdate(
              { _id: doc._id, status: from },
              { $set: updateSet, $inc: { bookingRevision: 1 } },
              { new: true, session }
            );

            if (!locInTx) {
              const current = await ParkingLocation.findById(doc._id).session(session);
              const isArchived = current && current.status === 'archived';
              const err = new Error(isArchived ? 'Archived locations cannot be modified.' : 'Cannot archive location in current state.');
              err.statusCode = 409;
              err.code = isArchived ? 'ARCHIVED_IMMUTABLE' : 'INVALID_STATUS_TRANSITION';
              throw err;
            }

            // Validate complete resulting location inside transaction before committing
            await locInTx.validate();

            const activeBookingCount = await Booking.countDocuments({
              location: doc._id,
              status: 'active',
            }).session(session);

            if (activeBookingCount > 0) {
              const err = new Error('Cannot archive a location with active bookings.');
              err.statusCode = 409;
              err.code = 'ACTIVE_BOOKINGS_EXIST';
              throw err;
            }

            doc = locInTx;
          });
        } catch (txErr) {
          if (txErr.name === 'ValidationError') {
            const first = Object.values(txErr.errors)[0];
            return res.status(400).json({
              success: false,
              message: first ? first.message : 'Validation error.',
              code: 'VALIDATION_ERROR',
            });
          }
          if (txErr.statusCode) {
            return res.status(txErr.statusCode).json({
              success: false,
              message: txErr.message,
              code: txErr.code || 'ERROR',
            });
          }
          throw txErr;
        } finally {
          await session.endSession();
        }

        const adminDto = sanitizeLocationDto(doc);
        adminDto.bookingRevision = doc.bookingRevision;
        return res.status(200).json({ success: true, location: adminDto });
      }

      // Closing a location must atomically transition status and increment bookingRevision
      // while preserving all existing active bookings intact.
      if (newStatus === 'closed') {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const updateSet = { status: 'closed' };
            for (const key of safeEditKeys) {
              if (key === 'facilities') {
                updateSet.facilities = Array.isArray(editableFields.facilities) ? editableFields.facilities : doc.facilities;
              } else {
                updateSet[key] = editableFields[key];
              }
            }

            const locInTx = await ParkingLocation.findOneAndUpdate(
              { _id: doc._id, status: from },
              { $set: updateSet, $inc: { bookingRevision: 1 } },
              { new: true, session }
            );

            if (!locInTx) {
              const current = await ParkingLocation.findById(doc._id).session(session);
              const isArchived = current && current.status === 'archived';
              const err = new Error(isArchived ? 'Archived locations cannot be modified.' : 'Cannot transition location from current status to closed.');
              err.statusCode = 409;
              err.code = isArchived ? 'ARCHIVED_IMMUTABLE' : 'INVALID_STATUS_TRANSITION';
              throw err;
            }

            // Validate complete resulting location inside transaction before committing
            await locInTx.validate();

            doc = locInTx;
          });
        } catch (txErr) {
          if (txErr.name === 'ValidationError') {
            const first = Object.values(txErr.errors)[0];
            return res.status(400).json({
              success: false,
              message: first ? first.message : 'Validation error.',
              code: 'VALIDATION_ERROR',
            });
          }
          if (txErr.statusCode) {
            return res.status(txErr.statusCode).json({
              success: false,
              message: txErr.message,
              code: txErr.code || 'ERROR',
            });
          }
          throw txErr;
        } finally {
          await session.endSession();
        }

        const adminDto = sanitizeLocationDto(doc);
        adminDto.bookingRevision = doc.bookingRevision;
        return res.status(200).json({ success: true, location: adminDto });
      }

      // Activating/reopening a location guarded against stale concurrent archival
      if (newStatus === 'active') {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            if (from === 'draft') {
              const violations = await checkPublishPreconditions(doc);
              if (violations.length > 0) {
                const err = new Error('Location cannot be published. Preconditions not met.');
                err.statusCode = 422;
                err.code = 'PUBLISH_PRECONDITIONS_FAILED';
                err.violations = violations;
                throw err;
              }
            }

            const updateSet = { status: 'active' };
            for (const key of safeEditKeys) {
              if (key === 'facilities') {
                updateSet.facilities = Array.isArray(editableFields.facilities) ? editableFields.facilities : doc.facilities;
              } else {
                updateSet[key] = editableFields[key];
              }
            }

            const locInTx = await ParkingLocation.findOneAndUpdate(
              { _id: doc._id, status: from },
              { $set: updateSet, $inc: { bookingRevision: 1 } },
              { new: true, session }
            );

            if (!locInTx) {
              const current = await ParkingLocation.findById(doc._id).session(session);
              const isArchived = current && current.status === 'archived';
              const err = new Error(isArchived ? 'Archived locations cannot be modified.' : 'Cannot transition location from current status to active.');
              err.statusCode = 409;
              err.code = isArchived ? 'ARCHIVED_IMMUTABLE' : 'INVALID_STATUS_TRANSITION';
              throw err;
            }

            await locInTx.validate();
            doc = locInTx;
          });
        } catch (txErr) {
          if (txErr.violations) {
            return res.status(422).json({
              success: false,
              message: txErr.message,
              violations: txErr.violations,
              code: txErr.code,
            });
          }
          if (txErr.name === 'ValidationError') {
            const first = Object.values(txErr.errors)[0];
            return res.status(400).json({
              success: false,
              message: first ? first.message : 'Validation error.',
              code: 'VALIDATION_ERROR',
            });
          }
          if (txErr.statusCode) {
            return res.status(txErr.statusCode).json({
              success: false,
              message: txErr.message,
              code: txErr.code || 'ERROR',
            });
          }
          throw txErr;
        } finally {
          await session.endSession();
        }

        const adminDto = sanitizeLocationDto(doc);
        adminDto.bookingRevision = doc.bookingRevision;
        return res.status(200).json({ success: true, location: adminDto });
      }
    }

    // Pure field updates on existing status
    const from = doc.status;
    const updateSet = {};
    for (const key of safeEditKeys) {
      if (key === 'facilities') {
        updateSet.facilities = Array.isArray(editableFields.facilities) ? editableFields.facilities : doc.facilities;
      } else {
        updateSet[key] = editableFields[key];
      }
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const locInTx = await ParkingLocation.findOneAndUpdate(
          { _id: doc._id, status: from },
          { $set: updateSet },
          { new: true, session }
        );

        if (!locInTx) {
          const current = await ParkingLocation.findById(doc._id).session(session);
          const isArchived = current && current.status === 'archived';
          const err = new Error(isArchived ? 'Archived locations cannot be modified.' : 'Location update failed due to concurrent modification.');
          err.statusCode = 409;
          err.code = isArchived ? 'ARCHIVED_IMMUTABLE' : 'LOCATION_CONFLICT';
          throw err;
        }

        await locInTx.validate();
        doc = locInTx;
      });
    } catch (txErr) {
      if (txErr.name === 'ValidationError') {
        const first = Object.values(txErr.errors)[0];
        return res.status(400).json({
          success: false,
          message: first ? first.message : 'Validation error.',
          code: 'VALIDATION_ERROR',
        });
      }
      if (txErr.statusCode) {
        return res.status(txErr.statusCode).json({
          success: false,
          message: txErr.message,
          code: txErr.code || 'ERROR',
        });
      }
      throw txErr;
    } finally {
      await session.endSession();
    }

    const adminDto = sanitizeLocationDto(doc);
    adminDto.bookingRevision = doc.bookingRevision;

    return res.status(200).json({ success: true, location: adminDto });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update location.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — SLOT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/admin/locations/:locationId/slots
 * Admin: list all slots for a location (all serviceStatuses).
 */
async function adminListSlots(req, res) {
  try {
    const { locationId } = req.params;

    let location;
    try {
      location = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }

    const slots = await ParkingSlot.find({ location: location._id })
      .sort({ zone: 1, code: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      slots: slots.map((s) => sanitizeSlotDto(s, { includeBookingRef: true })),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve slots.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/admin/locations/:locationId/slots
 * Admin: add a new slot to a location.
 * Only allowed fields accepted. Slot codes are unique per location (not globally).
 */
async function adminCreateSlot(req, res) {
  try {
    const { locationId } = req.params;

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    const bodyKeys = Object.keys(req.body);
    const forbidden = bodyKeys.filter((k) => !ALLOWED_SLOT_WRITE_FIELDS.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Request contains forbidden or unrecognized fields.',
        code: 'FORBIDDEN_FIELDS',
      });
    }

    let location;
    try {
      location = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }

    // Archived locations cannot receive new slots
    if (location.status === 'archived') {
      return res.status(409).json({
        success: false,
        message: 'Cannot add slots to an archived location.',
        code: 'ARCHIVED_IMMUTABLE',
      });
    }

    const { code, zone, floor, vehicleType, pricePerHourPaise, distanceFromEntry, features } = req.body;

    // Numeric field validation
    if (pricePerHourPaise !== undefined) {
      const price = parseInt(pricePerHourPaise, 10);
      if (!Number.isInteger(price) || price < 0) {
        return res.status(400).json({
          success: false,
          message: 'pricePerHourPaise must be a non-negative integer.',
          code: 'INVALID_PRICE',
        });
      }
    }

    if (distanceFromEntry !== undefined) {
      const dist = parseFloat(distanceFromEntry);
      if (!Number.isFinite(dist) || dist < 0) {
        return res.status(400).json({
          success: false,
          message: 'distanceFromEntry must be a non-negative number.',
          code: 'INVALID_DISTANCE',
        });
      }
    }

    if (floor !== undefined && !Number.isInteger(floor)) {
      return res.status(400).json({
        success: false,
        message: 'Floor must be an integer.',
        code: 'INVALID_FLOOR',
      });
    }

    let slot;
    try {
      slot = await ParkingSlot.create({
        location: location._id,
        code,
        zone,
        floor,
        vehicleType,
        pricePerHourPaise: pricePerHourPaise !== undefined ? parseInt(pricePerHourPaise, 10) : undefined,
        distanceFromEntry: distanceFromEntry !== undefined ? parseFloat(distanceFromEntry) : undefined,
        features: Array.isArray(features) ? features : [],
      });
    } catch (dbErr) {
      if (dbErr.code === 11000 || /duplicate key/i.test(dbErr.message)) {
        return res.status(409).json({
          success: false,
          message: 'A slot with this code already exists at this location.',
          code: 'DUPLICATE_SLOT_CODE',
        });
      }
      if (dbErr.name === 'ValidationError') {
        const first = Object.values(dbErr.errors)[0];
        return res.status(400).json({
          success: false,
          message: first ? first.message : 'Validation error.',
          code: 'VALIDATION_ERROR',
        });
      }
      return res.status(400).json({
        success: false,
        message: 'Could not create slot with provided information.',
        code: 'CREATE_FAILED',
      });
    }

    return res.status(201).json({
      success: true,
      slot: sanitizeSlotDto(slot, { includeBookingRef: true }),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create slot.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * PATCH /api/admin/locations/:locationId/slots/:slotId
 * Admin: edit slot fields or change serviceStatus.
 *
 * Unclaimed slots (activeBooking: null): full field editing allowed.
 * Claimed slots (activeBooking set): ONLY serviceStatus='maintenance' is allowed.
 *   Cannot re-enable, change price, code, etc. while claimed.
 * Archived slots: immutable — no edits.
 *
 * serviceStatus transitions:
 *   enabled → maintenance | archived  (unclaimed only for archive)
 *   maintenance → enabled | archived  (unclaimed only for archive)
 *   archived → (none)
 *
 * Hard deletion is rejected; use archive instead for referenced slots.
 * Both :locationId and :slotId must match (scoped).
 */
async function adminUpdateSlot(req, res) {
  try {
    const { locationId, slotId } = req.params;

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    const allowedPatch = new Set([...ALLOWED_SLOT_WRITE_FIELDS, 'serviceStatus']);
    const bodyKeys = Object.keys(req.body);
    const forbidden = bodyKeys.filter((k) => !allowedPatch.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Request contains forbidden or unrecognized fields.',
        code: 'FORBIDDEN_FIELDS',
      });
    }

    // Verify location exists
    let location;
    try {
      location = await ParkingLocation.findById(locationId);
    } catch {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }
    if (!location) {
      return res.status(404).json({ success: false, message: 'Location not found.', code: 'NOT_FOUND' });
    }

    // Find slot scoped to this location (both IDs must match)
    let slot;
    try {
      slot = await ParkingSlot.findOne({ _id: slotId, location: location._id });
    } catch {
      return res.status(404).json({ success: false, message: 'Slot not found.', code: 'NOT_FOUND' });
    }
    if (!slot) {
      return res.status(404).json({ success: false, message: 'Slot not found.', code: 'NOT_FOUND' });
    }

    // Archived slots are immutable
    if (slot.serviceStatus === 'archived') {
      return res.status(409).json({
        success: false,
        message: 'Archived slots cannot be modified.',
        code: 'SLOT_ARCHIVED_IMMUTABLE',
      });
    }

    const from = slot.serviceStatus;
    const isClaimed = Boolean(slot.activeBooking);
    const { serviceStatus: newServiceStatus, ...fieldEdits } = req.body;

    // Claimed slot restrictions
    if (isClaimed) {
      const nonStatusKeys = Object.keys(fieldEdits).filter(
        (k) => ALLOWED_SLOT_WRITE_FIELDS.has(k)
      );
      if (nonStatusKeys.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Cannot modify slot fields while slot has an active booking. Only placing slot into maintenance is allowed.',
          code: 'SLOT_CLAIMED',
        });
      }

      // Only maintenance is allowed on a claimed slot
      if (newServiceStatus !== undefined && newServiceStatus !== 'maintenance') {
        return res.status(409).json({
          success: false,
          message: 'Claimed slot can only be placed into maintenance, not re-enabled or archived.',
          code: 'SLOT_CLAIMED',
        });
      }
    }

    // serviceStatus transition validation
    if (newServiceStatus !== undefined) {
      const SLOT_TRANSITIONS = {
        enabled: ['maintenance', 'archived'],
        maintenance: ['enabled', 'archived'],
        archived: [],
      };

      if (!SLOT_TRANSITIONS[from] || !SLOT_TRANSITIONS[from].includes(newServiceStatus)) {
        return res.status(409).json({
          success: false,
          message: `Cannot transition slot serviceStatus from '${from}' to '${newServiceStatus}'.`,
          code: 'INVALID_STATUS_TRANSITION',
        });
      }

      // Archiving a claimed slot is not allowed
      if (newServiceStatus === 'archived' && isClaimed) {
        return res.status(409).json({
          success: false,
          message: 'Cannot archive a slot with an active booking.',
          code: 'SLOT_CLAIMED',
        });
      }
    }

    // Enforce slot edit restrictions at write time — calculate using original slot state
    const requiresUnclaimed =
      newServiceStatus === 'archived' ||
      Object.keys(fieldEdits).some((k) => ALLOWED_SLOT_WRITE_FIELDS.has(k)) ||
      (newServiceStatus === 'enabled' && from !== 'enabled');

    const updateFilter = { _id: slot._id, location: location._id, serviceStatus: from };
    if (requiresUnclaimed) {
      updateFilter.activeBooking = null;
    }

    const updateSet = {};
    if (newServiceStatus !== undefined) updateSet.serviceStatus = newServiceStatus;
    if (!isClaimed) {
      if (fieldEdits.code !== undefined) updateSet.code = fieldEdits.code;
      if (fieldEdits.zone !== undefined) updateSet.zone = fieldEdits.zone;
      if (fieldEdits.floor !== undefined) updateSet.floor = fieldEdits.floor;
      if (fieldEdits.vehicleType !== undefined) updateSet.vehicleType = fieldEdits.vehicleType;
      if (fieldEdits.pricePerHourPaise !== undefined) updateSet.pricePerHourPaise = fieldEdits.pricePerHourPaise;
      if (fieldEdits.distanceFromEntry !== undefined) updateSet.distanceFromEntry = fieldEdits.distanceFromEntry;
      if (fieldEdits.features !== undefined) {
        updateSet.features = Array.isArray(fieldEdits.features) ? fieldEdits.features : slot.features;
      }
    }

    let updatedSlot;
    try {
      updatedSlot = await ParkingSlot.findOneAndUpdate(
        updateFilter,
        { $set: updateSet },
        { new: true, runValidators: true }
      );
    } catch (saveErr) {
      if (saveErr.code === 11000 || /duplicate key/i.test(saveErr.message)) {
        return res.status(409).json({
          success: false,
          message: 'A slot with this code already exists at this location.',
          code: 'DUPLICATE_SLOT_CODE',
        });
      }
      if (saveErr.name === 'ValidationError') {
        const first = Object.values(saveErr.errors)[0];
        return res.status(400).json({
          success: false,
          message: first ? first.message : 'Validation error.',
          code: 'VALIDATION_ERROR',
        });
      }
      throw saveErr;
    }

    if (!updatedSlot) {
      const currentSlot = await ParkingSlot.findById(slot._id);
      if (currentSlot && currentSlot.activeBooking && requiresUnclaimed) {
        return res.status(409).json({
          success: false,
          message: 'Cannot modify slot fields while slot has an active booking. Only placing slot into maintenance is allowed.',
          code: 'SLOT_CLAIMED',
        });
      }
      if (currentSlot && currentSlot.serviceStatus === 'archived') {
        return res.status(409).json({
          success: false,
          message: 'Archived slots cannot be modified.',
          code: 'SLOT_ARCHIVED_IMMUTABLE',
        });
      }
      return res.status(409).json({
        success: false,
        message: 'Slot update failed due to concurrent modification.',
        code: 'SLOT_CONFLICT',
      });
    }

    return res.status(200).json({
      success: true,
      slot: sanitizeSlotDto(updatedSlot, { includeBookingRef: true }),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update slot.',
      code: 'INTERNAL_ERROR',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — SUMMARY & BOOKINGS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/admin/summary
 * Admin: aggregate counts (not revenue) across all entities.
 */
async function adminSummary(req, res) {
  try {
    const [
      totalLocations,
      draftLocations,
      activeLocations,
      closedLocations,
      archivedLocations,
      totalSlots,
      enabledSlots,
      maintenanceSlots,
      archivedSlots,
      totalUsers,
      totalBookings,
      activeBookings,
      completedBookings,
      cancelledBookings,
    ] = await Promise.all([
      ParkingLocation.countDocuments({}),
      ParkingLocation.countDocuments({ status: 'draft' }),
      ParkingLocation.countDocuments({ status: 'active' }),
      ParkingLocation.countDocuments({ status: 'closed' }),
      ParkingLocation.countDocuments({ status: 'archived' }),
      ParkingSlot.countDocuments({}),
      ParkingSlot.countDocuments({ serviceStatus: 'enabled' }),
      ParkingSlot.countDocuments({ serviceStatus: 'maintenance' }),
      ParkingSlot.countDocuments({ serviceStatus: 'archived' }),
      User.countDocuments({}),
      Booking.countDocuments({}),
      Booking.countDocuments({ status: 'active' }),
      Booking.countDocuments({ status: 'completed' }),
      Booking.countDocuments({ status: 'cancelled' }),
    ]);

    return res.status(200).json({
      success: true,
      summary: {
        locations: {
          total: totalLocations,
          draft: draftLocations,
          active: activeLocations,
          closed: closedLocations,
          archived: archivedLocations,
        },
        slots: {
          total: totalSlots,
          enabled: enabledSlots,
          maintenance: maintenanceSlots,
          archived: archivedSlots,
        },
        users: {
          total: totalUsers,
        },
        bookings: {
          total: totalBookings,
          active: activeBookings,
          completed: completedBookings,
          cancelled: cancelledBookings,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve summary.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * GET /api/admin/bookings
 * Admin: paginated booking list with optional location and status filters.
 * Populates safe user fields only.
 */
async function adminListBookings(req, res) {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { location: locationId, status } = req.query;

    const filter = {};
    const validBookingStatuses = ['active', 'completed', 'cancelled'];

    if (status && validBookingStatuses.includes(status)) {
      filter.status = status;
    }

    if (locationId && typeof locationId === 'string' && locationId.trim()) {
      filter.location = locationId.trim();
    }

    const skip = (page - 1) * limit;
    const [docs, total] = await Promise.all([
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        // Populate only safe user fields — no passwordHash
        .populate('user', 'name email phone role'),
      Booking.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page,
      limit,
      bookings: docs.map(sanitizeBookingForAdmin),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve bookings.',
      code: 'INTERNAL_ERROR',
    });
  }
}

module.exports = {
  // Public
  listPublicLocations,
  getPublicLocation,
  getPublicSlots,
  // Admin — locations
  adminListLocations,
  adminCreateLocation,
  adminUpdateLocation,
  // Admin — slots
  adminListSlots,
  adminCreateSlot,
  adminUpdateSlot,
  // Admin — summary & bookings
  adminSummary,
  adminListBookings,
  // Exported helpers for testing
  sanitizeLocationDto,
  sanitizeSlotDto,
};
