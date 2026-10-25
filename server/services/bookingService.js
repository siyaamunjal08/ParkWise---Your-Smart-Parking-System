// server/services/bookingService.js — Stage 6 Booking Service
// Atomic booking creation, cancellation, expiry reconciliation, and recommendations.
'use strict';

const mongoose = require('mongoose');
const { ParkingLocation, ParkingSlot, Booking } = require('../models');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Allowed booking duration range (integer hours, immediate-only) */
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 24;

/** Expiry reconciler batch size per sweep pass */
const EXPIRY_BATCH_SIZE = 50;

/** Expiry reconciler interval in milliseconds */
const EXPIRY_INTERVAL_MS = 30_000;

/**
 * Vehicle number normalization:
 *   - Trim whitespace, collapse internal runs of spaces to a single space,
 *   - Uppercase all characters.
 *   Result is stored and compared normalized.
 */
function normalizeVehicleNumber(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Validate that the given vehicleType string is an allowed parking type.
 * Must be exactly 'car', 'bike', or 'ev'.
 */
const ALLOWED_VEHICLE_TYPES = new Set(['car', 'bike', 'ev']);

function isValidVehicleType(t) {
  return ALLOWED_VEHICLE_TYPES.has(t);
}

/**
 * Type-compatibility rule (explicit matching, no cross-type booking):
 *   A slot's vehicleType must exactly match the booking's vehicleType.
 *   car -> car only, bike -> bike only, ev -> ev only.
 */
function isTypeCompatible(slotVehicleType, bookingVehicleType) {
  return slotVehicleType === bookingVehicleType;
}

/**
 * Validate a UUID v4 string (case-insensitive).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(s) {
  return typeof s === 'string' && UUID_RE.test(s.trim());
}

// ── Canonical Payload Fingerprint ──────────────────────────────────────────────

/**
 * Produce a deterministic canonical payload key from booking inputs.
 * Used to detect when a requestId is being reused for a different booking.
 *
 * Key fields: locationId, slotId, vehicleNumber (normalized), vehicleType, durationHours.
 * Client-supplied price/startTime/endTime/total are intentionally excluded — they are
 * server-derived and must not influence the idempotency comparison.
 */
function canonicalPayloadKey({ locationId, slotId, vehicleNumber, vehicleType, durationHours }) {
  return JSON.stringify({
    l: locationId,
    s: slotId,
    v: normalizeVehicleNumber(vehicleNumber),
    t: vehicleType,
    d: durationHours,
  });
}

// ── Expiry Reconciler ─────────────────────────────────────────────────────────

/**
 * Reconcile a single batch of expired bookings.
 *
 * For each booking:
 *   1. Open a transaction.
 *   2. Re-check (within transaction) that booking is still active AND endTime has passed.
 *   3. If so: mark booking completed, release slot only when its activeBooking still points
 *      to this booking (conditional CAS -- prevents releasing a later customer's claim).
 *   4. Commit.
 *
 * Supports concurrent workers: the conditional DB logic (not a local flag) prevents
 * two workers from double-releasing the same slot.
 *
 * @param {Date} [asOf] Reference time (defaults to now)
 * @param {number} [batchSize]
 * @returns {Promise<{ processed: number, errors: number }>}
 */
async function reconcileExpiredBatch(asOf, batchSize) {
  const bs = (batchSize !== undefined) ? batchSize : EXPIRY_BATCH_SIZE;
  const now = asOf instanceof Date ? asOf : new Date();
  let processed = 0;
  let errors = 0;

  // Load a bounded batch of bookings that appear expired.
  // We must NOT free slot IDs from this stale read; each individual item is
  // rechecked inside its own transaction before any mutation.
  const candidates = await Booking.find({
    status: 'active',
    endTime: { $lte: now },
  })
    .select('_id slot endTime status')
    .limit(bs)
    .lean();

  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Recheck inside transaction: still active AND still expired
        const booking = await Booking.findOne({
          _id: candidate._id,
          status: 'active',
          endTime: { $lte: now },
        }).session(session);

        if (!booking) {
          // Already processed by another worker or not yet expired -- skip
          return;
        }

        // Complete the booking
        await Booking.updateOne(
          { _id: booking._id, status: 'active' },
          { $set: { status: 'completed' } },
          { session }
        );

        // Release slot only if its activeBooking still points to this booking (CAS)
        await ParkingSlot.updateOne(
          { _id: booking.slot, activeBooking: booking._id },
          { $set: { activeBooking: null } },
          { session }
        );

        processed++;
      });
    } catch (err) {
      errors++;
      if (process.env.NODE_ENV !== 'test') {
        console.error('[BookingService] Expiry reconcile error for booking', candidate._id, ':', err.message);
      }
    } finally {
      await session.endSession();
    }
  }

  return { processed, errors };
}

