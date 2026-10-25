// tests/integration.test.js — Stage 3 Integration Tests (TEST_MONGODB_URI only)
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDatabaseConfig } = require('../server/config/env');
const { connectDB, disconnectDB } = require('../server/config/db');
const {
  User,
  ParkingLocation,
  ParkingSlot,
  Booking,
  Vehicle,
} = require('../server/models');
const { seedDemo } = require('../server/scripts/seedDemo');

test.describe('Stage 3 Integration Tests', () => {
  // Test-run specific ID tracking to ensure strictly scoped cleanup
  const testRunId = `t${Date.now()}`;
  const testUserIds = [];
  const testLocationIds = [];
  const testSlotIds = [];
  const testBookingIds = [];
  const testVehicleIds = [];

  /**
   * Safe, scoped cleanup function that cleans ONLY test-run records
   * in strict dependency order.
   *
   * @param {Object} [scope]
   */
  async function performScopedCleanup(scope = {}) {
    const bookingIds = scope.bookingIds || testBookingIds;
    const slotIds = scope.slotIds || testSlotIds;
    const locationIds = scope.locationIds || testLocationIds;
    const vehicleIds = scope.vehicleIds || testVehicleIds;
    const userIds = scope.userIds || testUserIds;

    // Strict dependency order:
    // 1. Bookings
    if (bookingIds.length > 0) {
      await Booking.deleteMany({ _id: { $in: bookingIds } });
    }
    // 2. Slots (either explicitly tracked slot IDs or slots belonging to tracked locations)
    const slotConditions = [];
    if (slotIds.length > 0) slotConditions.push({ _id: { $in: slotIds } });
    if (locationIds.length > 0) slotConditions.push({ location: { $in: locationIds } });
    if (slotConditions.length > 0) {
      await ParkingSlot.deleteMany({ $or: slotConditions });
    }
    // 3. Locations
    if (locationIds.length > 0) {
      await ParkingLocation.deleteMany({ _id: { $in: locationIds } });
    }
    // 4. Vehicles
    if (vehicleIds.length > 0) {
      await Vehicle.deleteMany({ _id: { $in: vehicleIds } });
    }
    // 5. Users
    if (userIds.length > 0) {
      await User.deleteMany({ _id: { $in: userIds } });
    }
  }

  test.before(async () => {
    // 1. Strict Target Validation: Ensure integration tests run ONLY against TEST_MONGODB_URI
    const config = validateDatabaseConfig({ isTest: true });
    assert.ok(config.testDbName, 'TEST_MONGODB_URI must specify an explicit database');
    assert.notEqual(
      config.testDbName.toLowerCase(),
      (config.appDbName || '').toLowerCase(),
      'Integration tests refused: test database cannot be identical to application database'
    );

    await connectDB({ isTest: true });

    // Ensure all schema indexes are synchronized in the test database
    await Promise.all([
      User.init(),
      ParkingLocation.init(),
      ParkingSlot.init(),
      Booking.init(),
      Vehicle.init(),
    ]);

    // Clean up any legacy un-namespaced test records from previous runs on TEST_MONGODB_URI
    const legacyLocs = await ParkingLocation.find({
      slug: { $in: ['phoenix-grand-mall', 'st-jude-hospital', 'cybertech-towers'] },
    });
    if (legacyLocs.length > 0) {
      const legacyIds = legacyLocs.map((l) => l._id);
      await ParkingSlot.deleteMany({ location: { $in: legacyIds } });
      await ParkingLocation.deleteMany({ _id: { $in: legacyIds } });
    }
  });

  test.after(async () => {
    // Clean up test-specific fixtures in dependency order
    try {
      await performScopedCleanup();
    } finally {
      await disconnectDB();
    }
  });

  test.it('1. Required indexes are created across all models', async () => {
    const userIndexes = await User.collection.indexes();
    assert.ok(
      userIndexes.some((idx) => idx.key.email === 1 && idx.unique),
      'User must have unique index on email'
    );

    const locIndexes = await ParkingLocation.collection.indexes();
    assert.ok(
      locIndexes.some((idx) => idx.key.slug === 1 && idx.unique),
      'ParkingLocation must have unique index on slug'
    );

    const slotIndexes = await ParkingSlot.collection.indexes();
    assert.ok(
      slotIndexes.some((idx) => idx.key.location === 1 && idx.key.code === 1 && idx.unique),
      'ParkingSlot must have compound unique index on { location, code }'
    );

    const bookingIndexes = await Booking.collection.indexes();
    const activeSlotIdx = bookingIndexes.find((idx) => idx.key.slot === 1 && idx.unique);
    assert.ok(activeSlotIdx, 'Booking must have unique index on slot for concurrency control');
    assert.deepEqual(
      activeSlotIdx.partialFilterExpression,
      { status: 'active' },
      'Booking slot index must be partial for status: active'
    );

    assert.ok(
      bookingIndexes.some((idx) => idx.key.user === 1 && idx.key.requestId === 1 && idx.unique),
      'Booking must have unique compound index on { user, requestId }'
    );

    const vehicleIndexes = await Vehicle.collection.indexes();
    assert.ok(
      vehicleIndexes.some((idx) => idx.key.owner === 1 && idx.key.registrationNumber === 1 && idx.unique),
      'Vehicle must have unique compound index on { owner, registrationNumber }'
    );
  });

  test.it('2. Slot code uniqueness in one location vs different locations', async () => {
    const locA = await ParkingLocation.create({
      slug: `test-loc-a-${Date.now()}`,
      name: 'Test Location Alpha',
      category: 'mall',
      address: '123 Alpha St',
      city: 'Mumbai',
      area: 'Andheri',
      contactPhone: '+91 99999 11111',
      latitude: 19.1,
      longitude: 72.8,
      status: 'active',
    });
    testLocationIds.push(locA._id);

    const locB = await ParkingLocation.create({
      slug: `test-loc-b-${Date.now()}`,
      name: 'Test Location Beta',
      category: 'office',
      address: '456 Beta Ave',
      city: 'Pune',
      area: 'Baner',
      contactPhone: '+91 99999 22222',
      latitude: 18.5,
      longitude: 73.8,
      status: 'active',
    });
    testLocationIds.push(locB._id);

    // Create slot A-01 in locA
    const slotA1 = await ParkingSlot.create({
      location: locA._id,
      code: 'A-01',
      zone: 'A',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      distanceFromEntry: 10,
    });
    testSlotIds.push(slotA1._id);

    // Duplicate slot A-01 in SAME location locA must be rejected
    await assert.rejects(
      async () => {
        const dup = await ParkingSlot.create({
          location: locA._id,
          code: 'A-01',
          zone: 'A',
          floor: 0,
          vehicleType: 'car',
          pricePerHourPaise: 6000,
          distanceFromEntry: 12,
        });
        testSlotIds.push(dup._id);
      },
      (err) => err.code === 11000 || /duplicate key/i.test(err.message),
      'Duplicate slot code in the same location must be rejected by unique index'
    );

    // Slot A-01 in DIFFERENT location locB must SUCCEED
    const slotB1 = await ParkingSlot.create({
      location: locB._id,
      code: 'A-01',
      zone: 'A',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 4000,
      distanceFromEntry: 15,
    });
    testSlotIds.push(slotB1._id);

    assert.equal(slotB1.code, 'A-01');
    assert.equal(slotB1.location.toString(), locB._id.toString());
  });

  test.it('3. Coordinate validation handles limits and zero correctly', async () => {
    // 0, 0 (Equator / Prime Meridian) must be valid
    const zeroLoc = new ParkingLocation({
      slug: `test-zero-coord-${Date.now()}`,
      name: 'Zero Island Station',
      category: 'other',
      address: 'Null Island',
      city: 'Atlantic',
      area: 'Ocean',
      contactPhone: '+91 90000 00000',
      latitude: 0,
      longitude: 0,
    });
    const zeroValErr = zeroLoc.validateSync();
    assert.equal(zeroValErr, undefined, 'Coordinates (0, 0) must be accepted as valid');

    // Extremes: -90, -180 and 90, 180
    const edgeLoc = new ParkingLocation({
      slug: `test-edge-coord-${Date.now()}`,
      name: 'Edge Coordinates Station',
      category: 'other',
      address: 'Poles',
      city: 'Global',
      area: 'Global',
      contactPhone: '+91 90000 00000',
      latitude: -90,
      longitude: 180,
    });
    assert.equal(edgeLoc.validateSync(), undefined, 'Latitude -90 and longitude 180 must be valid');

    // Invalid coordinates beyond boundaries
    const invalidLat = new ParkingLocation({
      slug: `test-inv-lat-${Date.now()}`,
      name: 'Invalid Lat Station',
      category: 'other',
      address: 'Nowhere',
      city: 'Nowhere',
      area: 'Nowhere',
      contactPhone: '+91 90000 00000',
      latitude: 90.001,
      longitude: 50,
    });
    assert.ok(invalidLat.validateSync().errors.latitude, 'Latitude > 90 must fail validation');

    const invalidLng = new ParkingLocation({
      slug: `test-inv-lng-${Date.now()}`,
      name: 'Invalid Lng Station',
      category: 'other',
      address: 'Nowhere',
      city: 'Nowhere',
      area: 'Nowhere',
      contactPhone: '+91 90000 00000',
      latitude: 50,
      longitude: -180.001,
    });
    assert.ok(invalidLng.validateSync().errors.longitude, 'Longitude < -180 must fail validation');
  });

  test.it('4. User passwordHash is hidden by default', async () => {
    const user = await User.create({
      name: 'Test Isolation User',
      email: `test-user-${Date.now()}@example.com`,
      phone: '+91 91234 56789',
      passwordHash: 'secret_bcrypt_hash_placeholder',
      role: 'user',
    });
    testUserIds.push(user._id);

    // Default query: select: false hides passwordHash
    const fetched = await User.findById(user._id).lean();
    assert.equal(fetched.passwordHash, undefined, 'passwordHash must be omitted by default');

    // Explicit select('+passwordHash') reveals it for authentication
    const withSecret = await User.findById(user._id).select('+passwordHash').lean();
    assert.equal(withSecret.passwordHash, 'secret_bcrypt_hash_placeholder');
  });

  test.it('5. Booking slot concurrency allows only one active booking per slot', async () => {
    const loc = await ParkingLocation.create({
      slug: `test-booking-loc-${Date.now()}`,
      name: 'Booking Test Loc',
      category: 'mall',
      address: 'Test Rd',
      city: 'Mumbai',
      area: 'Central',
      contactPhone: '+91 98888 77777',
      latitude: 19.0,
      longitude: 72.8,
    });
    testLocationIds.push(loc._id);

    const slot = await ParkingSlot.create({
      location: loc._id,
      code: 'BK-01',
      zone: 'B',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      distanceFromEntry: 10,
    });
    testSlotIds.push(slot._id);

    const userA = await User.create({
      name: 'User A',
      email: `user-a-${Date.now()}@example.com`,
      phone: '+91 98888 11111',
      passwordHash: 'hash_a',
    });
    testUserIds.push(userA._id);

    const userB = await User.create({
      name: 'User B',
      email: `user-b-${Date.now()}@example.com`,
      phone: '+91 98888 22222',
      passwordHash: 'hash_b',
    });
    testUserIds.push(userB._id);

    // Booking 1: active on slot BK-01
    const booking1 = await Booking.create({
      user: userA._id,
      location: loc._id,
      slot: slot._id,
      vehicle: { registrationNumber: 'MH-01-AA-1111', type: 'car', label: 'Car A' },
      locationName: loc.name,
      slotCode: slot.code,
      pricePerHourPaise: 5000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
      requestId: `req-1-${Date.now()}`,
    });
    testBookingIds.push(booking1._id);

    // Booking 2: another active booking on same slot must be REJECTED by partial index
    await assert.rejects(
      async () => {
        const dupActive = await Booking.create({
          user: userB._id,
          location: loc._id,
          slot: slot._id,
          vehicle: { registrationNumber: 'MH-02-BB-2222', type: 'car', label: 'Car B' },
          locationName: loc.name,
          slotCode: slot.code,
          pricePerHourPaise: 5000,
          startTime: new Date(),
          endTime: new Date(Date.now() + 3600000),
          durationHours: 1,
          totalPaise: 5000,
          status: 'active',
          requestId: `req-2-${Date.now()}`,
        });
        testBookingIds.push(dupActive._id);
      },
      (err) => err.code === 11000 || /duplicate key/i.test(err.message),
      'Concurrent active booking on same slot must be rejected'
    );

    // However, a completed or cancelled booking on the same slot must SUCCEED
    const bookingCompleted = await Booking.create({
      user: userB._id,
      location: loc._id,
      slot: slot._id,
      vehicle: { registrationNumber: 'MH-02-BB-2222', type: 'car', label: 'Car B' },
      locationName: loc.name,
      slotCode: slot.code,
      pricePerHourPaise: 5000,
      startTime: new Date(Date.now() - 7200000),
      endTime: new Date(Date.now() - 3600000),
      durationHours: 1,
      totalPaise: 5000,
      status: 'completed',
      requestId: `req-3-${Date.now()}`,
    });
    testBookingIds.push(bookingCompleted._id);
    assert.equal(bookingCompleted.status, 'completed');
  });

  test.it('6. Isolated test seed creates 3 locations, 84 slots, and preserves edits across rerun', async () => {
    const seedPrefix = `${testRunId}-demo`;

    // Run isolated seed first time
    const result1 = await seedDemo({ isTest: true, slugPrefix: seedPrefix });
    assert.equal(result1.totalLocations, 3, 'Must have exactly 3 demo locations in test namespace');
    assert.equal(result1.totalSlots, 84, 'Must have exactly 84 demo slots in test namespace');

    // Register created location IDs for scoped cleanup
    for (const locId of result1.locationIds) {
      testLocationIds.push(locId);
    }

    // Verify mall location has 60 slots and all slots are available (activeBooking: null)
    const mallSlug = `${seedPrefix}-phoenix-grand-mall`;
    const mall = await ParkingLocation.findOne({ slug: mallSlug });
    assert.ok(mall, `Mall with slug ${mallSlug} must exist`);

    const mallSlots = await ParkingSlot.find({ location: mall._id });
    assert.equal(mallSlots.length, 60, 'Phoenix Grand Mall must have 60 slots');
    for (const s of mallSlots) {
      assert.equal(s.activeBooking, null, 'Slot must not have active booking without real booking document');
      assert.equal(s.serviceStatus, 'enabled', 'Fresh slot must be enabled');
    }

    // Verify hospital and office have 12 slots each
    const hospital = await ParkingLocation.findOne({ slug: `${seedPrefix}-st-jude-hospital` });
    const hospitalSlots = await ParkingSlot.find({ location: hospital._id });
    assert.equal(hospitalSlots.length, 12, 'Hospital must have 12 slots');

    const office = await ParkingLocation.findOne({ slug: `${seedPrefix}-cybertech-towers` });
    const officeSlots = await ParkingSlot.find({ location: office._id });
    assert.equal(officeSlots.length, 12, 'Office must have 12 slots');

    // Simulate an admin editing a price on slot A-01 in the mall
    const slotA1 = await ParkingSlot.findOne({ location: mall._id, code: 'A-01' });
    assert.ok(slotA1, 'Slot A-01 must exist');
    const originalPrice = slotA1.pricePerHourPaise;
    const customAdminPrice = 9999; // ₹99.99

    await ParkingSlot.updateOne({ _id: slotA1._id }, { $set: { pricePerHourPaise: customAdminPrice } });

    // Run seed SECOND time with the same test namespace
    const result2 = await seedDemo({ isTest: true, slugPrefix: seedPrefix });
    assert.equal(result2.totalLocations, 3, 'Total locations must remain 3 after rerun');
    assert.equal(result2.totalSlots, 84, 'Total slots must remain 84 after rerun');

    // Check slot A-01 again — price must NOT have been overwritten
    const slotA1After = await ParkingSlot.findById(slotA1._id);
    assert.equal(
      slotA1After.pricePerHourPaise,
      customAdminPrice,
      `Seed rerun must NOT overwrite custom price (${customAdminPrice} paise vs original ${originalPrice})`
    );
  });

  test.it('7. Scoped cleanup removes only test-run records and leaves unrelated records untouched', async () => {
    // 1. Create an unrelated canary record (simulating another test run or persistent record)
    const canaryLoc = await ParkingLocation.create({
      slug: `canary-keep-${Date.now()}`,
      name: 'Unrelated Canary Location',
      category: 'other',
      address: 'Canary Rd',
      city: 'Delhi',
      area: 'Aerocity',
      contactPhone: '+91 99999 00000',
      latitude: 28.5,
      longitude: 77.1,
      status: 'active',
    });

    // 2. Create a targeted temporary location that should be removed by cleanup
    const doomedLoc = await ParkingLocation.create({
      slug: `doomed-temp-${Date.now()}`,
      name: 'Doomed Temporary Location',
      category: 'other',
      address: 'Doomed Rd',
      city: 'Delhi',
      area: 'Aerocity',
      contactPhone: '+91 99999 00001',
      latitude: 28.5,
      longitude: 77.1,
      status: 'active',
    });

    const doomedSlot = await ParkingSlot.create({
      location: doomedLoc._id,
      code: 'D-01',
      zone: 'D',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 3000,
      distanceFromEntry: 5,
    });

    // 3. Perform scoped cleanup targeting ONLY the doomed fixture
    await performScopedCleanup({
      bookingIds: [],
      slotIds: [doomedSlot._id],
      locationIds: [doomedLoc._id],
      vehicleIds: [],
      userIds: [],
    });

    // 4. Assert: Doomed records were deleted
    const doomedLocAfter = await ParkingLocation.findById(doomedLoc._id);
    assert.equal(doomedLocAfter, null, 'Doomed location must be deleted by scoped cleanup');

    const doomedSlotAfter = await ParkingSlot.findById(doomedSlot._id);
    assert.equal(doomedSlotAfter, null, 'Doomed slot must be deleted by scoped cleanup');

    // 5. Assert: Canary record was NOT deleted
    const canaryAfter = await ParkingLocation.findById(canaryLoc._id);
    assert.ok(canaryAfter, 'Unrelated canary record must NOT be deleted by scoped cleanup');
    assert.equal(canaryAfter.slug, canaryLoc.slug);

    // Clean up the canary explicitly
    await ParkingLocation.deleteOne({ _id: canaryLoc._id });
  });
});
