// tests/locations.test.js — Stage 5 Location/Slot/Search API Tests
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../server/app');
const { User, ParkingLocation, ParkingSlot, Booking } = require('../server/models');
const { connectDB, disconnectDB } = require('../server/config/db');
const { validateDatabaseConfig } = require('../server/config/env');
const { hashPassword, generateToken } = require('../server/utils/authUtils');
const { getJwtConfig } = require('../server/config/env');

test.describe('Stage 5: Location, Slot & Search APIs', () => {
  let server;
  let baseUrl;

  // Test-run isolation fixtures
  const testRunId = `s5-${Date.now()}`;
  const createdLocationIds = [];
  const createdSlotIds = [];
  const createdUserIds = [];
  const createdBookingIds = [];

  let adminUser;
  let adminToken;
  let normalUser;
  let normalToken;

  // ── Setup ───────────────────────────────────────────────────
  test.before(async () => {
    // Validate strict test DB isolation
    const config = validateDatabaseConfig({ isTest: true });
    assert.ok(config.testDbName, 'Tests must target an explicit test database');
    assert.notEqual(
      config.testDbName.toLowerCase(),
      (config.appDbName || '').toLowerCase(),
      'Stage 5 tests refused: test database cannot match application database'
    );

    await connectDB({ isTest: true });
    await Promise.all([
      User.init(),
      ParkingLocation.init(),
      ParkingSlot.init(),
      Booking.init(),
    ]);

    // Create an admin user for protected admin routes
    const adminPwHash = await hashPassword('AdminPass@123');
    adminUser = await User.create({
      name: 'Stage5 Admin',
      email: `s5-admin-${testRunId}@example.com`,
      phone: '+91 90000 10001',
      passwordHash: adminPwHash,
      role: 'admin',
    });
    createdUserIds.push(adminUser._id);
    adminToken = generateToken(adminUser, getJwtConfig());

    // Create a normal user
    const userPwHash = await hashPassword('UserPass@123');
    normalUser = await User.create({
      name: 'Stage5 User',
      email: `s5-user-${testRunId}@example.com`,
      phone: '+91 90000 10002',
      passwordHash: userPwHash,
      role: 'user',
    });
    createdUserIds.push(normalUser._id);
    normalToken = generateToken(normalUser, getJwtConfig());

    // Start ephemeral HTTP server
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  // ── Teardown ─────────────────────────────────────────────────
  test.after(async () => {
    try {
      // Dependency-ordered cleanup: bookings → slots → locations → users
      if (createdBookingIds.length > 0) {
        await Booking.deleteMany({ _id: { $in: createdBookingIds } });
      }
      if (createdSlotIds.length > 0) {
        await ParkingSlot.deleteMany({ _id: { $in: createdSlotIds } });
      }
      if (createdLocationIds.length > 0) {
        // Also delete any slots belonging to these locations (created by sub-tests)
        await ParkingSlot.deleteMany({ location: { $in: createdLocationIds } });
        await ParkingLocation.deleteMany({ _id: { $in: createdLocationIds } });
      }
      if (createdUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
      }
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await disconnectDB();
    }
  });

  // ── Helper: create a location via admin API ─────────────────
  async function createLocation(overrides = {}) {
    const defaults = {
      name: `Test Loc ${testRunId} ${Math.random().toString(36).slice(2)}`,
      category: 'mall',
      address: '123 Test Street',
      city: 'Mumbai',
      area: 'Andheri',
      contactPhone: '+91 99999 11111',
      latitude: 19.1,
      longitude: 72.8,
    };
    const res = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ ...defaults, ...overrides }),
    });
    const data = await res.json();
    if (data.location && data.location.id) {
      createdLocationIds.push(data.location.id);
    }
    return { res, data };
  }

  // ── Helper: create a slot via admin API ─────────────────────
  async function createSlot(locationId, overrides = {}) {
    const defaults = {
      code: `SL-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      zone: 'A',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      distanceFromEntry: 10,
    };
    const res = await fetch(`${baseUrl}/api/admin/locations/${locationId}/slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ ...defaults, ...overrides }),
    });
    const data = await res.json();
    if (data.slot && data.slot.id) {
      createdSlotIds.push(data.slot.id);
    }
    return { res, data };
  }

  // ═══════════════════════════════════════════════════════════
  // 1. ADMIN — Location CRUD
  // ═══════════════════════════════════════════════════════════

  test.it('1.1. Admin can create a draft location with valid fields', async () => {
    const { res, data } = await createLocation({ name: `Draft Loc ${testRunId}` });
    assert.equal(res.status, 201, 'Must return 201 Created');
    assert.equal(data.success, true);
    assert.equal(data.location.status, 'draft');
    assert.ok(data.location.id);
    assert.ok(data.location.slug);
    // Sensitive internals must not leak
    assert.equal(data.location.bookingRevision, undefined);
    assert.equal(data.location.isDemo, undefined);
    assert.equal(data.location.createdBy, undefined);
  });

  test.it('1.2. Admin location creation rejects unknown/privileged fields', async () => {
    const res = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: 'Injected Location',
        category: 'mall',
        status: 'active', // forbidden — status is not in write fields for creation
        isDemo: true,     // forbidden
      }),
    });
    assert.equal(res.status, 400, 'Must reject unknown/privileged fields');
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN_FIELDS');
  });

  test.it('1.3. Non-admin cannot access admin location endpoints', async () => {
    const res = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${normalToken}` },
    });
    assert.equal(res.status, 403, 'Non-admin must receive 403 Forbidden');
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN');
  });

  test.it('1.4. Unauthenticated request to admin routes returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/locations`, { method: 'GET' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  test.it('1.5. Admin can list all locations with pagination', async () => {
    const res = await fetch(`${baseUrl}/api/admin/locations?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.locations));
    assert.ok(typeof body.total === 'number');
    assert.equal(body.page, 1);
    assert.equal(body.limit, 10);
  });

  test.it('1.6. Draft location cannot be published without a complete address and valid coordinates', async () => {
    // Create incomplete location (no coordinates yet — they're in defaults, so omit them)
    const res1 = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: `Incomplete Loc ${testRunId} ${Math.random()}`,
        category: 'office',
        address: '',
        city: 'Pune',
        area: 'Baner',
        contactPhone: '+91 90000 20001',
        latitude: 18.5,
        longitude: 73.8,
      }),
    });
    // address empty means Mongoose validation will reject, which is fine

    // Create a proper draft and then try to publish without any enabled slot
    const { data: locData } = await createLocation({ name: `No-Slot Draft ${testRunId}` });
    const locId = locData.location.id;

    const res2 = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(res2.status, 422, 'Must fail with 422 when no enabled slot exists');
    const body2 = await res2.json();
    assert.equal(body2.code, 'PUBLISH_PRECONDITIONS_FAILED');
    assert.ok(Array.isArray(body2.violations) && body2.violations.length > 0);
  });

  test.it('1.7. Draft → active lifecycle with preconditions met', async () => {
    const { data: locData } = await createLocation({
      name: `Publishable Loc ${testRunId}`,
      latitude: 19.07,
      longitude: 72.87,
    });
    const locId = locData.location.id;

    // Add an enabled slot
    await createSlot(locId, { code: 'PUB-01' });

    // Now publish
    const pubRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(pubRes.status, 200, 'Must return 200 on successful publish');
    const pubBody = await pubRes.json();
    assert.equal(pubBody.location.status, 'active');
  });

  test.it('1.8. Active location can be closed and reopened; archived requires no active bookings', async () => {
    const { data: locData } = await createLocation({
      name: `Lifecycle Loc ${testRunId}`,
    });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'LIFE-01' });

    // Publish
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    // Close
    const closeRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'closed' }),
    });
    assert.equal(closeRes.status, 200);
    const closeBody = await closeRes.json();
    assert.equal(closeBody.location.status, 'closed');

    // Reopen
    const openRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(openRes.status, 200);
    const openBody = await openRes.json();
    assert.equal(openBody.location.status, 'active');

    // Archive (no active bookings)
    const archRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'archived' }),
    });
    assert.equal(archRes.status, 200);
    const archBody = await archRes.json();
    assert.equal(archBody.location.status, 'archived');

    // Archived location cannot be re-edited
    const reEditRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Attempted Edit' }),
    });
    assert.equal(reEditRes.status, 409, 'Must reject edits to archived location');
    const reEditBody = await reEditRes.json();
    assert.equal(reEditBody.code, 'ARCHIVED_IMMUTABLE');
  });

  test.it('1.9. Invalid status transitions are rejected', async () => {
    const { data: locData } = await createLocation({ name: `Transition Test ${testRunId}` });
    const locId = locData.location.id;

    // draft → closed is invalid
    const res = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'closed' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_STATUS_TRANSITION');
  });

  test.it('1.10. Zero coordinates (0, 0) are accepted as valid for publish precondition', async () => {
    const { data: locData } = await createLocation({
      name: `Zero Coord Loc ${testRunId}`,
      latitude: 0,
      longitude: 0,
    });
    assert.equal(locData.location.latitude, 0);
    assert.equal(locData.location.longitude, 0);
    const locId = locData.location.id;

    // Add slot
    await createSlot(locId, { code: 'ZERO-01' });

    // Publish should succeed (0,0 are valid finite coordinates)
    const pubRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(pubRes.status, 200, 'Zero coordinates must pass publish validation');
  });

  // ═══════════════════════════════════════════════════════════
  // 2. ADMIN — Slot CRUD
  // ═══════════════════════════════════════════════════════════

  test.it('2.1. Admin can add a slot to a draft location', async () => {
    const { data: locData } = await createLocation({ name: `Slot Base Loc ${testRunId}` });
    const locId = locData.location.id;

    const { res, data } = await createSlot(locId, { code: 'S-01', vehicleType: 'car', pricePerHourPaise: 4000 });
    assert.equal(res.status, 201);
    assert.equal(data.success, true);
    assert.equal(data.slot.code, 'S-01');
    assert.equal(data.slot.serviceStatus, 'enabled');
    assert.equal(data.slot.available, true);
    // Admin response includes activeBooking ref
    assert.equal(data.slot.activeBooking, null);
  });

  test.it('2.2. Same slot code in different locations is allowed; duplicate in same location is rejected', async () => {
    const { data: locA } = await createLocation({ name: `Loc A ${testRunId}` });
    const { data: locB } = await createLocation({ name: `Loc B ${testRunId}` });

    // Same code A-01 in locA
    const { res: r1 } = await createSlot(locA.location.id, { code: 'A-01' });
    assert.equal(r1.status, 201, 'First slot must succeed');

    // Same code A-01 in locA again — must fail
    const { res: r2, data: data2 } = await createSlot(locA.location.id, { code: 'A-01' });
    assert.equal(r2.status, 409, 'Duplicate code in same location must be rejected');
    assert.equal(data2.code, 'DUPLICATE_SLOT_CODE');

    // Same code A-01 in locB — must succeed
    const { res: r3 } = await createSlot(locB.location.id, { code: 'A-01' });
    assert.equal(r3.status, 201, 'Same code in different location must be allowed');
  });

  test.it('2.3. Slot update rejects unknown/privileged fields', async () => {
    const { data: locData } = await createLocation({ name: `Slot Field Test Loc ${testRunId}` });
    const { data: slotData } = await createSlot(locData.location.id, { code: 'FLD-01' });

    const res = await fetch(
      `${baseUrl}/api/admin/locations/${locData.location.id}/slots/${slotData.slot.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ activeBooking: 'fakeid', location: 'fakeid2' }),
      }
    );
    assert.equal(res.status, 400, 'Must reject unknown/privileged slot fields');
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN_FIELDS');
  });

  test.it('2.4. Mismatched nested locationId/slotId returns 404', async () => {
    const { data: locA } = await createLocation({ name: `Nested A ${testRunId}` });
    const { data: locB } = await createLocation({ name: `Nested B ${testRunId}` });
    const { data: slotData } = await createSlot(locA.location.id, { code: 'MISMATCH-01' });

    // Request slot from locB but slot belongs to locA
    const res = await fetch(
      `${baseUrl}/api/admin/locations/${locB.location.id}/slots/${slotData.slot.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ pricePerHourPaise: 9999 }),
      }
    );
    assert.equal(res.status, 404, 'Mismatched nested IDs must return 404');
    const body = await res.json();
    assert.equal(body.code, 'NOT_FOUND');
  });

  test.it('2.5. Slot maintenance/reopen/archive serviceStatus transitions', async () => {
    const { data: locData } = await createLocation({ name: `Status Slot Loc ${testRunId}` });
    const locId = locData.location.id;
    const { data: slotData } = await createSlot(locId, { code: 'SS-01' });
    const slotId = slotData.slot.id;

    const patch = async (body) =>
      fetch(`${baseUrl}/api/admin/locations/${locId}/slots/${slotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(body),
      });

    // enabled → maintenance
    const r1 = await patch({ serviceStatus: 'maintenance' });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).slot.serviceStatus, 'maintenance');

    // maintenance → enabled
    const r2 = await patch({ serviceStatus: 'enabled' });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).slot.serviceStatus, 'enabled');

    // enabled → archived
    const r3 = await patch({ serviceStatus: 'archived' });
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).slot.serviceStatus, 'archived');

    // archived → anything is rejected
    const r4 = await patch({ serviceStatus: 'enabled' });
    assert.equal(r4.status, 409);
    assert.equal((await r4.json()).code, 'SLOT_ARCHIVED_IMMUTABLE');
  });

  test.it('2.6. Claimed slot: only maintenance is allowed; price/code edits are rejected', async () => {
    const { data: locData } = await createLocation({ name: `Claimed Slot Loc ${testRunId}` });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'CLAIM-PUB' });
    // Publish location first so slot shows up
    await createSlot(locId, { code: 'CLAIM-01' });
    const { data: slotData } = await createSlot(locId, { code: 'CLAIM-T' });
    const slotId = slotData.slot.id;

    // Simulate a claimed slot by directly setting activeBooking in DB
    // (We do not have a booking service yet — Stage 6 limitation; use fixture directly)
    const fakeBookingId = new (require('mongoose').Types.ObjectId)();
    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: fakeBookingId } });

    const patchUrl = `${baseUrl}/api/admin/locations/${locId}/slots/${slotId}`;
    const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };

    // Price edit on claimed slot → 409
    const r1 = await fetch(patchUrl, {
      method: 'PATCH', headers: hdr,
      body: JSON.stringify({ pricePerHourPaise: 9999 }),
    });
    assert.equal(r1.status, 409, 'Price edit on claimed slot must be rejected');
    assert.equal((await r1.json()).code, 'SLOT_CLAIMED');

    // Maintenance on claimed slot → 200 (allowed)
    const r2 = await fetch(patchUrl, {
      method: 'PATCH', headers: hdr,
      body: JSON.stringify({ serviceStatus: 'maintenance' }),
    });
    assert.equal(r2.status, 200, 'Maintenance on claimed slot must be allowed');

    // Re-enable on claimed slot → 409
    const r3 = await fetch(patchUrl, {
      method: 'PATCH', headers: hdr,
      body: JSON.stringify({ serviceStatus: 'enabled' }),
    });
    assert.equal(r3.status, 409, 'Re-enable on claimed slot must be rejected');
    assert.equal((await r3.json()).code, 'SLOT_CLAIMED');

    // Unset the fake booking so cleanup proceeds normally
    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: null } });
  });

  test.it('2.7. Cannot add slots to an archived location', async () => {
    const { data: locData } = await createLocation({ name: `Arch Slot Loc ${testRunId}` });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'ARC-PUB' });

    // Publish and then archive
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'archived' }),
    });

    const { res, data } = await createSlot(locId, { code: 'NEW-01' });
    assert.equal(res.status, 409, 'Must reject slot creation for archived location');
    assert.equal(data.code, 'ARCHIVED_IMMUTABLE');
  });

  // ═══════════════════════════════════════════════════════════
  // 3. PUBLIC — Location Search & Detail
  // ═══════════════════════════════════════════════════════════

  test.it('3.1. Public search lists only active and closed locations; excludes drafts and archives', async () => {
    // Create one active, one closed, one draft, one archived location
    const { data: d1 } = await createLocation({ name: `Public Active ${testRunId}` });
    await createSlot(d1.location.id, { code: 'PA-01' });
    await fetch(`${baseUrl}/api/admin/locations/${d1.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    const { data: d2 } = await createLocation({ name: `Public Closed ${testRunId}` });
    await createSlot(d2.location.id, { code: 'PC-01' });
    await fetch(`${baseUrl}/api/admin/locations/${d2.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    await fetch(`${baseUrl}/api/admin/locations/${d2.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'closed' }),
    });

    const { data: d3 } = await createLocation({ name: `Public Draft ${testRunId}` });
    // d3 stays draft

    const { data: d4 } = await createLocation({ name: `Public Archived ${testRunId}` });
    await createSlot(d4.location.id, { code: 'AR-01' });
    await fetch(`${baseUrl}/api/admin/locations/${d4.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    await fetch(`${baseUrl}/api/admin/locations/${d4.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'archived' }),
    });

    const res = await fetch(`${baseUrl}/api/locations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.locations));

    const ids = body.locations.map((l) => l.id);
    assert.ok(ids.includes(d1.location.id), 'Active location must appear in public search');
    assert.ok(ids.includes(d2.location.id), 'Closed location must appear in public search');
    assert.ok(!ids.includes(d3.location.id), 'Draft location must NOT appear in public search');
    assert.ok(!ids.includes(d4.location.id), 'Archived location must NOT appear in public search');

    // Closed location must have explicit unavailable flag
    const closedResult = body.locations.find((l) => l.id === d2.location.id);
    assert.ok(closedResult, 'Closed location must be in results');
    assert.equal(closedResult.unavailable, true, 'Closed location must set unavailable: true');
    assert.ok(closedResult.unavailableReason, 'Closed location must provide unavailableReason');
  });

  test.it('3.2. Literal text search does not treat special regex characters as regex', async () => {
    // Search with special regex chars — must not throw or return wrong results
    const res = await fetch(`${baseUrl}/api/locations?q=test.*(evil%7Cinjection)`);
    assert.equal(res.status, 200, 'Special chars in search query must not cause errors');
    const body = await res.json();
    assert.equal(body.success, true);
    // No crash = literal escaping is working
  });

  test.it('3.3. Public detail returns 404 for drafts and archives (direct URL bypass attempt)', async () => {
    const { data: draftData } = await createLocation({ name: `Direct Draft ${testRunId}` });
    const draftId = draftData.location.id;

    // Direct URL to draft must return 404
    const draftRes = await fetch(`${baseUrl}/api/locations/${draftId}`);
    assert.equal(draftRes.status, 404, 'Direct URL to draft must return 404');
    assert.equal((await draftRes.json()).code, 'NOT_FOUND');

    // Create archived location
    const { data: archData } = await createLocation({ name: `Direct Archive ${testRunId}` });
    await createSlot(archData.location.id, { code: 'DARCH-01' });
    await fetch(`${baseUrl}/api/admin/locations/${archData.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    await fetch(`${baseUrl}/api/admin/locations/${archData.location.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'archived' }),
    });

    const archRes = await fetch(`${baseUrl}/api/locations/${archData.location.id}`);
    assert.equal(archRes.status, 404, 'Direct URL to archived must return 404');
    assert.equal((await archRes.json()).code, 'NOT_FOUND');
  });

  test.it('3.4. Public detail and slot list return 200 for active location with availability counts', async () => {
    const { data: locData } = await createLocation({ name: `Detail Test ${testRunId}` });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'DET-01' });
    await createSlot(locId, { code: 'DET-02' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    // Public detail
    const detRes = await fetch(`${baseUrl}/api/locations/${locId}`);
    assert.equal(detRes.status, 200);
    const detBody = await detRes.json();
    assert.equal(detBody.success, true);
    assert.equal(detBody.location.id, locId);
    assert.equal(detBody.location.status, 'active');
    assert.ok(typeof detBody.location.availableSlots === 'number', 'Must include availableSlots count');
    assert.equal(detBody.location.availableSlots, 2);
    assert.equal(detBody.location.totalSlots, 2);

    // Public slots
    const slotRes = await fetch(`${baseUrl}/api/locations/${locId}/slots`);
    assert.equal(slotRes.status, 200);
    const slotBody = await slotRes.json();
    assert.ok(Array.isArray(slotBody.slots));
    assert.equal(slotBody.slots.length, 2);
    // Public slots must not expose activeBooking
    for (const s of slotBody.slots) {
      assert.equal(s.activeBooking, undefined, 'Public slot must not expose activeBooking ref');
      assert.ok(typeof s.available === 'boolean', 'Public slot must have availability flag');
    }
  });

  test.it('3.5. Closed location slots route returns empty list with unavailable marker', async () => {
    const { data: locData } = await createLocation({ name: `Closed Slots ${testRunId}` });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'CS-01' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'closed' }),
    });

    const res = await fetch(`${baseUrl}/api/locations/${locId}/slots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.unavailable, true);
    assert.equal(body.slots.length, 0, 'Closed location must return empty public slots');
  });

  // ═══════════════════════════════════════════════════════════
  // 4. ADMIN — Summary & Bookings
  // ═══════════════════════════════════════════════════════════

  test.it('4.1. Admin summary returns counts (not revenue)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/summary`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const s = body.summary;
    assert.ok(typeof s.locations.total === 'number');
    assert.ok(typeof s.locations.draft === 'number');
    assert.ok(typeof s.slots.total === 'number');
    assert.ok(typeof s.users.total === 'number');
    assert.ok(typeof s.bookings.total === 'number');
    // Revenue must not appear
    assert.equal(s.revenue, undefined, 'Summary must not include revenue');
    assert.equal(s.bookings.revenue, undefined, 'Bookings summary must not include revenue');
  });

  test.it('4.2. Admin booking list uses safe user fields only', async () => {
    // Create a minimal booking fixture directly (Stage 6 service is pending)
    const { data: locData } = await createLocation({ name: `Booking List Loc ${testRunId}` });
    const locId = locData.location.id;
    const { data: slotData } = await createSlot(locId, { code: 'BL-01' });
    const slotId = slotData.slot.id;

    const booking = await Booking.create({
      user: normalUser._id,
      location: locData.location.id,
      slot: slotId,
      vehicle: { registrationNumber: 'TEST-LIST-001', type: 'car', label: 'Test Car' },
      locationName: locData.location.name,
      slotCode: 'BL-01',
      pricePerHourPaise: 5000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
      requestId: `req-bl-${Date.now()}`,
    });
    createdBookingIds.push(booking._id);

    // Mark the slot claimed
    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: booking._id } });

    const res = await fetch(`${baseUrl}/api/admin/bookings?limit=100`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.bookings));

    // Find our test booking
    const found = body.bookings.find((b) => b.id === booking._id.toString());
    assert.ok(found, 'Created booking must appear in admin list');
    // Safe user fields only
    assert.ok(found.user, 'Booking must include user info');
    assert.equal(found.user.passwordHash, undefined, 'passwordHash must never appear in booking list');
    assert.equal(found.user.name, normalUser.name);
    assert.equal(found.user.email, normalUser.email);

    // Unset the fake claim
    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: null } });
  });

  test.it('4.3. Admin booking list filter by status works', async () => {
    const res = await fetch(`${baseUrl}/api/admin/bookings?status=active`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.bookings));
    for (const b of body.bookings) {
      assert.equal(b.status, 'active', 'Filtered results must all have active status');
    }
  });

  test.it('4.4. Admin booking list filter by location works', async () => {
    const { data: locData } = await createLocation({ name: `Booking Filter Loc ${testRunId}` });
    const locId = locData.location.id;
    const { data: slotData } = await createSlot(locId, { code: 'BF-01' });

    const booking = await Booking.create({
      user: normalUser._id,
      location: locId,
      slot: slotData.slot.id,
      vehicle: { registrationNumber: 'TEST-FILTER-002', type: 'car', label: 'Filter Car' },
      locationName: locData.location.name,
      slotCode: 'BF-01',
      pricePerHourPaise: 4000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 4000,
      status: 'completed',
      requestId: `req-bf-${Date.now()}`,
    });
    createdBookingIds.push(booking._id);

    const res = await fetch(`${baseUrl}/api/admin/bookings?location=${locId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const b of body.bookings) {
      assert.equal(b.location, locId, 'Filtered bookings must all belong to the requested location');
    }
    const found = body.bookings.find((b) => b.id === booking._id.toString());
    assert.ok(found, 'Test booking must appear in location-filtered list');
  });

  // ═══════════════════════════════════════════════════════════
  // 5. STAGE 5 REPAIR & EXPANDED CHECKS
  // ═══════════════════════════════════════════════════════════

  test.it('5.1. Public slot filters: zone, available, and occupied filters work properly', async () => {
    const { data: locData } = await createLocation({ name: `Public Filter Loc ${testRunId}` });
    const locId = locData.location.id;

    // Create 4 slots:
    // Slot A1: Zone A, enabled, unclaimed (available)
    await createSlot(locId, { code: 'A-101', zone: 'A' });
    // Slot A2: Zone A, enabled, claimed (occupied)
    const { data: sA2 } = await createSlot(locId, { code: 'A-102', zone: 'A' });
    // Slot B1: Zone B, enabled, unclaimed (available)
    await createSlot(locId, { code: 'B-101', zone: 'B' });
    // Slot B2: Zone B, maintenance (should never appear in public slots)
    const { data: sB2 } = await createSlot(locId, { code: 'B-102', zone: 'B' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}/slots/${sB2.slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ serviceStatus: 'maintenance' }),
    });

    // Simulate active booking on A2
    const fakeBooking = await Booking.create({
      user: normalUser._id,
      location: locId,
      slot: sA2.slot.id,
      vehicle: { registrationNumber: 'OCC-001', type: 'car', label: 'Car' },
      locationName: locData.location.name,
      slotCode: 'A-102',
      pricePerHourPaise: 5000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
      requestId: `req-filter-${Date.now()}`,
    });
    createdBookingIds.push(fakeBooking._id);
    await ParkingSlot.updateOne({ _id: sA2.slot.id }, { $set: { activeBooking: fakeBooking._id } });

    // Activate the location
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    // 1. Unfiltered public slots: returns all 3 enabled slots (A1, A2, B1), excludes maintenance B2
    const resAll = await fetch(`${baseUrl}/api/locations/${locId}/slots`);
    assert.equal(resAll.status, 200);
    const bodyAll = await resAll.json();
    assert.equal(bodyAll.slots.length, 3, 'Must return only the 3 enabled slots');
    const codesAll = bodyAll.slots.map((s) => s.code);
    assert.ok(codesAll.includes('A-101'));
    assert.ok(codesAll.includes('A-102'));
    assert.ok(codesAll.includes('B-101'));
    assert.ok(!codesAll.includes('B-102'), 'Maintenance slot must not be in public slots');

    // 2. Filter by ?zone=A: returns A1 and A2
    const resZoneA = await fetch(`${baseUrl}/api/locations/${locId}/slots?zone=A`);
    assert.equal(resZoneA.status, 200);
    const bodyZoneA = await resZoneA.json();
    assert.equal(bodyZoneA.slots.length, 2);
    assert.ok(bodyZoneA.slots.every((s) => s.zone === 'A'));

    // 3. Filter by ?status=available: returns A1 and B1 (activeBooking = null)
    const resAvail = await fetch(`${baseUrl}/api/locations/${locId}/slots?status=available`);
    assert.equal(resAvail.status, 200);
    const bodyAvail = await resAvail.json();
    assert.equal(bodyAvail.slots.length, 2);
    const availCodes = bodyAvail.slots.map((s) => s.code);
    assert.ok(availCodes.includes('A-101'));
    assert.ok(availCodes.includes('B-101'));
    assert.ok(bodyAvail.slots.every((s) => s.available === true));

    // 4. Filter by ?status=occupied: returns A2 only (activeBooking != null)
    const resOcc = await fetch(`${baseUrl}/api/locations/${locId}/slots?status=occupied`);
    assert.equal(resOcc.status, 200);
    const bodyOcc = await resOcc.json();
    assert.equal(bodyOcc.slots.length, 1);
    assert.equal(bodyOcc.slots[0].code, 'A-102');
    assert.equal(bodyOcc.slots[0].available, false);

    // 5. Combined filter: ?zone=A&status=available -> A1 only
    const resZoneAvail = await fetch(`${baseUrl}/api/locations/${locId}/slots?zone=A&status=available`);
    assert.equal(resZoneAvail.status, 200);
    const bodyZoneAvail = await resZoneAvail.json();
    assert.equal(bodyZoneAvail.slots.length, 1);
    assert.equal(bodyZoneAvail.slots[0].code, 'A-101');

    // 6. Combined filter: ?zone=A&status=occupied -> A2 only
    const resZoneOcc = await fetch(`${baseUrl}/api/locations/${locId}/slots?zone=A&status=occupied`);
    assert.equal(resZoneOcc.status, 200);
    const bodyZoneOcc = await resZoneOcc.json();
    assert.equal(bodyZoneOcc.slots.length, 1);
    assert.equal(bodyZoneOcc.slots[0].code, 'A-102');

    // Clean up fake claim on A2
    await ParkingSlot.updateOne({ _id: sA2.slot.id }, { $set: { activeBooking: null } });
  });

  test.it('5.2. Invalid public status filter returns safe 400 JSON envelope', async () => {
    const { data: locData } = await createLocation({ name: `Invalid Filter Loc ${testRunId}` });
    const locId = locData.location.id;
    await createSlot(locId, { code: 'INV-01' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    const invalidStatuses = ['maintenance', 'archived', 'all', 'invalid', 'reserved'];
    for (const st of invalidStatuses) {
      const res = await fetch(`${baseUrl}/api/locations/${locId}/slots?status=${st}`);
      assert.equal(res.status, 400, `Status '${st}' must be rejected with 400`);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'INVALID_STATUS_FILTER');
      assert.ok(typeof body.message === 'string');
    }
  });

  test.it('5.3. Public detail includes correct totalSlots (non-archived) and availableSlots', async () => {
    const { data: locData } = await createLocation({ name: `Detail Counts Loc ${testRunId}` });
    const locId = locData.location.id;

    // Slot 1: enabled, available
    await createSlot(locId, { code: 'CNT-01' });
    // Slot 2: enabled, claimed (occupied)
    const { data: s2 } = await createSlot(locId, { code: 'CNT-02' });
    // Slot 3: maintenance (non-archived, but not available)
    const { data: s3 } = await createSlot(locId, { code: 'CNT-03' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}/slots/${s3.slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ serviceStatus: 'maintenance' }),
    });
    // Slot 4: archived (should NOT count in totalSlots or availableSlots)
    const { data: s4 } = await createSlot(locId, { code: 'CNT-04' });
    await fetch(`${baseUrl}/api/admin/locations/${locId}/slots/${s4.slot.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ serviceStatus: 'archived' }),
    });

    // Simulate active booking on slot 2
    const fakeBooking = await Booking.create({
      user: normalUser._id,
      location: locId,
      slot: s2.slot.id,
      vehicle: { registrationNumber: 'CNT-OCC-01', type: 'car', label: 'Car' },
      locationName: locData.location.name,
      slotCode: 'CNT-02',
      pricePerHourPaise: 5000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
      requestId: `req-cnt-${Date.now()}`,
    });
    createdBookingIds.push(fakeBooking._id);
    await ParkingSlot.updateOne({ _id: s2.slot.id }, { $set: { activeBooking: fakeBooking._id } });

    // Activate location
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    const res = await fetch(`${baseUrl}/api/locations/${locId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    // Non-archived total: s1 (enabled) + s2 (enabled) + s3 (maintenance) = 3
    assert.equal(body.location.totalSlots, 3, 'totalSlots must count non-archived slots (3)');
    // Available slots: s1 only (enabled and activeBooking === null) = 1
    assert.equal(body.location.availableSlots, 1, 'availableSlots must count enabled unclaimed slots (1)');

    // Now close the location and verify detail still returns totalSlots, availableSlots, but unavailable = true
    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'closed' }),
    });

    const closedRes = await fetch(`${baseUrl}/api/locations/${locId}`);
    assert.equal(closedRes.status, 200);
    const closedBody = await closedRes.json();
    assert.equal(closedBody.location.totalSlots, 3);
    assert.equal(closedBody.location.availableSlots, 1);
    assert.equal(closedBody.location.unavailable, true);
    assert.ok(closedBody.location.unavailableReason);

    // Clean up fake claim
    await ParkingSlot.updateOne({ _id: s2.slot.id }, { $set: { activeBooking: null } });
  });

  test.it('5.4. Same-request draft-to-active update works when it supplies missing fields', async () => {
    // Create draft location missing address, city, area, latitude, longitude
    const createRes = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: `Same Req Publish Loc ${testRunId}`,
        category: 'mall',
      }),
    });
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    const locId = createData.location.id;
    createdLocationIds.push(locId);

    // Add an enabled slot to satisfy the slot precondition
    await createSlot(locId, { code: 'SR-01' });

    // Single PATCH supplying missing fields AND setting status: 'active'
    const patchRes = await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        address: '99 Marine Drive',
        city: 'Mumbai',
        area: 'Nariman Point',
        latitude: 18.9256,
        longitude: 72.8242,
        status: 'active',
      }),
    });
    assert.equal(patchRes.status, 200, 'Same-request draft-to-active PATCH must succeed');
    const patchBody = await patchRes.json();
    assert.equal(patchBody.success, true);
    assert.equal(patchBody.location.status, 'active');
    assert.equal(patchBody.location.address, '99 Marine Drive');
    assert.equal(patchBody.location.city, 'Mumbai');
    assert.equal(patchBody.location.area, 'Nariman Point');

    // Verify database persisted state
    const dbDoc = await ParkingLocation.findById(locId);
    assert.equal(dbDoc.status, 'active');
    assert.equal(dbDoc.address, '99 Marine Drive');

    // Public detail now returns 200
    const pubRes = await fetch(`${baseUrl}/api/locations/${locId}`);
    assert.equal(pubRes.status, 200);
    assert.equal((await pubRes.json()).location.status, 'active');
  });

  test.it('5.5. Duplicate location names get distinct safe auto-suffixed slugs (-2, -3) and do not overwrite', async () => {
    const commonName = `Duplicate Mall ${testRunId}`;

    // 1st location
    const res1 = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: commonName, category: 'mall' }),
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    const loc1 = data1.location;
    createdLocationIds.push(loc1.id);

    // 2nd location with exact same name
    const res2 = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: commonName, category: 'mall' }),
    });
    assert.equal(res2.status, 201, 'Duplicate name location must be created with suffixed slug');
    const data2 = await res2.json();
    const loc2 = data2.location;
    createdLocationIds.push(loc2.id);

    // 3rd location with exact same name
    const res3 = await fetch(`${baseUrl}/api/admin/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: commonName, category: 'mall' }),
    });
    assert.equal(res3.status, 201);
    const data3 = await res3.json();
    const loc3 = data3.location;
    createdLocationIds.push(loc3.id);

    // Slugs must be distinct with -2, -3 suffixes
    assert.notEqual(loc1.id, loc2.id, 'IDs must be distinct');
    assert.notEqual(loc2.id, loc3.id, 'IDs must be distinct');
    assert.equal(loc2.slug, `${loc1.slug}-2`, 'Second location must have -2 suffix');
    assert.equal(loc3.slug, `${loc1.slug}-3`, 'Third location must have -3 suffix');

    // Confirm all 3 exist concurrently in MongoDB (none was overwritten)
    const count = await ParkingLocation.countDocuments({
      _id: { $in: [loc1.id, loc2.id, loc3.id] },
    });
    assert.equal(count, 3, 'All 3 locations must exist in database simultaneously');
  });

  test.it('5.6. Public slot responses never leak private booking or user information', async () => {
    const { data: locData } = await createLocation({ name: `Privacy Check Loc ${testRunId}` });
    const locId = locData.location.id;
    const { data: slotData } = await createSlot(locId, { code: 'PRIV-01' });
    const slotId = slotData.slot.id;

    // Create a real booking for this slot
    const booking = await Booking.create({
      user: normalUser._id,
      location: locId,
      slot: slotId,
      vehicle: { registrationNumber: 'LEAK-TEST-99', type: 'car', label: 'Leak Check' },
      locationName: locData.location.name,
      slotCode: 'PRIV-01',
      pricePerHourPaise: 6000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 6000,
      status: 'active',
      requestId: `req-priv-${Date.now()}`,
    });
    createdBookingIds.push(booking._id);
    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: booking._id } });

    await fetch(`${baseUrl}/api/admin/locations/${locId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: 'active' }),
    });

    const res = await fetch(`${baseUrl}/api/locations/${locId}/slots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slots.length, 1);
    const slot = body.slots[0];

    // Assert strictly on zero leaked booking/user fields
    assert.equal(slot.activeBooking, undefined, 'activeBooking ref must not be exposed');
    assert.equal(slot.user, undefined, 'user must not be exposed');
    assert.equal(slot.booking, undefined, 'booking must not be exposed');
    assert.equal(slot.requestId, undefined, 'requestId must not be exposed');
    assert.equal(slot.vehicle, undefined, 'vehicle must not be exposed');
    assert.equal(slot.available, false, 'Claimed slot has available: false');

    const jsonString = JSON.stringify(body);
    assert.ok(!jsonString.includes(booking._id.toString()), 'Booking ID must not appear anywhere in JSON');
    assert.ok(!jsonString.includes(normalUser._id.toString()), 'User ID must not appear anywhere in JSON');
    assert.ok(!jsonString.includes('LEAK-TEST-99'), 'Vehicle registration must not appear anywhere in JSON');

    await ParkingSlot.updateOne({ _id: slotId }, { $set: { activeBooking: null } });
  });
});