/**
 * Run full expiry reconciliation (all expired batches until none remain).
 * Safe to call before booking reads/writes to ensure up-to-date slot availability.
 *
 * @param {Date} [asOf]
 * @returns {Promise<{ totalProcessed: number }>}
 */
async function reconcileExpired(asOf) {
  const now = asOf instanceof Date ? asOf : new Date();
  let totalProcessed = 0;

  while (true) { // eslint-disable-line no-constant-condition
    const { processed } = await reconcileExpiredBatch(now, EXPIRY_BATCH_SIZE);
    totalProcessed += processed;
    if (processed < EXPIRY_BATCH_SIZE) break; // Fewer than a full batch -> done
  }

  return { totalProcessed };
}

// ── Background Expiry Scheduler ───────────────────────────────────────────────

let _expiryTimer = null;
let _expiryRunning = false;

/**
 * Start the background expiry sweeper.
 * Runs every EXPIRY_INTERVAL_MS (30 s).
 * Uses a process-level boolean to prevent overlapping scheduled runs.
 * But the DB-level conditional logic (re-check inside transaction) is the
 * true concurrency guard -- this flag merely avoids redundant overlapping runs
 * from the same process.
 */
function startExpirySweeper() {
  if (_expiryTimer) return; // Already running

  async function sweep() {
    if (_expiryRunning) return; // Skip if still running from previous tick
    _expiryRunning = true;
    try {
      await reconcileExpired();
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[BookingService] Expiry sweeper error:', err.message);
      }
    } finally {
      _expiryRunning = false;
    }
  }

  _expiryTimer = setInterval(sweep, EXPIRY_INTERVAL_MS);

  // Don't hold the event loop open just for the sweeper
  if (_expiryTimer.unref) _expiryTimer.unref();
}

/**
 * Stop the background expiry sweeper.
 * Called on graceful shutdown.
 */
function stopExpirySweeper() {
  if (_expiryTimer) {
    clearInterval(_expiryTimer);
    _expiryTimer = null;
  }
}

// ── Create Booking ─────────────────────────────────────────────────────────────

/**
 * Create a new booking atomically.
 *
 * Transaction steps (sequential awaited, no Promise.all inside):
 * 1. Resolve idempotency: return existing result for matching {user, requestId},
 *    or reject reuse for a different canonical payload.
 * 2. Conditionally increment bookingRevision on the location (detect concurrent closure).
 * 3. Claim the slot (conditional update: must be enabled, location match, activeBooking null).
 * 4. Insert the booking with pre-allocated ID.
 *
 * @param {Object} params
 * @param {string} params.userId        -- From authenticated JWT
 * @param {string} params.locationId
 * @param {string} params.slotId
 * @param {string} params.vehicleNumber -- Will be normalized
 * @param {string} params.vehicleType   -- 'car'|'bike'|'ev'
 * @param {number} params.durationHours -- 1-24 integer
 * @param {string} params.requestId     -- UUID v4
 * @returns {Promise<{ booking: Object, isIdempotentRetry: boolean }>}
 * @throws Error with .statusCode and .code on validation/conflict failures
 */
