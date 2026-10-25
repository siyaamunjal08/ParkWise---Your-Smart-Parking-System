// server/scripts/seedDemo.js — Non-destructive demo seeder
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { connectDB, disconnectDB } = require('../config/db');
const { ParkingLocation, ParkingSlot } = require('../models');

/**
 * Build 12 slots for St. Jude Care Hospital Parking
 * @param {ObjectId} locationId
 * @returns {Array<Object>}
 */
function buildHospitalSlots(locationId) {
  const slots = [];
  // H-01 to H-04: Car
  for (let i = 1; i <= 4; i++) {
    slots.push({
      location: locationId,
      code: `H-0${i}`,
      zone: 'H',
      floor: 0,
      vehicleType: 'car',
      pricePerHourPaise: 6000,
      distanceFromEntry: 5 + i * 2,
      features: ['covered', 'cctv', 'disabled-friendly', 'emergency-access'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  // H-05 to H-08: EV
  for (let i = 5; i <= 8; i++) {
    slots.push({
      location: locationId,
      code: `H-0${i}`,
      zone: 'H',
      floor: 0,
      vehicleType: 'ev',
      pricePerHourPaise: 7500,
      distanceFromEntry: 15 + (i - 4) * 3,
      features: ['ev-charging', 'covered', 'cctv'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  // H-09 to H-12: Bike
  for (let i = 9; i <= 12; i++) {
    const code = i < 10 ? `H-0${i}` : `H-${i}`;
    slots.push({
      location: locationId,
      code,
      zone: 'H',
      floor: 0,
      vehicleType: 'bike',
      pricePerHourPaise: 2500,
      distanceFromEntry: 10 + (i - 8) * 2,
      features: ['covered', 'cctv'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  return slots;
}

/**
 * Build 12 slots for CyberTech Towers Hub
 * @param {ObjectId} locationId
 * @returns {Array<Object>}
 */
function buildOfficeSlots(locationId) {
  const slots = [];
  // T-01 to T-04: Car
  for (let i = 1; i <= 4; i++) {
    slots.push({
      location: locationId,
      code: `T-0${i}`,
      zone: 'T',
      floor: -1,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      distanceFromEntry: 10 + i * 2,
      features: ['covered', 'cctv', 'automated-barrier'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  // T-05 to T-08: EV
  for (let i = 5; i <= 8; i++) {
    slots.push({
      location: locationId,
      code: `T-0${i}`,
      zone: 'T',
      floor: -1,
      vehicleType: 'ev',
      pricePerHourPaise: 7000,
      distanceFromEntry: 15 + (i - 4) * 2,
      features: ['ev-fast-charging', 'covered', 'cctv'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  // T-09 to T-12: Bike
  for (let i = 9; i <= 12; i++) {
    const code = i < 10 ? `T-0${i}` : `T-${i}`;
    slots.push({
      location: locationId,
      code,
      zone: 'T',
      floor: 0,
      vehicleType: 'bike',
      pricePerHourPaise: 2000,
      distanceFromEntry: 8 + (i - 8) * 2,
      features: ['covered', 'cctv'],
      serviceStatus: 'enabled',
      activeBooking: null,
    });
  }
  return slots;
}

/**
 * Primary seed routine.
 * Seeds exactly 3 fictional demo locations and 84 total slots.
 * Completely idempotent: uses $setOnInsert so existing prices, active bookings,
 * and admin customizations are preserved intact.
 *
 * @param {Object} [options]
 * @param {boolean} [options.isTest=false]
 * @returns {Promise<{ locationsCreated: number, slotsCreated: number, totalLocations: number, totalSlots: number }>}
 */
async function seedDemo(options = {}) {
  const isTest = Boolean(options.isTest);

  // 1. Read original template safely using fs/promises & path
  const templatePath = path.resolve(__dirname, '..', '..', 'data', 'parking.json');
  let rawJson;
  try {
    rawJson = await fs.readFile(templatePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read demo parking template at ${templatePath}: ${err.message}`);
  }

  let parsedTemplate;
  try {
    parsedTemplate = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid JSON format in template: ${err.message}`);
  }

  if (!parsedTemplate || !Array.isArray(parsedTemplate.slots) || parsedTemplate.slots.length !== 60) {
    throw new Error(`Template validation failed: expected 60 slots in data/parking.json, found ${parsedTemplate ? (parsedTemplate.slots || []).length : 0}`);
  }

  // 2. Define exactly 3 clearly fictional demo locations
  const demoLocations = [
    {
      slug: 'phoenix-grand-mall',
      name: 'Phoenix Grand Mall Parking',
      category: 'mall',
      address: 'Sector 12, Tech Park, Mumbai, MH 400001',
      city: 'Mumbai',
      area: 'Sector 12',
      contactPhone: '+91 98765 43210',
      latitude: 19.0760,
      longitude: 72.8777,
      facilities: ['Valet Parking', 'EV Charging', 'CCTV Surveillance', 'Covered Parking', 'Wheelchair Accessible'],
      status: 'active',
      isDemo: true,
      bookingRevision: 0,
      createdBy: null,
    },
    {
      slug: 'st-jude-hospital',
      name: 'St. Jude Care Hospital Parking',
      category: 'hospital',
      address: '88 Health Avenue, Shivaji Nagar, Pune, MH 411005',
      city: 'Pune',
      area: 'Shivaji Nagar',
      contactPhone: '+91 98220 11223',
      latitude: 18.5204,
      longitude: 73.8567,
      facilities: ['Emergency Ambulance Priority', 'Wheelchair Accessible', '24/7 Security', 'Covered Parking'],
      status: 'active',
      isDemo: true,
      bookingRevision: 0,
      createdBy: null,
    },
    {
      slug: 'cybertech-towers',
      name: 'CyberTech Towers Hub',
      category: 'office',
      address: '42 Silicon Corridor, Whitefield, Bengaluru, KA 560066',
      city: 'Bengaluru',
      area: 'Whitefield',
      contactPhone: '+91 98450 33445',
      latitude: 12.9716,
      longitude: 77.5946,
      facilities: ['Fast EV Supercharger', 'Automated Boom Barrier', 'CCTV 24/7', 'Covered Basement', 'App Pre-booking'],
      status: 'active',
      isDemo: true,
      bookingRevision: 0,
      createdBy: null,
    },
  ];

  const rawPrefix = options.slugPrefix || options.namespace || '';
  const slugPrefix = rawPrefix ? `${String(rawPrefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-` : '';

  let locationsUpserted = 0;
  let slotsUpserted = 0;

  // Upsert locations non-destructively
  const locationDocMap = new Map();
  for (const locData of demoLocations) {
    const effectiveSlug = slugPrefix ? `${slugPrefix}${locData.slug}` : locData.slug;
    const payload = { ...locData, slug: effectiveSlug };

    const locRes = await ParkingLocation.findOneAndUpdate(
      { slug: effectiveSlug },
      { $setOnInsert: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!locRes) {
      throw new Error(`Failed to upsert location: ${effectiveSlug}`);
    }
    locationDocMap.set(effectiveSlug, locRes);
  }

  const mallSlug = slugPrefix ? `${slugPrefix}phoenix-grand-mall` : 'phoenix-grand-mall';
  const hospitalSlug = slugPrefix ? `${slugPrefix}st-jude-hospital` : 'st-jude-hospital';
  const officeSlug = slugPrefix ? `${slugPrefix}cybertech-towers` : 'cybertech-towers';

  // Location 1: 60 slots from template
  const mallLoc = locationDocMap.get(mallSlug);
  for (const rawSlot of parsedTemplate.slots) {
    const floorNum = rawSlot.floor === 'G' ? 0 : (parseInt(rawSlot.floor, 10) || 0);
    const pricePaise = Math.round((Number(rawSlot.pricePerHour) || 50) * 100);

    const slotPayload = {
      location: mallLoc._id,
      code: String(rawSlot.id || '').toUpperCase().trim(),
      zone: String(rawSlot.zone || 'A').toUpperCase().trim(),
      floor: floorNum,
      vehicleType: rawSlot.type === 'ev' ? 'ev' : (rawSlot.type === 'bike' ? 'bike' : 'car'),
      pricePerHourPaise: pricePaise,
      distanceFromEntry: Number(rawSlot.distanceFromEntry) || 10,
      features: Array.isArray(rawSlot.features) ? rawSlot.features : [],
      serviceStatus: 'enabled',
      activeBooking: null, // Always available/unclaimed on fresh seed; never occupied without booking
    };

    const res = await ParkingSlot.updateOne(
      { location: mallLoc._id, code: slotPayload.code },
      { $setOnInsert: slotPayload },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (res.upsertedCount > 0) slotsUpserted++;
  }

  // Location 2: 12 slots for Hospital
  const hospitalLoc = locationDocMap.get(hospitalSlug);
  const hospitalSlots = buildHospitalSlots(hospitalLoc._id);
  for (const slotPayload of hospitalSlots) {
    const res = await ParkingSlot.updateOne(
      { location: hospitalLoc._id, code: slotPayload.code },
      { $setOnInsert: slotPayload },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (res.upsertedCount > 0) slotsUpserted++;
  }

  // Location 3: 12 slots for Office Hub
  const officeLoc = locationDocMap.get(officeSlug);
  const officeSlots = buildOfficeSlots(officeLoc._id);
  for (const slotPayload of officeSlots) {
    const res = await ParkingSlot.updateOne(
      { location: officeLoc._id, code: slotPayload.code },
      { $setOnInsert: slotPayload },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (res.upsertedCount > 0) slotsUpserted++;
  }

  const targetSlugs = [mallSlug, hospitalSlug, officeSlug];
  const totalLocations = await ParkingLocation.countDocuments({
    slug: { $in: targetSlugs },
  });

  const totalSlots = await ParkingSlot.countDocuments({
    location: { $in: [mallLoc._id, hospitalLoc._id, officeLoc._id] },
  });

  return {
    locationsCreated: locationsUpserted,
    slotsCreated: slotsUpserted,
    totalLocations,
    totalSlots,
    locationIds: [mallLoc._id, hospitalLoc._id, officeLoc._id],
    locations: [mallLoc, hospitalLoc, officeLoc],
    slugs: targetSlugs,
  };
}

// CLI Execution entry point
if (require.main === module) {
  (async () => {
    const isTest = process.argv.includes('--test');
    console.log(`[Seed Demo] Connecting to ${isTest ? 'TEST' : 'APPLICATION'} database...`);

    try {
      await connectDB({ isTest });
      console.log('[Seed Demo] Executing non-destructive demo seed...');
      const summary = await seedDemo({ isTest });
      console.log(`[Seed Demo] ✅ Complete!`);
      console.log(`[Seed Demo] Demo Locations verified: ${summary.totalLocations}`);
      console.log(`[Seed Demo] Demo Slots verified: ${summary.totalSlots}`);
      console.log(`[Seed Demo] Newly inserted slots in this run: ${summary.slotsCreated}`);
      await disconnectDB();
      process.exit(0);
    } catch (err) {
      console.error(`[Seed Demo] ❌ Failed: ${err.message}`);
      try {
        await disconnectDB();
      } catch (_) {}
      process.exit(1);
    }
  })();
}

module.exports = {
  seedDemo,
};
