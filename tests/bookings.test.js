// tests/bookings.test.js â€” Stage 6 Booking Service Integration Tests
// Real integration tests against a guarded replica-set TEST DB.
// Uses Promise.all ONLY at the HTTP level (concurrent requests), never inside transactions.
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const app = require('../server/app');
const { User, ParkingLocation, ParkingSlot, Booking } = require('../server/models');
const { connectDB, disconnectDB } = require('../server/config/db');
const { validateDatabaseConfig } = require('../server/config/env');
const { hashPassword, generateToken } = require('../server/utils/authUtils');
const { getJwtConfig } = require('../server/config/env');
const { reconcileExpiredBatch } = require('../server/services/bookingService');

test.describe('Stage 6: Booking Service & Concurrency', () => {
  let server;
  let baseUrl;

  const testRunId = `s6-${Date.now()}`;
  const createdLocationIds = [];
  const createdSlotIds = [];
  const createdUserIds = [];
  const createdBookingIds = [];

  let user1, user1Token;
  let user2, user2Token;
  let adminUser, adminToken;

  // â”€â”€ Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test.before(async () => {
    // Enforce test DB isolation
    const config = validateDatabaseConfig({ isTest: true });
    assert.ok(config.testDbName, 'Tests must target an explicit test database');
    assert.notEqual(
      config.testDbName.toLowerCase(),
      (config.appDbName || '').toLowerCase(),
      'Stage 6 tests refused: test database cannot match application database'
    );

    await connectDB({ isTest: true });
    await Promise.all([
      User.init(),
      ParkingLocation.init(),
      ParkingSlot.init(),
      Booking.init(),
    ]);

    // Admin user
    const adminPwHash = await hashPassword('AdminPass@123');
    adminUser = await User.create({
      name: 'Stage6 Admin',
      email: `s6-admin-${testRunId}@example.com`,
      phone: '+91 90000 60001',
      passwordHash: adminPwHash,
      role: 'admin',
    });
    createdUserIds.push(adminUser._id);
    adminToken = generateToken(adminUser, getJwtConfig());

    // User 1
    const u1Hash = await hashPassword('UserPass@123');
    user1 = await User.create({
      name: 'Stage6 User1',
      email: `s6-user1-${testRunId}@example.com`,
      phone: '+91 90000 60002',
      passwordHash: u1Hash,
      role: 'user',
    });
    createdUserIds.push(user1._id);
    user1Token = generateToken(user1, getJwtConfig());

    // User 2
    const u2Hash = await hashPassword('UserPass@123');
    user2 = await User.create({
      name: 'Stage6 User2',
      email: `s6-user2-${testRunId}@example.com`,
      phone: '+91 90000 60003',
      passwordHash: u2Hash,
      role: 'user',
    });
    createdUserIds.push(user2._id);
    user2Token = generateToken(user2, getJwtConfig());

    // Start ephemeral server
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  // â”€â”€ Teardown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test.after(async () => {
    try {
      if (createdBookingIds.length > 0) {
        await Booking.deleteMany({ _id: { $in: createdBookingIds } });
      }
      if (createdSlotIds.length > 0) {
        await ParkingSlot.deleteMany({ _id: { $in: createdSlotIds } });
      }
      if (createdLocationIds.length > 0) {
        await ParkingSlot.deleteMany({ location: { $in: createdLocationIds } });
        await ParkingLocation.deleteMany({ _id: { $in: createdLocationIds } });
      }
      if (createdUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
      }
    } finally {
      if (server) await new Promise((r) => server.close(r));
      await disconnectDB();
    }
  });

  // â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function apiAdmin(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    return { res, data: await res.json() };
  }

  async function apiUser(method, path, body, token) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    return { res, data: await res.json() };
  }

  async function apiPublic(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    return { res, data: await res.json() };
  }

  // Create and publish a location, return { locationId }
  async function createActiveLocation(overrides) {
    const defaults = {
      name: `S6 Loc ${testRunId} ${Math.random().toString(36).slice(2)}`,
      category: 'mall',
      address: '1 Test Street',
      city: 'Mumbai',
      area: 'Andheri',
      latitude: 19.1,
      longitude: 72.8,
    };
    const { data: locData } = await apiAdmin('POST', '/api/admin/locations', { ...defaults, ...overrides });
    const locId = locData.location.id;
    createdLocationIds.push(locId);
    return locId;
  }

  // Create a slot and return { slotId }
  async function createSlot(locationId, overrides) {
    const defaults = {
      code: `SL-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      zone: 'A',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      distanceFromEntry: 10,
    };
    const { data: slotData } = await apiAdmin('POST', `/api/admin/locations/${locationId}/slots`, {
      ...defaults,
      ...overrides,
    });
    const slotId = slotData.slot.id;
    createdSlotIds.push(slotId);
    return slotId;
  }

  // Publish a location (draft -> active)
  async function publishLocation(locId) {
    await apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'active' });
  }

  // Create a booking via HTTP
  async function bookSlot(token, locationId, slotId, overrides) {
    const defaults = {
      locationId,
      slotId,
      vehicleNumber: 'MH12AB1234',
      vehicleType: 'car',
      durationHours: 1,
      requestId: randomUUID(),
    };
    return apiUser('POST', '/api/bookings', { ...defaults, ...overrides }, token);
  }

  // Mark a booking slot as freed directly in DB (for expired test fixtures)
  async function forceExpireBooking(bookingId, draftDate) {
    const past = draftDate || new Date(Date.now() - 10_000); // 10 seconds ago
    await Booking.updateOne({ _id: bookingId }, { $set: { endTime: past, startTime: new Date(past.getTime() - 3600_000) } });
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 1. Input Validation
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('1.1. Rejects request with server-derived fields (price/status/startTime)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    const forbiddenCombos = [
      { pricePerHourPaise: 100 },
      { status: 'active' },
      { startTime: new Date().toISOString() },
      { endTime: new Date().toISOString() },
      { totalPaise: 100 },
      { user: 'fake-user-id' },
    ];

    for (const forbidden of forbiddenCombos) {
      const { res } = await apiUser('POST', '/api/bookings', {
        locationId: locId, slotId, vehicleNumber: 'MH01A1234',
        vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
        ...forbidden,
      }, user1Token);
      assert.equal(res.status, 400, `Must reject field: ${JSON.stringify(forbidden)}`);
    }
  });

  test.it('1.2. Rejects invalid vehicleType', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    const { res, data } = await bookSlot(user1Token, locId, slotId, { vehicleType: 'truck' });
    assert.equal(res.status, 400);
    assert.equal(data.code, 'INVALID_VEHICLE_TYPE');
  });

  test.it('1.3. Rejects durationHours out of range', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    for (const dur of [0, 25, -1, 1.5, 'abc']) {
      const { res } = await bookSlot(user1Token, locId, slotId, { durationHours: dur });
      assert.equal(res.status, 400, `durationHours=${dur} must be rejected`);
    }
  });

  test.it('1.4. Rejects invalid requestId (not UUID v4)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    const { res, data } = await bookSlot(user1Token, locId, slotId, { requestId: 'not-a-uuid' });
    assert.equal(res.status, 400);
    assert.equal(data.code, 'INVALID_REQUEST_ID');
  });

  test.it('1.5. Rejects wrong vehicleType for slot (type mismatch)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'bike' });
    await publishLocation(locId);

    const { res, data } = await bookSlot(user1Token, locId, slotId, { vehicleType: 'car' });
    assert.equal(res.status, 409);
    assert.equal(data.code, 'VEHICLE_TYPE_MISMATCH');
  });

  test.it('1.6. Rejects booking for slot not belonging to specified location', async () => {
    const locA = await createActiveLocation();
    const locB = await createActiveLocation();
    const slotA = await createSlot(locA, { vehicleType: 'car' });
    await createSlot(locB, { vehicleType: 'car' });
    await publishLocation(locA);
    await publishLocation(locB);

    // Try to book slotA using locB's ID
    const { res, data } = await bookSlot(user1Token, locB, slotA, { vehicleType: 'car' });
    assert.equal(res.status, 404);
    assert.equal(data.code, 'SLOT_NOT_FOUND');
  });

  test.it('1.7. Rejects booking for inactive (draft) location', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    // Don't publish â€” stays draft

    const { res, data } = await bookSlot(user1Token, locId, slotId, { vehicleType: 'car' });
    assert.equal(res.status, 409);
    assert.equal(data.code, 'LOCATION_NOT_ACTIVE');
  });

  test.it('1.8. Rejects unauthenticated booking creation', async () => {
    const { res } = await apiPublic('POST', '/api/bookings', {
      locationId: 'fake', slotId: 'fake', vehicleNumber: 'MH01A1234',
      vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(res.status, 401);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 2. Successful Booking Creation
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('2.1. Successful booking returns 201 with server-derived fields only', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car', pricePerHourPaise: 5000 });
    await publishLocation(locId);

    const { res, data } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH12XY9999',
      vehicleType: 'car',
      durationHours: 2,
    });
    assert.equal(res.status, 201, 'Must return 201 on first booking');
    assert.equal(data.success, true);

    const b = data.booking;
    assert.ok(b.id, 'Must have booking ID');
    assert.ok(b.startTime, 'Must have server-derived startTime');
    assert.ok(b.endTime, 'Must have server-derived endTime');
    assert.equal(b.totalPaise, 10000, 'totalPaise = 5000 * 2 = 10000');
    assert.equal(b.durationHours, 2);
    assert.equal(b.status, 'active');
    assert.equal(b.vehicle.registrationNumber, 'MH12XY9999');
    assert.ok(data.serverTime, 'Response must include serverTime');

    // Verify slot is claimed in DB
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(slot.activeBooking.toString(), b.id, 'Slot must be claimed with this booking ID');

    createdBookingIds.push(b.id);
  });

  test.it('2.2. Vehicle number is normalized (trimmed and uppercased)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    const { res, data } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: '  mh 01 ab 1111  ',
      vehicleType: 'car',
    });
    assert.equal(res.status, 201);
    assert.equal(data.booking.vehicle.registrationNumber, 'MH 01 AB 1111');
    createdBookingIds.push(data.booking.id);
  });

  test.it('2.3. Server rejects client-supplied price; total is always server-computed', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car', pricePerHourPaise: 5000 });
    await publishLocation(locId);

    // Client tries to inject price; should be rejected with 400
    const { res } = await apiUser('POST', '/api/bookings', {
      locationId: locId, slotId, vehicleNumber: 'MH01A0001',
      vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      pricePerHourPaise: 1,
    }, user1Token);
    assert.equal(res.status, 400);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 3. Idempotency & RequestId
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('3.1. Identical requestId retry returns 200 with same booking (no duplicate)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();
    const payload = { vehicleNumber: 'MH12AB2222', vehicleType: 'car', durationHours: 1, requestId: reqId };

    const { res: r1, data: d1 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r1.status, 201, 'First request must return 201');
    createdBookingIds.push(d1.booking.id);

    const { res: r2, data: d2 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r2.status, 200, 'Retry must return 200');
    assert.equal(d2.idempotentRetry, true);
    assert.equal(d2.booking.id, d1.booking.id, 'Must be the same booking ID');

    // Verify only one active booking for this slot
    const activeCount = await Booking.countDocuments({ slot: slotId, status: 'active' });
    assert.equal(activeCount, 1, 'Exactly one active booking must exist');
  });

  test.it('3.2. RequestId reuse with different payload is rejected', async () => {
    const locId = await createActiveLocation();
    const slotA = await createSlot(locId, { code: 'RID-A', vehicleType: 'car' });
    const slotB = await createSlot(locId, { code: 'RID-B', vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();

    // First booking on slotA
    const { res: r1, data: d1 } = await bookSlot(user1Token, locId, slotA, {
      vehicleNumber: 'MH01RIDA00', vehicleType: 'car', durationHours: 1, requestId: reqId,
    });
    assert.equal(r1.status, 201);
    createdBookingIds.push(d1.booking.id);

    // Attempt to reuse same requestId for slotB (different payload)
    const { res: r2, data: d2 } = await bookSlot(user1Token, locId, slotB, {
      vehicleNumber: 'MH01RIDB00', vehicleType: 'car', durationHours: 1, requestId: reqId,
    });
    assert.equal(r2.status, 409, 'Payload mismatch must be rejected');
    assert.equal(d2.code, 'REQUEST_ID_REUSED');
  });

  test.it('3.3. Same vehicle number display code in different locations is independent (no cross-location conflict)', async () => {
    const locA = await createActiveLocation();
    const locB = await createActiveLocation();
    const slotA = await createSlot(locA, { code: 'A-01', vehicleType: 'car' });
    const slotB = await createSlot(locB, { code: 'A-01', vehicleType: 'car' });
    await publishLocation(locA);
    await publishLocation(locB);

    const vn = 'MH12CROSS1';

    const { res: r1, data: d1 } = await bookSlot(user1Token, locA, slotA, {
      vehicleNumber: vn, vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(r1.status, 201, 'Booking at locA must succeed');
    createdBookingIds.push(d1.booking.id);

    // User2 books same slot code at locB â€” completely independent
    const { res: r2, data: d2 } = await bookSlot(user2Token, locB, slotB, {
      vehicleNumber: vn, vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(r2.status, 201, 'Booking at locB must also succeed independently');
    createdBookingIds.push(d2.booking.id);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 4. Concurrency â€” Two users racing for one slot
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('4.1. Concurrent requests â€” exactly 1x201 and 1x409, exactly 1 active booking', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'RACE-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Fire two simultaneous requests (Promise.all at HTTP level, not inside a transaction)
    const [r1, r2] = await Promise.all([
      bookSlot(user1Token, locId, slotId, {
        vehicleNumber: 'MH01RACE01', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      }),
      bookSlot(user2Token, locId, slotId, {
        vehicleNumber: 'MH01RACE02', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      }),
    ]);

    const statuses = [r1.res.status, r2.res.status].sort();
    assert.deepEqual(statuses, [201, 409], 'Must have exactly one 201 and one 409');

    // Check which one succeeded
    const winner = r1.res.status === 201 ? r1 : r2;
    const loser  = r1.res.status === 409 ? r1 : r2;

    assert.equal(winner.data.success, true);
    assert.equal(loser.data.code, 'SLOT_UNAVAILABLE');

    // Exactly one active booking in the DB
    const activeCount = await Booking.countDocuments({ slot: slotId, status: 'active' });
    assert.equal(activeCount, 1, 'Exactly one active booking must exist after concurrent race');

    // Slot's activeBooking must point to the winning booking
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(
      slot.activeBooking.toString(),
      winner.data.booking.id,
      'Slot activeBooking must match the winning booking'
    );

    createdBookingIds.push(winner.data.booking.id);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 5. GET /api/bookings/me
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('5.1. GET /api/bookings/me returns only caller\'s bookings', async () => {
    const locId = await createActiveLocation();
    const s1 = await createSlot(locId, { code: 'ME-01', vehicleType: 'car' });
    const s2 = await createSlot(locId, { code: 'ME-02', vehicleType: 'car' });
    await publishLocation(locId);

    // User1 books slot1
    const { data: b1 } = await bookSlot(user1Token, locId, s1, {
      vehicleNumber: 'MH01ME0001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    createdBookingIds.push(b1.booking.id);

    // User2 books slot2
    const { data: b2 } = await bookSlot(user2Token, locId, s2, {
      vehicleNumber: 'MH01ME0002', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    createdBookingIds.push(b2.booking.id);

    // User1's list must include only user1's booking
    const { res, data } = await apiUser('GET', '/api/bookings/me', null, user1Token);
    assert.equal(res.status, 200);
    assert.ok(data.serverTime, 'Must include serverTime');
    const ids = data.bookings.map((b) => b.id);
    assert.ok(ids.includes(b1.booking.id), 'User1\'s booking must be in their list');
    assert.ok(!ids.includes(b2.booking.id), 'User2\'s booking must NOT be in user1\'s list');
  });

  test.it('5.2. GET /api/bookings/me supports status filter', async () => {
    const { res, data } = await apiUser('GET', '/api/bookings/me?status=active', null, user1Token);
    assert.equal(res.status, 200);
    for (const b of data.bookings) {
      assert.equal(b.status, 'active', 'Filtered bookings must all have active status');
    }
  });

  test.it('5.3. GET /api/bookings/me requires authentication', async () => {
    const { res } = await apiPublic('GET', '/api/bookings/me');
    assert.equal(res.status, 401);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 6. Cancellation
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('6.1. Owner can cancel an active booking; slot is released', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'CANCEL-01', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01CAN001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    // Cancel
    const { res, data } = await apiUser('PATCH', `/api/bookings/${bookingId}/cancel`, null, user1Token);
    assert.equal(res.status, 200);
    assert.equal(data.booking.status, 'cancelled');
    assert.ok(data.serverTime);

    // Verify slot is released
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(slot.activeBooking, null, 'Slot must be released after cancellation');
  });

  test.it('6.2. Foreign cancellation is rejected (user cannot cancel another user\'s booking)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'FOREIGN-01', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01FOR001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    // User2 tries to cancel user1's booking
    const { res, data } = await apiUser('PATCH', `/api/bookings/${bookingId}/cancel`, null, user2Token);
    assert.equal(res.status, 404, 'Foreign cancel must return 404, not 403, to avoid disclosure');
    assert.equal(data.code, 'BOOKING_NOT_FOUND');

    // Booking must still be active
    const booking = await Booking.findById(bookingId).lean();
    assert.equal(booking.status, 'active', 'Booking must still be active after foreign cancel attempt');
  });

  test.it('6.3. Repeated cancellation is idempotent â€” does not release a later customer\'s claim', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'RCANCEL-01', vehicleType: 'car' });
    await publishLocation(locId);

    // User1 books
    const { data: b1d } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01RC0001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const b1Id = b1d.booking.id;
    createdBookingIds.push(b1Id);

    // User1 cancels
    await apiUser('PATCH', `/api/bookings/${b1Id}/cancel`, null, user1Token);

    // User2 now books the same slot
    const { data: b2d } = await bookSlot(user2Token, locId, slotId, {
      vehicleNumber: 'MH01RC0002', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(b2d.booking ? b2d.booking.status : null, 'active', 'User2 booking must succeed');
    const b2Id = b2d.booking.id;
    createdBookingIds.push(b2Id);

    // User1 tries to cancel their already-cancelled booking again
    const { res: r2 } = await apiUser('PATCH', `/api/bookings/${b1Id}/cancel`, null, user1Token);
    assert.equal(r2.status, 200, 'Repeated cancel must be idempotent');

    // Slot must still belong to user2's booking (not released by user1's stale cancel)
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(
      slot.activeBooking.toString(),
      b2Id,
      'Slot must still be claimed by user2 after user1\'s repeated cancel'
    );
  });

  test.it('6.4. Cancellation requires authentication', async () => {
    const { res } = await apiPublic('PATCH', '/api/bookings/fakeid/cancel');
    assert.equal(res.status, 401);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 7. Expiry Reconciliation
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('7.1. Expired booking is completed by reconciler; slot is released', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'EXP-01', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01EXP001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    // Force the booking to appear expired in the test DB (expired test fixture â€” test DB only)
    await forceExpireBooking(bookingId);

    // Run reconciler
    const { processed } = await reconcileExpiredBatch(new Date(), 50);
    assert.ok(processed >= 1, 'Reconciler must process at least 1 expired booking');

    // Booking must be completed
    const booking = await Booking.findById(bookingId).lean();
    assert.equal(booking.status, 'completed', 'Expired booking must be marked completed');

    // Slot must be released
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(slot.activeBooking, null, 'Slot must be released after expiry');
  });

  test.it('7.2. Repeated reconciliation on same booking is idempotent (no double-release)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'EXP-02', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01EXP002', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    await forceExpireBooking(bookingId);

    // Run reconciler twice
    await reconcileExpiredBatch(new Date(), 50);
    await reconcileExpiredBatch(new Date(), 50);

    const booking = await Booking.findById(bookingId).lean();
    assert.equal(booking.status, 'completed', 'Still completed after second reconcile');

    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(slot.activeBooking, null, 'Slot still free after second reconcile');
  });

  test.it('7.3. Cancellation after expiry marks booking completed (not cancelled)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'EXPCAN-01', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01EC0001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    // Force expiry directly in DB without running reconciler
    await forceExpireBooking(bookingId);

    // Now cancel â€” should complete it, not cancel it
    const { res, data } = await apiUser('PATCH', `/api/bookings/${bookingId}/cancel`, null, user1Token);
    assert.equal(res.status, 200);
    assert.equal(data.booking.status, 'completed', 'Cancelling an expired booking must mark it completed');
  });

  test.it('7.4. Cancellation/rebooking after stale expiry â€” stale slot release does not affect new booking', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'STALE-01', vehicleType: 'car' });
    await publishLocation(locId);

    // User1 books
    const { data: b1d } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01STALE1', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const b1Id = b1d.booking.id;
    createdBookingIds.push(b1Id);

    // Force expire user1's booking
    await forceExpireBooking(b1Id);

    // Reconciler processes it
    await reconcileExpiredBatch(new Date(), 50);

    // User2 books the same slot (now free)
    const { res: r2, data: b2d } = await bookSlot(user2Token, locId, slotId, {
      vehicleNumber: 'MH01STALE2', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(r2.status, 201, 'User2 booking must succeed after slot was freed by reconciler');
    const b2Id = b2d.booking.id;
    createdBookingIds.push(b2Id);

    // Running reconciler again must not touch user2's fresh booking
    await reconcileExpiredBatch(new Date(), 50);
    const b2Fresh = await Booking.findById(b2Id).lean();
    assert.equal(b2Fresh.status, 'active', 'User2\'s fresh booking must still be active');
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 8. Location Closure vs. Booking
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('8.1. Booking rejected when location is closed (concurrent closure wins)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'CLOSE-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Close the location
    await apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'closed' });

    // Attempt to book
    const { res, data } = await bookSlot(user1Token, locId, slotId, { vehicleType: 'car' });
    assert.equal(res.status, 409);
    assert.equal(data.code, 'LOCATION_NOT_ACTIVE');
  });

  test.it('8.2. Slot maintenance placed while booking attempt proceeds â€” slot unavailable', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'MAINT-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Place slot in maintenance
    await apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${slotId}`, {
      serviceStatus: 'maintenance',
    });

    // Attempt to book the maintenance slot
    const { res, data } = await bookSlot(user1Token, locId, slotId, { vehicleType: 'car' });
    assert.equal(res.status, 409);
    assert.equal(data.code, 'SLOT_NOT_ENABLED');
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 9. Recommendations
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('9.1. Recommendations returns up to 3 compatible available slots', async () => {
    const locId = await createActiveLocation();
    // Create 5 car slots with different prices and distances
    for (let i = 1; i <= 5; i++) {
      const sId = await createSlot(locId, {
        code: `REC-${String(i).padStart(2, '0')}`,
        vehicleType: 'car',
        pricePerHourPaise: i * 1000,
        distanceFromEntry: i * 5,
      });
      createdSlotIds.push(sId);
    }
    await publishLocation(locId);

    const { res, data } = await apiPublic('GET', `/api/locations/${locId}/recommendations?vehicleType=car`);
    assert.equal(res.status, 200);
    assert.ok(data.serverTime);
    assert.ok(Array.isArray(data.recommendations));
    assert.ok(data.recommendations.length <= 3, 'Must return at most 3 recommendations');
    assert.ok(data.recommendations.length >= 1, 'Must return at least 1 recommendation (5 compatible slots exist)');

    for (const rec of data.recommendations) {
      assert.equal(rec.vehicleType, 'car', 'All recommendations must match requested type');
      assert.equal(rec.available, true, 'All recommended slots must be available');
      assert.ok(rec.reason, 'Each recommendation must have a reason string');
      assert.ok(typeof rec.score === 'number', 'Each recommendation must have a numeric score');
    }
  });

  test.it('9.2. Recommendations excludes claimed and maintenance slots', async () => {
    const locId = await createActiveLocation();
    const claimedSlot = await createSlot(locId, { code: 'RCLM-01', vehicleType: 'car', pricePerHourPaise: 1000, distanceFromEntry: 1 });
    const maintSlot = await createSlot(locId, { code: 'RMNT-01', vehicleType: 'car', pricePerHourPaise: 500, distanceFromEntry: 1 });
    const freeSlot = await createSlot(locId, { code: 'RFREE-01', vehicleType: 'car', pricePerHourPaise: 3000, distanceFromEntry: 5 });
    await publishLocation(locId);

    // Book (claim) the first slot
    const { data: bd } = await bookSlot(user1Token, locId, claimedSlot, {
      vehicleNumber: 'MH01RCL001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    createdBookingIds.push(bd.booking.id);

    // Place second slot in maintenance
    await apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${maintSlot}`, {
      serviceStatus: 'maintenance',
    });

    const { res, data } = await apiPublic('GET', `/api/locations/${locId}/recommendations?vehicleType=car`);
    assert.equal(res.status, 200);

    // Only the free slot should appear
    const recIds = data.recommendations.map((r) => r.id);
    assert.ok(!recIds.includes(claimedSlot), 'Claimed slot must not appear in recommendations');
    assert.ok(!recIds.includes(maintSlot), 'Maintenance slot must not appear in recommendations');
    assert.ok(recIds.includes(freeSlot), 'Free slot must appear in recommendations');
  });

  test.it('9.3. Recommendations returns empty array when no compatible slots exist', async () => {
    const locId = await createActiveLocation();
    // Only bike slots exist
    await createSlot(locId, { code: 'BIKE-01', vehicleType: 'bike' });
    await publishLocation(locId);

    const { res, data } = await apiPublic(`GET`, `/api/locations/${locId}/recommendations?vehicleType=car`);
    assert.equal(res.status, 200);
    assert.deepEqual(data.recommendations, [], 'Must return empty array when no compatible slots');
  });

  test.it('9.4. Recommendations for non-active location returns 409', async () => {
    const locId = await createActiveLocation();
    await createSlot(locId, { code: 'NACT-01', vehicleType: 'car' });
    await publishLocation(locId);
    await apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'closed' });

    const { res, data } = await apiPublic('GET', `/api/locations/${locId}/recommendations`);
    assert.equal(res.status, 409);
    assert.equal(data.code, 'LOCATION_NOT_ACTIVE');
  });

  test.it('9.5. Recommendations respects maxPricePerHourPaise filter', async () => {
    const locId = await createActiveLocation();
    await createSlot(locId, { code: 'PRICE-CHE', vehicleType: 'car', pricePerHourPaise: 1000, distanceFromEntry: 5 });
    await createSlot(locId, { code: 'PRICE-EXP', vehicleType: 'car', pricePerHourPaise: 9999, distanceFromEntry: 5 });
    await publishLocation(locId);

    const { res, data } = await apiPublic('GET', `/api/locations/${locId}/recommendations?vehicleType=car&maxPricePerHourPaise=5000`);
    assert.equal(res.status, 200);
    for (const rec of data.recommendations) {
      assert.ok(rec.pricePerHourPaise <= 5000, `Price ${rec.pricePerHourPaise} exceeds max filter`);
    }
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 10. Rollback & Indexes
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('10.1. No active booking leaks after concurrent race failure (slot state correct)', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'LEAK-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Run 3 concurrent requests
    const requests = [user1Token, user2Token, adminToken].map((token) =>
      bookSlot(token, locId, slotId, {
        vehicleNumber: 'MH01LEAK01', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      })
    );
    const results = await Promise.all(requests);

    const successes = results.filter((r) => r.res.status === 201);
    const failures = results.filter((r) => r.res.status === 409);

    assert.equal(successes.length, 1, 'Exactly 1 success expected');
    assert.equal(failures.length, 2, 'Exactly 2 failures expected');

    // Slot must have exactly one activeBooking matching the winner
    const slot = await ParkingSlot.findById(slotId).lean();
    assert.equal(slot.activeBooking.toString(), successes[0].data.booking.id);

    const activeCount = await Booking.countDocuments({ slot: slotId, status: 'active' });
    assert.equal(activeCount, 1, 'Exactly one active booking must exist');

    createdBookingIds.push(successes[0].data.booking.id);
  });

  test.it('10.2. Booking history is never deleted; cancelled bookings remain in DB', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'HIST-01', vehicleType: 'car' });
    await publishLocation(locId);

    const { data: bd } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01HIST01', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    const bookingId = bd.booking.id;
    createdBookingIds.push(bookingId);

    await apiUser('PATCH', `/api/bookings/${bookingId}/cancel`, null, user1Token);

    const booking = await Booking.findById(bookingId).lean();
    assert.ok(booking, 'Cancelled booking must still exist in DB');
    assert.equal(booking.status, 'cancelled');
  });

  test.it('10.3. Booking for non-existent location returns 404', async () => {
    const { res, data } = await bookSlot(user1Token, '000000000000000000000001', 'fakeSlotId', {
      vehicleType: 'car',
    });
    assert.equal(res.status, 404);
    assert.equal(data.code, 'LOCATION_NOT_FOUND');
  });

  test.it('10.4. Rebooking a slot after cancellation succeeds', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'REBOOK-01', vehicleType: 'car' });
    await publishLocation(locId);

    // First booking
    const { data: b1d } = await bookSlot(user1Token, locId, slotId, {
      vehicleNumber: 'MH01RBK001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    createdBookingIds.push(b1d.booking.id);

    // Cancel
    await apiUser('PATCH', `/api/bookings/${b1d.booking.id}/cancel`, null, user1Token);

    // Rebook
    const { res: r2, data: b2d } = await bookSlot(user2Token, locId, slotId, {
      vehicleNumber: 'MH01RBK002', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
    });
    assert.equal(r2.status, 201, 'Rebooking must succeed after cancellation');
    createdBookingIds.push(b2d.booking.id);
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // 11. Concurrency, Admin Coordination & Reliable Retries (Stage 6 Repair)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  test.it('11.1. Identical booking retry returns original booking after location closure and slot maintenance', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'RETRY-01', vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();
    const payload = {
      vehicleNumber: 'MH01RT0001',
      vehicleType: 'car',
      durationHours: 2,
      requestId: reqId,
    };

    // 1. Initial booking succeeds
    const { res: r1, data: d1 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r1.status, 201);
    const bookingId = d1.booking.id;
    createdBookingIds.push(bookingId);

    // 2. Admin closes location and puts slot into maintenance
    const { res: locCloseRes } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'closed' });
    assert.equal(locCloseRes.status, 200, 'Closing location should succeed and preserve existing bookings');

    const { res: slotMaintRes } = await apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${slotId}`, {
      serviceStatus: 'maintenance',
    });
    assert.equal(slotMaintRes.status, 200, 'Placing claimed slot in maintenance should succeed');

    // 3. User retries identical booking request
    const { res: r2, data: d2 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r2.status, 200, 'Identical retry must return original booking even after location closure & slot maintenance');
    assert.equal(d2.booking.id, bookingId);

    // DB invariant: exactly 1 booking exists
    const count = await Booking.countDocuments({ user: user1._id, requestId: reqId });
    assert.equal(count, 1, 'Exactly one booking document must exist');
  });

  test.it('11.2. Identical retry returns original booking after cancellation or completion', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'RETRY-02', vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();
    const payload = {
      vehicleNumber: 'MH01RT0002',
      vehicleType: 'car',
      durationHours: 1,
      requestId: reqId,
    };

    const { res: r1, data: d1 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r1.status, 201);
    const bookingId = d1.booking.id;
    createdBookingIds.push(bookingId);

    // Cancel the booking
    await apiUser('PATCH', `/api/bookings/${bookingId}/cancel`, null, user1Token);

    // Retry identical request after cancellation
    const { res: r2, data: d2 } = await bookSlot(user1Token, locId, slotId, payload);
    assert.equal(r2.status, 200, 'Identical retry must succeed after cancellation');
    assert.equal(d2.booking.id, bookingId);
    assert.equal(d2.booking.status, 'cancelled');

    // Also verify changed payload with same requestId returns 409
    const { res: r3, data: d3 } = await bookSlot(user1Token, locId, slotId, {
      ...payload,
      durationHours: 3,
    });
    assert.equal(r3.status, 409, 'Changed payload using same requestId must return 409');
    assert.equal(d3.code, 'REQUEST_ID_REUSED');

    // Identical retry after booking completion
    const slotCompId = await createSlot(locId, { code: 'RETRY-COMP-01', vehicleType: 'car' });
    const reqCompId = randomUUID();
    const payloadComp = {
      vehicleNumber: 'MH01RTCOMP',
      vehicleType: 'car',
      durationHours: 1,
      requestId: reqCompId,
    };
    const { res: rc1, data: dc1 } = await bookSlot(user1Token, locId, slotCompId, payloadComp);
    assert.equal(rc1.status, 201);
    const bookingCompId = dc1.booking.id;
    createdBookingIds.push(bookingCompId);

    // Force expire and run reconciler so status becomes 'completed'
    await forceExpireBooking(bookingCompId);
    await reconcileExpiredBatch(new Date(), 50);

    const bAfter = await Booking.findById(bookingCompId).lean();
    assert.equal(bAfter.status, 'completed', 'Booking must be completed');

    // Retry identical request after completion
    const { res: rc2, data: dc2 } = await bookSlot(user1Token, locId, slotCompId, payloadComp);
    assert.equal(rc2.status, 200, 'Identical retry must succeed after completion');
    assert.equal(dc2.booking.id, bookingCompId);
    assert.equal(dc2.booking.status, 'completed');
  });

  test.it('11.3. Concurrent identical request IDs: exactly one booking created, consistent responses', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'CONCUR-ID-01', vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();
    const payload = {
      vehicleNumber: 'MH01CID001',
      vehicleType: 'car',
      durationHours: 1,
      requestId: reqId,
    };

    // Fire 2 identical requests concurrently
    const [resA, resB] = await Promise.all([
      bookSlot(user1Token, locId, slotId, payload),
      bookSlot(user1Token, locId, slotId, payload),
    ]);

    // Both should be successful (one 201, one 200, or both 200/201 returning the same booking)
    assert.ok([200, 201].includes(resA.res.status), `resA status was ${resA.res.status}`);
    assert.ok([200, 201].includes(resB.res.status), `resB status was ${resB.res.status}`);

    const bookingIdA = resA.data.booking.id;
    const bookingIdB = resB.data.booking.id;
    assert.equal(bookingIdA, bookingIdB, 'Both responses must return the identical booking ID');
    createdBookingIds.push(bookingIdA);

    // In DB: exactly 1 booking
    const count = await Booking.countDocuments({ user: user1._id, requestId: reqId });
    assert.equal(count, 1, 'Only one booking must exist in DB for identical concurrent requestIds');
  });

  test.it('11.4. Concurrent different payloads with same request ID: one accepted, other rejected with 409', async () => {
    const locId = await createActiveLocation();
    const slot1 = await createSlot(locId, { code: 'DIFF-ID-01', vehicleType: 'car' });
    const slot2 = await createSlot(locId, { code: 'DIFF-ID-02', vehicleType: 'car' });
    await publishLocation(locId);

    const reqId = randomUUID();

    const [resA, resB] = await Promise.all([
      bookSlot(user1Token, locId, slot1, {
        vehicleNumber: 'MH01DIF001', vehicleType: 'car', durationHours: 1, requestId: reqId,
      }),
      bookSlot(user1Token, locId, slot2, {
        vehicleNumber: 'MH01DIF001', vehicleType: 'car', durationHours: 2, requestId: reqId,
      }),
    ]);

    const statuses = [resA.res.status, resB.res.status].sort();
    assert.deepEqual(statuses, [201, 409], 'Exactly one 201 and one 409 expected');

    const winner = resA.res.status === 201 ? resA.data : resB.data;
    const loser = resA.res.status === 409 ? resA.data : resB.data;
    assert.equal(loser.code, 'REQUEST_ID_REUSED', 'Loser must receive REQUEST_ID_REUSED');
    createdBookingIds.push(winner.booking.id);

    const count = await Booking.countDocuments({ user: user1._id, requestId: reqId });
    assert.equal(count, 1, 'Exactly one booking created in DB');
  });

  test.it('11.5. Booking versus concurrent admin price/type changes', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'PRC-RACE-01', vehicleType: 'car', pricePerHourPaise: 1000 });
    await publishLocation(locId);

    // User attempts to book while admin concurrently changes price to 2500
    const [bookRes, adminRes] = await Promise.all([
      bookSlot(user1Token, locId, slotId, {
        vehicleNumber: 'MH01PRC001', vehicleType: 'car', durationHours: 2, requestId: randomUUID(),
      }),
      apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${slotId}`, {
        pricePerHourPaise: 2500,
      }),
    ]);

    // Neither request must fail with 500
    assert.notEqual(bookRes.res.status, 500, 'Booking must not fail with 500');
    assert.notEqual(adminRes.res.status, 500, 'Admin update must not fail with 500');

    const slotDoc = await ParkingSlot.findById(slotId).lean();

    if (bookRes.res.status === 201) {
      createdBookingIds.push(bookRes.data.booking.id);
      const bookingInDb = await Booking.findById(bookRes.data.booking.id).lean();

      if (adminRes.res.status === 200) {
        // Admin update succeeded first: booking must use the authoritative new price
        assert.equal(bookingInDb.pricePerHourPaise, 2500, 'Booking price must match new admin price when admin succeeds');
        assert.equal(slotDoc.pricePerHourPaise, 2500, 'Slot price in DB must be updated');
      } else {
        // Booking claimed slot first: admin edit must be rejected with 409
        assert.equal(adminRes.res.status, 409, 'Admin edit must be rejected with 409 when slot was claimed first');
        assert.equal(adminRes.data.code, 'SLOT_CLAIMED');
        assert.equal(bookingInDb.pricePerHourPaise, 1000, 'Booking price must match pre-admin price when booking won');
        assert.equal(slotDoc.pricePerHourPaise, 1000, 'Slot price in DB must remain original price');
      }
      assert.equal(bookingInDb.totalPaise, bookingInDb.pricePerHourPaise * 2);
    } else {
      // Booking failed: admin update must have succeeded
      assert.equal(adminRes.res.status, 200, 'Admin update must succeed when booking does not claim first');
      assert.equal(slotDoc.pricePerHourPaise, 2500, 'Slot price in DB must be updated');
    }
  });

  test.it('11.6. Booking versus location archival: no active booking under archived location', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'ARCH-RACE-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Concurrently try to book and archive
    const [bookRes, archRes] = await Promise.all([
      bookSlot(user1Token, locId, slotId, {
        vehicleNumber: 'MH01ARC001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      }),
      apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'archived' }),
    ]);

    if (bookRes.res.status === 201) {
      createdBookingIds.push(bookRes.data.booking.id);
      // Booking won: admin archival MUST have failed with 409
      assert.equal(archRes.res.status, 409, 'Archival must fail when active booking exists');
      assert.equal(archRes.data.code, 'ACTIVE_BOOKINGS_EXIST');
    } else {
      // Archival won: booking MUST have failed with 409 LOCATION_NOT_ACTIVE
      assert.equal(archRes.res.status, 200);
      assert.equal(bookRes.res.status, 409);
      assert.equal(bookRes.data.code, 'LOCATION_NOT_ACTIVE');
    }

    // Invariant: no active booking exists under an archived location
    const loc = await ParkingLocation.findById(locId).lean();
    if (loc.status === 'archived') {
      const activeBookings = await Booking.countDocuments({ location: locId, status: 'active' });
      assert.equal(activeBookings, 0, 'No active bookings allowed under archived location');
    }
  });

  test.it('11.7. Booking versus slot archival: claimed slot is never archived', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'SLTARC-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Concurrently try to book slot and archive slot
    const [bookRes, slotArchRes] = await Promise.all([
      bookSlot(user1Token, locId, slotId, {
        vehicleNumber: 'MH01SARC01', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      }),
      apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${slotId}`, { serviceStatus: 'archived' }),
    ]);

    if (bookRes.res.status === 201) {
      createdBookingIds.push(bookRes.data.booking.id);
      // Slot was claimed: admin slot archival MUST fail with 409 SLOT_CLAIMED
      assert.equal(slotArchRes.res.status, 409);
      assert.equal(slotArchRes.data.code, 'SLOT_CLAIMED');
    } else {
      // Slot archival won: booking must fail
      assert.equal(slotArchRes.res.status, 200);
      assert.equal(bookRes.res.status, 409);
    }

    // Invariant: an actively claimed slot is NEVER in archived status
    const slotDoc = await ParkingSlot.findById(slotId).lean();
    if (slotDoc.activeBooking) {
      assert.notEqual(slotDoc.serviceStatus, 'archived', 'Actively booked slot must not be archived');
    }
  });

  test.it('11.8. Booking versus concurrent admin vehicleType change', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'VTYPE-RACE-01', vehicleType: 'car' });
    await publishLocation(locId);

    const [bookRes, adminRes] = await Promise.all([
      bookSlot(user1Token, locId, slotId, {
        vehicleNumber: 'MH01VT0001', vehicleType: 'car', durationHours: 1, requestId: randomUUID(),
      }),
      apiAdmin('PATCH', `/api/admin/locations/${locId}/slots/${slotId}`, {
        vehicleType: 'bike',
      }),
    ]);

    assert.notEqual(bookRes.res.status, 500);
    assert.notEqual(adminRes.res.status, 500);

    const slotDoc = await ParkingSlot.findById(slotId).lean();

    if (bookRes.res.status === 201) {
      createdBookingIds.push(bookRes.data.booking.id);
      // Booking succeeded when vehicleType was car: admin edit must have failed with 409 SLOT_CLAIMED
      assert.equal(adminRes.res.status, 409, 'Admin vehicleType change must be rejected when slot is claimed');
      assert.equal(adminRes.data.code, 'SLOT_CLAIMED');
      assert.equal(slotDoc.vehicleType, 'car', 'Slot vehicleType in DB must remain car');
    } else {
      // Admin vehicleType change won (200): booking must have failed with 409
      assert.equal(adminRes.res.status, 200, 'Admin vehicleType change must succeed if booking did not claim first');
      assert.equal(slotDoc.vehicleType, 'bike', 'Slot vehicleType in DB must be bike');
      assert.equal(bookRes.res.status, 409, 'Booking for car on bike slot must be rejected');
    }

    // Invariant: no active booking in DB has incompatible vehicleType for its slot
    const bookings = await Booking.find({ slot: slotId, status: 'active' }).lean();
    for (const b of bookings) {
      assert.equal(b.vehicleType, slotDoc.vehicleType, 'Active booking vehicleType must match current slot vehicleType');
    }
  });

  test.it('11.9. Controlled interleaving: slot archival versus stale admin update', async () => {
    const locId = await createActiveLocation();
    const slotId = await createSlot(locId, { code: 'STALE-SLOT-01', vehicleType: 'car', pricePerHourPaise: 1000 });
    await publishLocation(locId);

    // Verify initial state
    const slotBefore = await ParkingSlot.findById(slotId).lean();
    assert.equal(slotBefore.serviceStatus, 'enabled');

    // === Barrier setup ===
    // The barrier pauses request-1's controller at the point it is about to call
    // findOneAndUpdate (i.e., after it has already read the original slot with
    // serviceStatus='enabled' but before its conditional write lands in the DB).
    //
    // pauseSignal  -> resolves when request-1's handler reaches findOneAndUpdate
    // resumeSignal -> resolves when archival is complete and request-1 may proceed
    //
    // A 5-second timeout guards against a broken barrier hanging the test suite.

    const BARRIER_TIMEOUT_MS = 5000;

    let signalPause;  // called by the intercepted findOneAndUpdate to signal it arrived
    let signalResume; // called by the test body to let request-1's write proceed

    const pauseSignal  = new Promise((resolve) => { signalPause  = resolve; });
    const resumeSignal = new Promise((resolve) => { signalResume = resolve; });

    const originalFindOneAndUpdate = ParkingSlot.findOneAndUpdate.bind(ParkingSlot);
    let intercepted = false;

    // Install barrier -- intercepts only the first relevant call from the stale update.
    // Request-1's controller reads the slot (findOne), then calls findOneAndUpdate.
    // We intercept that findOneAndUpdate, signal that we have arrived at the write
    // point, wait for the archival request to complete, then proceed.
    ParkingSlot.findOneAndUpdate = function barrierFindOneAndUpdate(...args) {
      if (!intercepted) {
        intercepted = true;
        signalPause();  // signal: request-1 has read the doc and is about to write
        return Promise.race([
          resumeSignal,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Barrier timeout in 11.9')), BARRIER_TIMEOUT_MS)
          ),
        ]).then(() => originalFindOneAndUpdate(...args));
      }
      return originalFindOneAndUpdate(...args);
    };

    let request1Error = null;
    let delayedRes, delayedData;

    try {
      // Step 1: Start request-1 (stale update: price change + maintenance).
      // This request reads the slot (finding serviceStatus='enabled'), then calls
      // findOneAndUpdate where our barrier intercepts it.
      const request1Promise = apiAdmin(
        'PATCH',
        `/api/admin/locations/${locId}/slots/${slotId}`,
        { pricePerHourPaise: 4000, serviceStatus: 'maintenance' }
      );

      // Step 2: Wait until request-1 has read the slot and reached its write point.
      await Promise.race([
        pauseSignal,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for barrier in 11.9')), BARRIER_TIMEOUT_MS)
        ),
      ]);

      // Step 3: While request-1 is paused at findOneAndUpdate, complete archival
      // using a second admin request. This runs to full completion while request-1's
      // findOneAndUpdate has not yet executed.
      const { res: archRes } = await apiAdmin(
        'PATCH',
        `/api/admin/locations/${locId}/slots/${slotId}`,
        { serviceStatus: 'archived' }
      );
      assert.equal(archRes.status, 200, 'Archiving slot must succeed');

      // Slot is now archived in the DB; request-1's write is still pending.

      // Step 4: Resume request-1 -- its findOneAndUpdate now runs against an
      // already-archived slot (filter {serviceStatus:'enabled'} won't match).
      signalResume();

      // Step 5: Collect request-1's response.
      const result1 = await request1Promise;
      delayedRes  = result1.res;
      delayedData = result1.data;
    } catch (err) {
      request1Error = err;
    } finally {
      // Restore the original method regardless of test outcome.
      ParkingSlot.findOneAndUpdate = originalFindOneAndUpdate;
    }

    if (request1Error) throw request1Error;

    // Assertions:
    // Request-1 read an 'enabled' slot, but by the time its conditional write ran
    // the slot was already archived. The write-time guard (findOneAndUpdate filter
    // includes serviceStatus:'enabled') must produce a 409.
    assert.equal(delayedRes.status, 409,
      'Stale update on an in-flight slot that was concurrently archived must return 409');
    assert.ok(
      ['SLOT_ARCHIVED_IMMUTABLE', 'ARCHIVED_IMMUTABLE', 'INVALID_STATUS_TRANSITION', 'SLOT_CONFLICT']
        .includes(delayedData.code),
      `Unexpected error code: ${delayedData.code}`
    );

    // DB invariants: slot is still archived and price is unchanged.
    const slotAfter = await ParkingSlot.findById(slotId).lean();
    assert.equal(slotAfter.serviceStatus, 'archived', 'Slot must remain archived');
    assert.equal(slotAfter.pricePerHourPaise, 1000, 'Price must not be updated by stale write');
  });

  test.it('11.10. Controlled interleaving: location archival versus stale admin reopen', async () => {
    const locId = await createActiveLocation();
    await createSlot(locId, { code: 'STALE-LOC-01', vehicleType: 'car' });
    await publishLocation(locId);

    // Close the location first so there is a valid reopen transition.
    const { res: closeRes } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, { status: 'closed' });
    assert.equal(closeRes.status, 200);

    // Verify the location is closed -- this is the state request-1's controller
    // will observe when it reads the document at the top of adminUpdateLocation.
    const locClosed = await ParkingLocation.findById(locId).lean();
    assert.equal(locClosed.status, 'closed');

    // === Barrier setup ===
    // Pauses request-1 (reopen: status:'active') after it has read the location
    // document (finding status='closed') but before its transactional
    // findOneAndUpdate fires inside withTransaction.

    const BARRIER_TIMEOUT_MS = 5000;

    let signalPause;
    let signalResume;

    const pauseSignal  = new Promise((resolve) => { signalPause  = resolve; });
    const resumeSignal = new Promise((resolve) => { signalResume = resolve; });

    const originalFindOneAndUpdate = ParkingLocation.findOneAndUpdate.bind(ParkingLocation);
    let intercepted = false;

    // Install barrier on ParkingLocation.findOneAndUpdate.
    // The reopen controller (adminUpdateLocation, status:'active') reads the doc
    // via findById, then calls findOneAndUpdate inside withTransaction.
    // We intercept that first call, signal arrival, wait for archival, then proceed.
    ParkingLocation.findOneAndUpdate = function barrierFindOneAndUpdate(...args) {
      if (!intercepted) {
        intercepted = true;
        signalPause();  // signal: request-1 has read the doc and is about to write
        return Promise.race([
          resumeSignal,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Barrier timeout in 11.10')), BARRIER_TIMEOUT_MS)
          ),
        ]).then(() => originalFindOneAndUpdate(...args));
      }
      return originalFindOneAndUpdate(...args);
    };

    let request1Error = null;
    let reopenRes, reopenData;

    try {
      // Step 1: Start request-1 (reopen: status:'active').
      // This controller reads the location (finding status='closed'), then calls
      // findOneAndUpdate where our barrier intercepts it.
      const request1Promise = apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
        status: 'active',
      });

      // Step 2: Wait until request-1 has read the location and reached its write point.
      await Promise.race([
        pauseSignal,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for barrier in 11.10')), BARRIER_TIMEOUT_MS)
        ),
      ]);

      // Step 3: While request-1 is paused, archive the location using a second
      // admin request. This runs to full completion.
      const { res: archRes } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
        status: 'archived',
      });
      assert.equal(archRes.status, 200, 'Archiving closed location must succeed');

      // Location is now archived; request-1's write is still pending.

      // Step 4: Resume request-1 -- its findOneAndUpdate now runs against an
      // already-archived location (filter {status:'closed'} won't match).
      signalResume();

      // Step 5: Collect request-1's response.
      const result1 = await request1Promise;
      reopenRes  = result1.res;
      reopenData = result1.data;
    } catch (err) {
      request1Error = err;
    } finally {
      // Restore the original method regardless of test outcome.
      ParkingLocation.findOneAndUpdate = originalFindOneAndUpdate;
    }

    if (request1Error) throw request1Error;

    // Assertions:
    // Request-1 read a 'closed' location, but by the time its findOneAndUpdate ran
    // inside the transaction the location was archived. The write-time guard
    // (filter includes status:'closed') must fail -> 409.
    assert.equal(reopenRes.status, 409,
      'Stale reopen of a location that was concurrently archived must return 409');
    assert.ok(
      ['ARCHIVED_IMMUTABLE', 'INVALID_STATUS_TRANSITION'].includes(reopenData.code),
      `Unexpected error code: ${reopenData.code}`
    );

    // DB invariant: location remains archived and was NOT resurrected.
    const locAfter = await ParkingLocation.findById(locId).lean();
    assert.equal(locAfter.status, 'archived', 'Archived location must not be resurrected');
  });

  test.it('11.11. Location closing/archiving with invalid edits returns 400 and preserves DB state; valid combined edit succeeds', async () => {
    const locId = await createActiveLocation();
    await createSlot(locId, { code: 'COMB-VAL-01', vehicleType: 'car' });
    await publishLocation(locId);

    const initialLoc = await ParkingLocation.findById(locId).lean();
    assert.equal(initialLoc.status, 'active');

    // === Closing with invalid edits ===

    // 1. Close with invalid category -> 400
    const { res: rCat, data: dCat } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'closed',
      category: 'invalid-cat-123',
    });
    assert.equal(rCat.status, 400);
    assert.equal(dCat.code, 'VALIDATION_ERROR');

    // Verify DB untouched
    let locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'active');
    assert.equal(locCheck.category, initialLoc.category);

    // 2. Close with blank address -> 400 (address is required when not draft)
    const { res: rAddr, data: dAddr } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'closed',
      address: '',
    });
    assert.equal(rAddr.status, 400);
    assert.equal(dAddr.code, 'VALIDATION_ERROR');

    // Verify DB untouched
    locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'active');
    assert.equal(locCheck.address, initialLoc.address);

    // 3. Close with invalid contactPhone -> 400
    const { res: rPhone, data: dPhone } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'closed',
      contactPhone: 'not-a-valid-phone-abc!@#',
    });
    assert.equal(rPhone.status, 400);
    assert.equal(dPhone.code, 'VALIDATION_ERROR');

    // Verify DB untouched
    locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'active');
    assert.equal(locCheck.contactPhone, initialLoc.contactPhone);

    // 4. Valid combined edit (close + field updates) -> 200
    const { res: rValid, data: dValid } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'closed',
      name: 'Combined Valid Name Mall',
      contactPhone: '+919999888877',
    });
    assert.equal(rValid.status, 200);
    assert.equal(dValid.location.status, 'closed');
    assert.equal(dValid.location.name, 'Combined Valid Name Mall');

    // Verify DB updated
    locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'closed');
    assert.equal(locCheck.name, 'Combined Valid Name Mall');
    assert.equal(locCheck.contactPhone, '+919999888877');

    // === Archiving with invalid edits ===
    // The location is now closed; try to archive it with invalid fields.
    // Invalid edits combined with archival must also return 400 and leave DB intact.

    // 5. Archive with invalid category -> 400
    const { res: rArchCat, data: dArchCat } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'archived',
      category: 'totally-invalid-xyz',
    });
    assert.equal(rArchCat.status, 400,
      'Archival combined with invalid category must return 400');
    assert.equal(dArchCat.code, 'VALIDATION_ERROR');

    // Verify DB untouched: location is still closed, not archived.
    locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'closed',
      'Location must remain closed after failed archive+invalid-category attempt');
    assert.equal(locCheck.category, initialLoc.category,
      'Category must remain unchanged after failed archive attempt');

    // 6. Archive with invalid contactPhone -> 400
    const { res: rArchPhone, data: dArchPhone } = await apiAdmin('PATCH', `/api/admin/locations/${locId}`, {
      status: 'archived',
      contactPhone: 'bad-phone!!!',
    });
    assert.equal(rArchPhone.status, 400,
      'Archival combined with invalid contactPhone must return 400');
    assert.equal(dArchPhone.code, 'VALIDATION_ERROR');

    // Verify DB untouched.
    locCheck = await ParkingLocation.findById(locId).lean();
    assert.equal(locCheck.status, 'closed',
      'Location must remain closed after failed archive+invalid-phone attempt');
    assert.equal(locCheck.contactPhone, '+919999888877',
      'contactPhone must remain unchanged after failed archive attempt');
  });
});