async function createBooking({
  userId,
  locationId,
  slotId,
  vehicleNumber,
  vehicleType,
  durationHours,
  requestId,
}) {
  // ── Pre-transaction validation ────────────────────────────────────────────

  if (!isValidUUID(requestId)) {
    const err = new Error('requestId must be a valid UUID v4.');
    err.statusCode = 400;
    err.code = 'INVALID_REQUEST_ID';
    throw err;
  }

  const normalizedVehicleNumber = normalizeVehicleNumber(vehicleNumber);
  if (!normalizedVehicleNumber) {
    const err = new Error('vehicleNumber is required.');
    err.statusCode = 400;
    err.code = 'INVALID_VEHICLE_NUMBER';
    throw err;
  }

  if (!isValidVehicleType(vehicleType)) {
    const err = new Error('vehicleType must be one of: car, bike, ev.');
    err.statusCode = 400;
    err.code = 'INVALID_VEHICLE_TYPE';
    throw err;
  }

  const durInt = Number(durationHours);
  if (!Number.isInteger(durInt) || durInt < MIN_DURATION_HOURS || durInt > MAX_DURATION_HOURS) {
    const err = new Error(`durationHours must be an integer between ${MIN_DURATION_HOURS} and ${MAX_DURATION_HOURS}.`);
    err.statusCode = 400;
    err.code = 'INVALID_DURATION';
    throw err;
  }

  // Canonical payload key for idempotency comparison
  const targetPayloadKey = canonicalPayloadKey({
    locationId: String(locationId).trim(),
    slotId: String(slotId).trim(),
    vehicleNumber: normalizedVehicleNumber,
    vehicleType,
    durationHours: durInt,
  });

  // ── Step 1: Pre-availability idempotency resolution ───────────────────────
  // Resolve existing {user, requestId} BEFORE rejecting based on current
  // location closure, slot maintenance, or booking cancellation/completion.
  const existingPre = await Booking.findOne({
    user: userId,
    requestId: requestId.trim(),
  }).lean();

  if (existingPre) {
    const existingKey = canonicalPayloadKey({
      locationId: existingPre.location.toString(),
      slotId: existingPre.slot.toString(),
      vehicleNumber: existingPre.vehicle.registrationNumber,
      vehicleType: existingPre.vehicle.type,
      durationHours: existingPre.durationHours,
    });

    if (existingKey !== targetPayloadKey) {
      const err = new Error('requestId is already in use for a different booking request. Use a new requestId.');
      err.statusCode = 409;
      err.code = 'REQUEST_ID_REUSED';
      throw err;
    }

    return { booking: existingPre, isIdempotentRetry: true };
  }

  // Reconcile expired bookings before checking availability
  await reconcileExpired();

  // ── Pre-transaction fast validation for new requests ──────────────────────
  let location;
  try {
    location = await ParkingLocation.findById(locationId).lean();
  } catch {
    const err = new Error('Location not found.');
    err.statusCode = 404;
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (!location) {
    const err = new Error('Location not found.');
    err.statusCode = 404;
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (location.status !== 'active') {
    const err = new Error('Location is not accepting bookings.');
    err.statusCode = 409;
    err.code = 'LOCATION_NOT_ACTIVE';
    throw err;
  }

  let slot;
  try {
    slot = await ParkingSlot.findOne({
      _id: slotId,
      location: location._id,
    }).lean();
  } catch {
    const err = new Error('Slot not found at this location.');
    err.statusCode = 404;
    err.code = 'SLOT_NOT_FOUND';
    throw err;
  }
  if (!slot) {
    const err = new Error('Slot not found at this location.');
    err.statusCode = 404;
    err.code = 'SLOT_NOT_FOUND';
    throw err;
  }
  if (slot.serviceStatus !== 'enabled') {
    const err = new Error('Slot is not available for booking.');
    err.statusCode = 409;
    err.code = 'SLOT_NOT_ENABLED';
    throw err;
  }

  if (!isTypeCompatible(slot.vehicleType, vehicleType)) {
    const err = new Error(
      'This slot accepts ' + slot.vehicleType + ' vehicles only; you requested ' + vehicleType + '.'
    );
    err.statusCode = 409;
    err.code = 'VEHICLE_TYPE_MISMATCH';
    throw err;
  }

  // Pre-allocate booking ID for conditional claim
  const bookingId = new mongoose.Types.ObjectId();

  // ── Transaction ───────────────────────────────────────────────────────────
  let finalBooking = null;
  let isIdempotentRetry = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 1. Transaction-level idempotency check (resolves concurrent identical/changed requests)
      const existingTx = await Booking.findOne({
        user: userId,
        requestId: requestId.trim(),
      }).session(session);

      if (existingTx) {
        const existingKey = canonicalPayloadKey({
          locationId: existingTx.location.toString(),
          slotId: existingTx.slot.toString(),
          vehicleNumber: existingTx.vehicle.registrationNumber,
          vehicleType: existingTx.vehicle.type,
          durationHours: existingTx.durationHours,
        });

        if (existingKey !== targetPayloadKey) {
          const err = new Error('requestId is already in use for a different booking request. Use a new requestId.');
          err.statusCode = 409;
          err.code = 'REQUEST_ID_REUSED';
          throw err;
        }

        finalBooking = existingTx;
        isIdempotentRetry = true;
        return;
      }

      // 2. Conditionally increment bookingRevision on the ACTIVE location
      const locResult = await ParkingLocation.findOneAndUpdate(
        { _id: locationId, status: 'active' },
        { $inc: { bookingRevision: 1 } },
        { new: true, session }
      );

      if (!locResult) {
        const locExists = await ParkingLocation.findById(locationId).session(session);
        if (!locExists) {
          const err = new Error('Location not found.');
          err.statusCode = 404;
          err.code = 'LOCATION_NOT_FOUND';
          throw err;
        }
        const err = new Error('Location is not accepting bookings.');
        err.statusCode = 409;
        err.code = 'LOCATION_NOT_ACTIVE';
        throw err;
      }

      // 3. Atomically claim the slot inside the transaction
      const claimedSlot = await ParkingSlot.findOneAndUpdate(
        {
          _id: slotId,
          location: locResult._id,
          serviceStatus: 'enabled',
          activeBooking: null,
        },
        { $set: { activeBooking: bookingId } },
        { new: true, session }
      );

      if (!claimedSlot) {
        const existingSlot = await ParkingSlot.findById(slotId).session(session);
        if (!existingSlot || existingSlot.location.toString() !== locResult._id.toString()) {
          const err = new Error('Slot not found at this location.');
          err.statusCode = 404;
          err.code = 'SLOT_NOT_FOUND';
          throw err;
        }
        if (existingSlot.serviceStatus !== 'enabled') {
          const err = new Error('Slot is not available for booking.');
          err.statusCode = 409;
          err.code = 'SLOT_NOT_ENABLED';
          throw err;
        }
        const err = new Error('Slot is no longer available.');
        err.statusCode = 409;
        err.code = 'SLOT_UNAVAILABLE';
        throw err;
      }

      // 4. Validate vehicle compatibility on claimed slot document (inside-tx authoritative)
      if (!isTypeCompatible(claimedSlot.vehicleType, vehicleType)) {
        const err = new Error(
          'This slot accepts ' + claimedSlot.vehicleType + ' vehicles only; you requested ' + vehicleType + '.'
        );
        err.statusCode = 409;
        err.code = 'VEHICLE_TYPE_MISMATCH';
        throw err;
      }

      // 5. Compute booking times inside transaction attempt
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + durInt * 3600 * 1000);

      // 6. Validate monetary calculations as safe, non-negative integers
      const pricePerHourPaise = claimedSlot.pricePerHourPaise;
      if (!Number.isSafeInteger(pricePerHourPaise) || pricePerHourPaise < 0) {
        const err = new Error('Invalid slot price.');
        err.statusCode = 500;
        err.code = 'INVALID_PRICE';
        throw err;
      }

      const totalPaise = pricePerHourPaise * durInt;
      if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) {
        const err = new Error('Calculated total exceeds safe integer limits.');
        err.statusCode = 400;
        err.code = 'CALCULATION_OVERFLOW';
        throw err;
      }

      // 7. Insert the booking with inside-transaction derived snapshots
      let newBooking;
      try {
        [newBooking] = await Booking.create(
          [
            {
              _id: bookingId,
              user: userId,
              location: locResult._id,
              slot: claimedSlot._id,
              vehicle: {
                registrationNumber: normalizedVehicleNumber,
                type: vehicleType,
                label: '',
              },
              locationName: locResult.name,
              slotCode: claimedSlot.code,
              pricePerHourPaise,
              startTime,
              endTime,
              durationHours: durInt,
              totalPaise,
              status: 'active',
              requestId: requestId.trim(),
            },
          ],
          { session }
        );
      } catch (insertErr) {
        throw insertErr;
      }

      finalBooking = newBooking;
    });
  } catch (err) {
    // Re-throw application errors with statusCode as-is
    if (err.statusCode) throw err;

    // MongoDB duplicate key on unique active-slot or requestId index
    if (err.code === 11000 || /duplicate key/i.test(err.message)) {
      const errStr = err.message || '';
      if (/requestId|user.*requestId/i.test(errStr)) {
        const race = await Booking.findOne({ user: userId, requestId: requestId.trim() });
        if (race) {
          const raceKey = canonicalPayloadKey({
            locationId: race.location.toString(),
            slotId: race.slot.toString(),
            vehicleNumber: race.vehicle.registrationNumber,
            vehicleType: race.vehicle.type,
            durationHours: race.durationHours,
          });

          if (raceKey !== targetPayloadKey) {
            const reErr = new Error('requestId is already in use for a different booking request. Use a new requestId.');
            reErr.statusCode = 409;
            reErr.code = 'REQUEST_ID_REUSED';
            throw reErr;
          }

          finalBooking = race;
          isIdempotentRetry = true;
          return { booking: finalBooking, isIdempotentRetry };
        }
      }

      const conflict = new Error('Slot is no longer available.');
      conflict.statusCode = 409;
      conflict.code = 'SLOT_UNAVAILABLE';
      throw conflict;
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }

  return { booking: finalBooking, isIdempotentRetry };
}

// ── Cancel Booking ─────────────────────────────────────────────────────────────

/**
 * Cancel an active booking owned by the given user.
 *
 * Rules:
 * - Only the booking owner can cancel (no foreign cancellation).
 * - If the booking has already expired (endTime <= now), complete it rather than cancel it.
 * - The slot is released only when its activeBooking still matches this booking (CAS).
 * - Repeated cancel calls on an already-cancelled/completed booking return the current state.
 * - Bookings are never deleted; history is always preserved.
 *
 * @param {string} bookingId
 * @param {string} userId
 * @returns {Promise<{ booking: Object }>}
 */
async function cancelBooking(bookingId, userId) {
  // Reconcile expired before checking booking state
  await reconcileExpired();

  // Load the booking -- must be owned by this user
  let booking;
  try {
    booking = await Booking.findOne({ _id: bookingId, user: userId });
  } catch {
    const err = new Error('Booking not found.');
    err.statusCode = 404;
    err.code = 'BOOKING_NOT_FOUND';
    throw err;
  }
  if (!booking) {
    const err = new Error('Booking not found.');
    err.statusCode = 404;
    err.code = 'BOOKING_NOT_FOUND';
    throw err;
  }

  // Already settled -- return current state without error
  if (booking.status === 'cancelled' || booking.status === 'completed') {
    return { booking };
  }

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-load inside transaction to get latest state
      const fresh = await Booking.findOne({
        _id: booking._id,
        user: userId,
      }).session(session);

      if (!fresh) {
        const err = new Error('Booking not found.');
        err.statusCode = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }

      // Already settled -- nothing to do
      if (fresh.status !== 'active') {
        booking = fresh;
        return;
      }

      // Determine new status: expired bookings are completed, not cancelled
      const newStatus = fresh.endTime <= now ? 'completed' : 'cancelled';

      await Booking.updateOne(
        { _id: fresh._id, status: 'active' },
        { $set: { status: newStatus } },
        { session }
      );

      // Release slot claim only if it still points to this booking (CAS prevents stale release)
      await ParkingSlot.updateOne(
        { _id: fresh.slot, activeBooking: fresh._id },
        { $set: { activeBooking: null } },
        { session }
      );

      fresh.status = newStatus;
      booking = fresh;
    });
  } finally {
    await session.endSession();
  }

  return { booking };
}

// ── Recommendations ────────────────────────────────────────────────────────────

/**
 * Get up to 3 slot recommendations for an active public location.
 *
 * Process:
 * 1. Reconcile expired bookings.
 * 2. Verify location is public-visible and active.
 * 3. Query only compatible (matching vehicleType), enabled, unclaimed slots.
 * 4. Apply optional filters (vehicleType, maxPricePerHourPaise, zone).
 * 5. Rank by composite score (documented below), stable tie-break by slot code.
 * 6. Return up to 3 with short reason strings.
 *
 * Ranking rule (documented, simple, deterministic -- not ML/AI):
 *   score = priceFactor * 0.5 + distanceFactor * 0.3 + featureBonus * 0.2
 *
 *   priceFactor    = 1 - (slotPrice / maxPriceInSet)   (lower price -> higher score)
 *   distanceFactor = 1 - (slotDist / maxDistInSet)     (closer -> higher score)
 *   featureBonus   = number of features / 5            (capped at 1.0)
 *
 *   Tie-break: ascending slot code (lexicographic, stable).
 *
 * @param {string} locationId
 * @param {Object} filters
 * @param {string} [filters.vehicleType]          -- Filter to a specific type
 * @param {number} [filters.maxPricePerHourPaise] -- Upper price bound
 * @param {string} [filters.zone]                 -- Zone filter
 * @returns {Promise<{ recommendations: Array }>}
 */
async function getRecommendations(locationId, filters) {
  const safeFilters = filters || {};
  // Reconcile before availability read
  await reconcileExpired();

  // Verify location
  let location;
  try {
    location = await ParkingLocation.findById(locationId).lean();
  } catch {
    const err = new Error('Location not found.');
    err.statusCode = 404;
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (!location || location.status === 'draft' || location.status === 'archived') {
    const err = new Error('Location not found.');
    err.statusCode = 404;
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (location.status !== 'active') {
    const err = new Error('Location is not currently accepting bookings.');
    err.statusCode = 409;
    err.code = 'LOCATION_NOT_ACTIVE';
    throw err;
  }

  // Build query for compatible, enabled, unclaimed slots
  const query = {
    location: location._id,
    serviceStatus: 'enabled',
    activeBooking: null,
  };

  // Apply filters
  const { vehicleType, maxPricePerHourPaise, zone } = safeFilters;
  if (vehicleType && ALLOWED_VEHICLE_TYPES.has(vehicleType)) {
    query.vehicleType = vehicleType;
  }
  if (maxPricePerHourPaise !== undefined && Number.isFinite(Number(maxPricePerHourPaise))) {
    query.pricePerHourPaise = { $lte: Math.floor(Number(maxPricePerHourPaise)) };
  }
  if (zone && typeof zone === 'string' && zone.trim()) {
    query.zone = zone.trim().toUpperCase();
  }

  const slots = await ParkingSlot.find(query).lean();

  if (slots.length === 0) {
    return { recommendations: [] };
  }

  // Compute ranking factors
  const maxPrice = Math.max(...slots.map((s) => s.pricePerHourPaise), 1);
  const maxDist = Math.max(...slots.map((s) => s.distanceFromEntry), 1);

  const scored = slots.map((s) => {
    const priceFactor = maxPrice > 0 ? 1 - s.pricePerHourPaise / maxPrice : 1;
    const distanceFactor = maxDist > 0 ? 1 - s.distanceFromEntry / maxDist : 1;
    const featureBonus = Math.min((s.features || []).length / 5, 1.0);
    const score = priceFactor * 0.5 + distanceFactor * 0.3 + featureBonus * 0.2;
    return { slot: s, score };
  });

  // Sort: descending score, tie-break ascending slot code
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slot.code < b.slot.code ? -1 : a.slot.code > b.slot.code ? 1 : 0;
  });

  const top3 = scored.slice(0, 3);

  const recommendations = top3.map(({ slot, score }) => {
    // Generate a short human-readable reason
    const reasons = [];
    const priceRupeesPerHour = (slot.pricePerHourPaise / 100).toFixed(2);
    reasons.push('Rs.' + priceRupeesPerHour + '/hr');
    if (slot.distanceFromEntry <= 20) {
      reasons.push('close to entry');
    }
    if ((slot.features || []).length > 0) {
      reasons.push(slot.features.slice(0, 2).join(', '));
    }

    return {
      id: slot._id.toString(),
      location: slot.location.toString(),
      code: slot.code,
      zone: slot.zone,
      floor: slot.floor,
      vehicleType: slot.vehicleType,
      pricePerHourPaise: slot.pricePerHourPaise,
      distanceFromEntry: slot.distanceFromEntry,
      features: slot.features || [],
      serviceStatus: slot.serviceStatus,
      available: true,
      score: Math.round(score * 10000) / 10000,
      reason: reasons.join(' - '),
    };
  });

  return { recommendations };
}

// ── DTO Helpers ───────────────────────────────────────────────────────────────

/**
 * Produce a safe booking DTO for the booking owner (no admin fields).
 */
function sanitizeBookingDto(doc) {
  if (!doc) return null;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  return {
    id: (raw._id || raw.id || '').toString(),
    location: raw.location ? raw.location.toString() : null,
    locationName: raw.locationName,
    slot: raw.slot ? raw.slot.toString() : null,
    slotCode: raw.slotCode,
    vehicle: {
      registrationNumber: raw.vehicle ? raw.vehicle.registrationNumber : null,
      type: raw.vehicle ? raw.vehicle.type : null,
    },
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

module.exports = {
  // Core operations
  createBooking,
  cancelBooking,
  getRecommendations,
  // Expiry
  reconcileExpired,
  reconcileExpiredBatch,
  startExpirySweeper,
  stopExpirySweeper,
  // DTO
  sanitizeBookingDto,
  // Validation helpers (exported for tests)
  normalizeVehicleNumber,
  isValidVehicleType,
  isTypeCompatible,
  isValidUUID,
  canonicalPayloadKey,
  // Constants
  MIN_DURATION_HOURS,
  MAX_DURATION_HOURS,
  EXPIRY_BATCH_SIZE,
};
