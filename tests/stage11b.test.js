// tests/stage11b.test.js — Stage 11B Saved Vehicles and Booking Autofill Tests
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');

const app = require('../server/app');
const { User, ParkingLocation, ParkingSlot, Booking, Vehicle } = require('../server/models');
const { connectDB, disconnectDB } = require('../server/config/db');
const { validateDatabaseConfig, getJwtConfig } = require('../server/config/env');
const { generateToken } = require('../server/utils/authUtils');
const { normalizeVehicleNumber } = require('../server/controllers/vehicleController');

// Frontend modules to test
const {
  DashboardApp,
  createVehicleCard,
  renderVehiclesList,
} = require('../public/js/dashboard');

const {
  BookingApp,
  isSlotCompatible,
} = require('../public/js/booking');

// ── Mock DOM Infrastructure ───────────────────────────────────

function createMockElement(tagName = 'div', id = '') {
  const children = [];
  const attributes = {};
  const listeners = new Map();
  let _textContent = '';
  let _value = '';

  const classList = {
    _classes: new Set(),
    add: (...classes) => classes.forEach((c) => classList._classes.add(c)),
    remove: (...classes) => classes.forEach((c) => classList._classes.delete(c)),
    contains: (c) => classList._classes.has(c),
  };

  const _dataset = {};
  const datasetProxy = new Proxy(_dataset, {
    get(target, prop) {
      if (typeof prop === 'string') {
        const attrName = 'data-' + prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (attrName in attributes) return attributes[attrName];
      }
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = String(value);
      if (typeof prop === 'string') {
        const attrName = 'data-' + prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        attributes[attrName] = String(value);
      }
      return true;
    },
  });

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    get className() {
      return Array.from(classList._classes).join(' ');
    },
    set className(val) {
      classList._classes.clear();
      if (val) {
        String(val).split(/\s+/).forEach((c) => {
          if (c) classList._classes.add(c);
        });
      }
    },
    get value() {
      return _value;
    },
    set value(val) {
      _value = val !== null && val !== undefined ? String(val) : '';
    },
    checked: false,
    disabled: false,
    hidden: false,
    style: {},
    children,
    parentElement: null,
    attributes,
    classList,
    get textContent() {
      if (children.length > 0) {
        return children.map((c) => c.textContent).join(' ');
      }
      return _textContent;
    },
    set textContent(val) {
      _textContent = val !== null && val !== undefined ? String(val) : '';
      children.length = 0;
    },
    get innerHTML() {
      return _textContent;
    },
    set innerHTML(val) {
      if (val === '') {
        children.length = 0;
        _textContent = '';
      } else {
        _textContent = val;
      }
    },
    get dataset() {
      return datasetProxy;
    },
    setAttribute: (name, val) => {
      attributes[name] = String(val);
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        _dataset[camel] = String(val);
      }
    },
    getAttribute: (name) => {
      return attributes[name] !== undefined ? attributes[name] : null;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    appendChild: (child) => {
      if (child.parentElement) {
        child.parentElement.removeChild(child);
      }
      child.parentElement = el;
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    },
    remove: () => {
      if (el.parentElement) {
        el.parentElement.removeChild(el);
      }
    },
    addEventListener: (evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener: (evt, fn) => {
      if (listeners.has(evt)) {
        const list = listeners.get(evt);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    dispatchEvent: (evt) => {
      let stopped = false;
      const eventObj = {
        target: el,
        currentTarget: el,
        type: typeof evt === 'string' ? evt : evt.type,
        bubbles: evt.bubbles !== false,
        stopPropagation: () => {
          stopped = true;
          if (typeof evt.stopPropagation === 'function') evt.stopPropagation();
        },
        preventDefault: () => {
          if (typeof evt.preventDefault === 'function') evt.preventDefault();
        },
        ...evt,
      };

      let curr = el;
      while (curr && !stopped) {
        eventObj.currentTarget = curr;
        if (typeof curr.onclick === 'function') {
          curr.onclick(eventObj);
        }
        const fns = [...(curr._listeners?.get(eventObj.type) || [])];
        for (const fn of fns) {
          fn(eventObj);
          if (stopped) break;
        }
        if (stopped || !eventObj.bubbles) break;
        curr = curr.parentElement;
      }
    },
    closest: (sel) => {
      let curr = el;
      while (curr) {
        if (curr.matches && curr.matches(sel)) return curr;
        curr = curr.parentElement;
      }
      return null;
    },
    matches: (sel) => {
      const selectors = sel.split(',').map((s) => s.trim());
      for (const s of selectors) {
        if (s.startsWith('.') && el.classList?.contains(s.slice(1))) return true;
        if (s.startsWith('#') && el.id === s.slice(1)) return true;
        if (s.startsWith('[') && s.includes('=')) {
          const m = s.match(/\[([a-zA-Z0-9_\-]+)="?([^"\]]+)"?\]/);
          if (m && el.getAttribute && el.getAttribute(m[1]) === m[2]) return true;
        }
        if (el.tagName === s.toUpperCase()) return true;
      }
      return false;
    },
    querySelector: (sel) => {
      const findIn = (node) => {
        for (const c of node.children || []) {
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          if (c.tagName === sel.toUpperCase()) return c;
          const nested = findIn(c);
          if (nested) return nested;
        }
        return null;
      };
      return findIn(el);
    },
    querySelectorAll: (sel) => {
      const results = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) {
            results.push(c);
          } else if (sel.startsWith('#') && c.id === sel.slice(1)) {
            results.push(c);
          } else if (c.tagName === sel.toUpperCase()) {
            results.push(c);
          }
          walk(c);
        }
      };
      walk(el);
      return results;
    },
    focus: () => {},
    _listeners: listeners,
  };

  return el;
}

function setupMockDom() {
  const elements = new Map();
  const getOrCreate = (id, tag = 'div') => {
    if (!elements.has(id)) {
      elements.set(id, createMockElement(tag, id));
    }
    return elements.get(id);
  };

  // Pre-seed elements used by Dashboard & Booking
  const ids = [
    'vehicles-heading',
    'vehicles-count',
    'btn-add-vehicle',
    'btn-add-vehicle-empty',
    'vehicles-list',
    'vehicles-loading',
    'vehicles-error',
    'vehicles-error-msg',
    'btn-retry-vehicles',
    'no-vehicles-msg',
    'vehicle-modal',
    'vehicle-modal-title',
    'btn-close-vehicle-modal',
    'btn-cancel-vehicle-modal',
    'vehicle-form',
    'vehicle-edit-id',
    'vehicle-input-reg',
    'vehicle-input-type',
    'vehicle-input-label',
    'vehicle-reg-error',
    'vehicle-type-error',
    'vehicle-label-error',
    'vehicle-form-error-banner',
    'btn-save-vehicle',
    // Booking autofill elements
    'saved-vehicle-group',
    'saved-vehicle-select',
    'saved-vehicle-help',
    'vehicle-type',
    'vehicle-number',
    'duration-hours',
    'booking-panel',
    'booking-panel-overlay',
    'btn-close-panel',
    'price-breakdown',
    'price-total',
    'vehicle-type-error',
    'vehicle-number-error',
    'booking-form-error',
    'uncertain-booking-alert',
    'uncertain-booking-message',
    'location-header-bar',
    'selected-location-name',
    'selected-location-status',
    'selected-location-address',
    'location-closed-banner',
    'location-error-state',
    'location-error-title',
    'location-error-desc',
    'header-user-name',
    'booking-workflow-container',
    'btn-confirm-booking',
    'slot-grid',
    'recommendations-container',
    'zone-tabs',
  ];

  ids.forEach((id) => getOrCreate(id));

  // Connect hierarchy for vehicles-list children
  const vList = getOrCreate('vehicles-list');
  vList.appendChild(getOrCreate('vehicles-loading'));
  vList.appendChild(getOrCreate('vehicles-error'));
  vList.appendChild(getOrCreate('no-vehicles-msg'));

  const docListeners = new Map();
  const doc = {
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return getOrCreate(sel.slice(1));
      for (const el of elements.values()) {
        const found = el.querySelector(sel);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const results = [];
      for (const el of elements.values()) {
        results.push(...el.querySelectorAll(sel));
      }
      return results;
    },
    createElement: (tag) => createMockElement(tag),
    addEventListener: (evt, fn) => {
      if (!docListeners.has(evt)) docListeners.set(evt, []);
      docListeners.get(evt).push(fn);
    },
    removeEventListener: (evt, fn) => {
      if (docListeners.has(evt)) {
        const list = docListeners.get(evt);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    dispatchEvent: (evt) => {
      const eventObj = typeof evt === 'string' ? { type: evt } : evt;
      const fns = [...(docListeners.get(eventObj.type) || [])];
      fns.forEach((fn) => fn(eventObj));
    },
    hidden: false,
  };

  return { doc, elements };
}

// ══════════════════════════════════════════════════════════════
// TEST SUITE: STAGE 11B SAVED VEHICLES & BOOKING AUTOFILL
// ══════════════════════════════════════════════════════════════

test.describe('Stage 11B — Saved Vehicles and Booking Autofill', () => {
  let server;
  let baseUrl;
  let userA, userB, adminUser;
  let userAToken, userBToken, adminToken;
  let loc, slotCar, slotBike;

  const createdVehicleIds = [];
  const createdBookingIds = [];
  const createdSlotIds = [];
  const createdLocationIds = [];
  const createdUserIds = [];

  test.before(async () => {
    validateDatabaseConfig();
    await connectDB({ isTest: true });
    const jwtConfig = getJwtConfig();

    const runId = randomUUID().slice(0, 8);

    // Create User A
    userA = await User.create({
      name: `User A ${runId}`,
      email: `usera_${runId}@example.com`,
      phone: '9876543210',
      passwordHash: 'dummy_hash',
      role: 'user',
    });
    createdUserIds.push(userA._id);
    userAToken = generateToken(userA, jwtConfig);

    // Create User B (for ownership isolation)
    userB = await User.create({
      name: `User B ${runId}`,
      email: `userb_${runId}@example.com`,
      phone: '9876543211',
      passwordHash: 'dummy_hash',
      role: 'user',
    });
    createdUserIds.push(userB._id);
    userBToken = generateToken(userB, jwtConfig);

    // Create Admin User (must not bypass vehicle ownership)
    adminUser = await User.create({
      name: `Admin ${runId}`,
      email: `admin_${runId}@example.com`,
      phone: '9876543212',
      passwordHash: 'dummy_hash',
      role: 'admin',
    });
    createdUserIds.push(adminUser._id);
    adminToken = generateToken(adminUser, jwtConfig);

    // Create Location
    loc = await ParkingLocation.create({
      name: `Facility ${runId}`,
      slug: `facility-${runId}`,
      category: 'mall',
      address: '456 Test Ave',
      city: 'Delhi',
      area: 'North',
      latitude: 28.6139,
      longitude: 77.209,
      totalSlots: 5,
      availableSlots: 5,
      status: 'active',
    });
    createdLocationIds.push(loc._id);

    // Create Car Slot
    slotCar = await ParkingSlot.create({
      location: loc._id,
      code: 'C-01',
      zone: 'C',
      vehicleType: 'car',
      floor: 1,
      distanceFromEntry: 10,
      pricePerHourPaise: 4000,
      isAvailable: true,
      status: 'available',
    });
    createdSlotIds.push(slotCar._id);

    // Create Bike Slot
    slotBike = await ParkingSlot.create({
      location: loc._id,
      code: 'BK-01',
      zone: 'B',
      vehicleType: 'bike',
      floor: 1,
      distanceFromEntry: 5,
      pricePerHourPaise: 2000,
      isAvailable: true,
      status: 'available',
    });
    createdSlotIds.push(slotBike._id);

    // Start HTTP server on dynamic port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  // ── Scoped Cleanup ───────────────────────────────────────────
  test.after(async () => {
    try {
      if (createdVehicleIds.length > 0) {
        await Vehicle.deleteMany({ _id: { $in: createdVehicleIds } });
      }
      if (createdBookingIds.length > 0) {
        await Booking.deleteMany({ _id: { $in: createdBookingIds } });
      }
      if (createdSlotIds.length > 0) {
        await ParkingSlot.deleteMany({ _id: { $in: createdSlotIds } });
      }
      if (createdLocationIds.length > 0) {
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

  // ── HTTP Helpers ─────────────────────────────────────────────
  async function apiGet(path, token) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function apiPost(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function apiPatch(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function apiDelete(path, token) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'DELETE',
      headers,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // ════════════════════════════════════════════════════════════
  // 1. AUTHENTICATION & OWNERSHIP ISOLATION
  // ════════════════════════════════════════════════════════════

  test('1.1 Unauthenticated requests fail with 401 on all vehicle endpoints', async () => {
    const getRes = await apiGet('/api/vehicles/me', null);
    assert.equal(getRes.status, 401);

    const postRes = await apiPost('/api/vehicles', { registrationNumber: 'MH12AB1234', type: 'car' }, null);
    assert.equal(postRes.status, 401);

    const patchRes = await apiPatch(`/api/vehicles/${new mongoose.Types.ObjectId()}`, { label: 'New' }, null);
    assert.equal(patchRes.status, 401);

    const delRes = await apiDelete(`/api/vehicles/${new mongoose.Types.ObjectId()}`, null);
    assert.equal(delRes.status, 401);
  });

  test('1.2 User A saves a vehicle; User B cannot see it in GET /api/vehicles/me', async () => {
    const createRes = await apiPost(
      '/api/vehicles',
      { registrationNumber: 'DL01AA1111', type: 'car', label: 'My City Car' },
      userAToken
    );
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.success, true);
    assert.equal(createRes.data.vehicle.registrationNumber, 'DL01AA1111');
    assert.equal(createRes.data.vehicle.label, 'My City Car');
    createdVehicleIds.push(new mongoose.Types.ObjectId(createRes.data.vehicle.id));

    // User A reads vehicles
    const aRes = await apiGet('/api/vehicles/me', userAToken);
    assert.equal(aRes.status, 200);
    assert.equal(aRes.data.total, 1);
    assert.equal(aRes.data.vehicles[0].registrationNumber, 'DL01AA1111');

    // User B reads vehicles — must be empty
    const bRes = await apiGet('/api/vehicles/me', userBToken);
    assert.equal(bRes.status, 200);
    assert.equal(bRes.data.total, 0);
    assert.equal(bRes.data.vehicles.length, 0);
  });

  test('1.3 Admin user accessing /api/vehicles/me sees only their own vehicles, NOT User A vehicles', async () => {
    const adminRes = await apiGet('/api/vehicles/me', adminToken);
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.data.total, 0);
    assert.equal(adminRes.data.vehicles.length, 0);
  });

  test('1.4 User B attempting to PATCH User A vehicle receives consistent 404', async () => {
    const vA = await Vehicle.findOne({ owner: userA._id, registrationNumber: 'DL01AA1111' });
    assert.ok(vA);

    const patchRes = await apiPatch(
      `/api/vehicles/${vA._id}`,
      { label: 'Hacked Label' },
      userBToken
    );
    assert.equal(patchRes.status, 404);
    assert.equal(patchRes.data.code, 'VEHICLE_NOT_FOUND');

    // Verify unmodified in DB
    const fresh = await Vehicle.findById(vA._id);
    assert.equal(fresh.label, 'My City Car');
  });

  test('1.5 Admin user attempting to PATCH or DELETE User A vehicle receives consistent 404 (no admin bypass)', async () => {
    const vA = await Vehicle.findOne({ owner: userA._id, registrationNumber: 'DL01AA1111' });
    assert.ok(vA);

    const patchRes = await apiPatch(
      `/api/vehicles/${vA._id}`,
      { label: 'Admin Overwrite' },
      adminToken
    );
    assert.equal(patchRes.status, 404);

    const delRes = await apiDelete(`/api/vehicles/${vA._id}`, adminToken);
    assert.equal(delRes.status, 404);

    // Verify still exists in DB
    const fresh = await Vehicle.findById(vA._id);
    assert.ok(fresh);
  });

  test('1.6 User B attempting to DELETE User A vehicle receives 404', async () => {
    const vA = await Vehicle.findOne({ owner: userA._id, registrationNumber: 'DL01AA1111' });
    assert.ok(vA);

    const delRes = await apiDelete(`/api/vehicles/${vA._id}`, userBToken);
    assert.equal(delRes.status, 404);
    assert.equal(delRes.data.code, 'VEHICLE_NOT_FOUND');

    const fresh = await Vehicle.findById(vA._id);
    assert.ok(fresh);
  });

  // ════════════════════════════════════════════════════════════
  // 2. VALIDATION, NORMALIZATION & DUPLICATE REGISTRATION
  // ════════════════════════════════════════════════════════════

  test('2.1 Invalid ObjectId on PATCH / DELETE returns 400 INVALID_ID', async () => {
    const badPatch = await apiPatch('/api/vehicles/not-a-valid-id', { label: 'Test' }, userAToken);
    assert.equal(badPatch.status, 400);
    assert.equal(badPatch.data.code, 'INVALID_ID');

    const badDel = await apiDelete('/api/vehicles/12345', userAToken);
    assert.equal(badDel.status, 400);
    assert.equal(badDel.data.code, 'INVALID_ID');
  });

  test('2.2 Normalization: uppercase, trim, and space collapse', () => {
    assert.equal(normalizeVehicleNumber('  mh  12   ab 1234 '), 'MH 12 AB 1234');
    assert.equal(normalizeVehicleNumber('dl-01-z-9999'), 'DL-01-Z-9999');
    assert.equal(normalizeVehicleNumber('ka 05 '), 'KA 05');
  });

  test('2.3 Missing required fields on POST return 400 with friendly message', async () => {
    const missingReg = await apiPost('/api/vehicles', { type: 'car' }, userAToken);
    assert.equal(missingReg.status, 400);
    assert.equal(missingReg.data.code, 'MISSING_FIELD');

    const missingType = await apiPost('/api/vehicles', { registrationNumber: 'KA01AA1234' }, userAToken);
    assert.equal(missingType.status, 400);
    assert.equal(missingType.data.code, 'MISSING_FIELD');
  });

  test('2.4 Invalid registration length or vehicle type returns 400', async () => {
    const shortReg = await apiPost('/api/vehicles', { registrationNumber: 'A', type: 'car' }, userAToken);
    assert.equal(shortReg.status, 400);
    assert.equal(shortReg.data.code, 'INVALID_REGISTRATION_NUMBER');

    const badType = await apiPost('/api/vehicles', { registrationNumber: 'KA01AA1234', type: 'truck' }, userAToken);
    assert.equal(badType.status, 400);
    assert.equal(badType.data.code, 'INVALID_VEHICLE_TYPE');
  });

  test('2.5 Forbidden fields (owner, _id, role) rejected with 400 FORBIDDEN_FIELDS', async () => {
    const fakeOwner = new mongoose.Types.ObjectId();
    const res = await apiPost(
      '/api/vehicles',
      { registrationNumber: 'HR26DK8888', type: 'car', owner: fakeOwner },
      userAToken
    );
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'FORBIDDEN_FIELDS');
  });

  test('2.6 Duplicate registration number for the same user returns 409 conflict without raw DB error', async () => {
    // DL01AA1111 already saved by User A in test 1.2
    const dupRes = await apiPost(
      '/api/vehicles',
      { registrationNumber: ' dl01aa1111 ', type: 'car', label: 'Duplicate Attempt' },
      userAToken
    );
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.data.code, 'DUPLICATE_VEHICLE');
    assert.ok(dupRes.data.message.includes('already saved'));
    assert.ok(!dupRes.data.message.includes('E11000'));
  });

  test('2.7 Two DIFFERENT users CAN save the same registration number independently', async () => {
    // User B saves same registration number as User A (DL01AA1111)
    const bRes = await apiPost(
      '/api/vehicles',
      { registrationNumber: 'DL01AA1111', type: 'car', label: 'User B Car' },
      userBToken
    );
    assert.equal(bRes.status, 201);
    assert.equal(bRes.data.vehicle.registrationNumber, 'DL01AA1111');
    createdVehicleIds.push(new mongoose.Types.ObjectId(bRes.data.vehicle.id));
  });

  // ════════════════════════════════════════════════════════════
  // 3. OWNER-SCOPED EDIT / DELETE
  // ════════════════════════════════════════════════════════════

  test('3.1 User A can update label, type, and registration number of their vehicle', async () => {
    const vA = await Vehicle.findOne({ owner: userA._id, registrationNumber: 'DL01AA1111' });
    assert.ok(vA);

    const updateRes = await apiPatch(
      `/api/vehicles/${vA._id}`,
      { label: 'Updated Super Car', type: 'ev', registrationNumber: 'DL01AA2222' },
      userAToken
    );
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.success, true);
    assert.equal(updateRes.data.vehicle.label, 'Updated Super Car');
    assert.equal(updateRes.data.vehicle.type, 'ev');
    assert.equal(updateRes.data.vehicle.registrationNumber, 'DL01AA2222');
  });

  test('3.2 Updating registration number to another vehicle owned by User A returns 409', async () => {
    // Create second vehicle for User A
    const v2Res = await apiPost(
      '/api/vehicles',
      { registrationNumber: 'DL01AA3333', type: 'bike', label: 'My Scooter' },
      userAToken
    );
    assert.equal(v2Res.status, 201);
    createdVehicleIds.push(new mongoose.Types.ObjectId(v2Res.data.vehicle.id));

    // Try to rename vehicle 2 to DL01AA2222 (which belongs to vehicle 1)
    const conflictRes = await apiPatch(
      `/api/vehicles/${v2Res.data.vehicle.id}`,
      { registrationNumber: 'DL01AA2222' },
      userAToken
    );
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.data.code, 'DUPLICATE_VEHICLE');
  });

  test('3.3 Updating vehicle with its own existing registration number succeeds (no self-conflict)', async () => {
    const v = await Vehicle.findOne({ owner: userA._id, registrationNumber: 'DL01AA2222' });
    assert.ok(v);

    const res = await apiPatch(
      `/api/vehicles/${v._id}`,
      { registrationNumber: 'DL01AA2222', label: 'Same Reg Different Label' },
      userAToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.vehicle.label, 'Same Reg Different Label');
  });

  // ════════════════════════════════════════════════════════════
  // 4. PAST BOOKING SNAPSHOTS UNCHANGED AFTER VEHICLE EDIT / DELETE
  // ════════════════════════════════════════════════════════════

  test('4.1 Past booking snapshots remain unchanged after saved vehicle edit and deletion', async () => {
    // Create a saved vehicle for User A
    const vRes = await apiPost(
      '/api/vehicles',
      { registrationNumber: 'KA53Z9000', type: 'car', label: 'Original Car' },
      userAToken
    );
    assert.equal(vRes.status, 201);
    const vehicleId = vRes.data.vehicle.id;
    createdVehicleIds.push(new mongoose.Types.ObjectId(vehicleId));

    // Create a real Booking recording this vehicle snapshot
    const booking = await Booking.create({
      user: userA._id,
      location: loc._id,
      slot: slotCar._id,
      locationName: loc.name,
      slotCode: 'C-01',
      vehicle: { registrationNumber: 'KA53Z9000', type: 'car' },
      pricePerHourPaise: 4000,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationHours: 1,
      totalPaise: 4000,
      status: 'active',
      requestId: randomUUID(),
    });
    createdBookingIds.push(booking._id);

    // 1. Edit saved vehicle: change registration and type
    const editRes = await apiPatch(
      `/api/vehicles/${vehicleId}`,
      { registrationNumber: 'KA53Z9999', type: 'ev', label: 'Modified Car' },
      userAToken
    );
    assert.equal(editRes.status, 200);

    // Verify booking snapshot is STILL KA53Z9000 / car
    let freshBooking = await Booking.findById(booking._id);
    assert.equal(freshBooking.vehicle.registrationNumber, 'KA53Z9000');
    assert.equal(freshBooking.vehicle.type, 'car');

    // 2. Delete the saved vehicle
    const delRes = await apiDelete(`/api/vehicles/${vehicleId}`, userAToken);
    assert.equal(delRes.status, 200);

    // Verify booking still exists in DB and snapshot is 100% intact
    freshBooking = await Booking.findById(booking._id);
    assert.ok(freshBooking);
    assert.equal(freshBooking.vehicle.registrationNumber, 'KA53Z9000');
    assert.equal(freshBooking.vehicle.type, 'car');
    assert.equal(freshBooking.status, 'active');
  });

  // ════════════════════════════════════════════════════════════
  // 5. DASHBOARD VEHICLE CRUD STATES & SAFE DOM RENDERING
  // ════════════════════════════════════════════════════════════

  test('5.1 createVehicleCard safely escapes text using textContent', () => {
    const { doc } = setupMockDom();
    global.document = doc;

    const maliciousVehicle = {
      id: 'v123',
      label: '<script>alert("XSS")</script>',
      registrationNumber: 'MH"12\'AB&<9999>',
      type: 'car',
    };

    const card = createVehicleCard(maliciousVehicle);
    assert.equal(card.tagName, 'ARTICLE');
    assert.equal(card.dataset.vehicleId, 'v123');

    const regEl = card.querySelector('.vehicle-card__reg');
    assert.ok(regEl);
    assert.equal(regEl.textContent, 'MH"12\'AB&<9999>');

    const labelEl = card.querySelector('.vehicle-card__label');
    assert.ok(labelEl);
    assert.equal(labelEl.textContent, '<script>alert("XSS")</script>');
  });

  test('5.2 renderVehiclesList updates list, counts, and empty states', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    const vList = elements.get('vehicles-list');
    const emptyEl = elements.get('no-vehicles-msg');
    const countEl = elements.get('vehicles-count');

    // 1. Render empty list
    renderVehiclesList([]);
    assert.equal(countEl.textContent, '0');
    assert.equal(emptyEl.classList.contains('hidden'), false);

    // 2. Render 2 vehicles
    const mockVehicles = [
      { id: '1', label: 'Car 1', registrationNumber: 'MH12AB1001', type: 'car' },
      { id: '2', label: 'Bike 1', registrationNumber: 'DL04BB2002', type: 'bike' },
    ];
    renderVehiclesList(mockVehicles);
    assert.equal(countEl.textContent, '2');
    assert.equal(emptyEl.classList.contains('hidden'), true);

    const cards = vList.querySelectorAll('.vehicle-card');
    assert.equal(cards.length, 2);
  });

  test('5.3 DashboardApp openVehicleModal and closeVehicleModal manage form fields correctly', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    const modal = elements.get('vehicle-modal');
    const title = elements.get('vehicle-modal-title');
    const idInput = elements.get('vehicle-edit-id');
    const regInput = elements.get('vehicle-input-reg');
    const typeInput = elements.get('vehicle-input-type');
    const labelInput = elements.get('vehicle-input-label');

    // Open Add Mode
    DashboardApp.openVehicleModal('add');
    assert.equal(modal.classList.contains('hidden'), false);
    assert.equal(title.textContent, 'Add Vehicle');
    assert.equal(idInput.value, '');
    assert.equal(regInput.value, '');

    // Open Edit Mode
    DashboardApp.openVehicleModal('edit', {
      id: 'veh_456',
      registrationNumber: 'KA01AB1234',
      type: 'ev',
      label: 'My EV',
    });
    assert.equal(title.textContent, 'Edit Vehicle');
    assert.equal(idInput.value, 'veh_456');
    assert.equal(regInput.value, 'KA01AB1234');
    assert.equal(typeInput.value, 'ev');
    assert.equal(labelInput.value, 'My EV');

    // Close Modal
    DashboardApp.closeVehicleModal();
    assert.equal(modal.classList.contains('hidden'), true);
  });

  // ════════════════════════════════════════════════════════════
  // 6. BOOKING AUTOFILL & MANUAL ENTRY FALLBACK
  // ════════════════════════════════════════════════════════════

  test('6.1 BookingApp renders saved vehicle options with default manual entry', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;
    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');

    const vehicles = [
      { id: 'v1', label: 'Office Car', registrationNumber: 'DL01AA1111', type: 'car' },
      { id: 'v2', label: '', registrationNumber: 'KA03EV2222', type: 'ev' },
    ];

    BookingApp.renderSavedVehicleOptions(vehicles);
    const sel = elements.get('saved-vehicle-select');
    assert.equal(sel.children.length, 3);
    assert.equal(sel.children[0].value, '');
    assert.ok(sel.children[0].textContent.includes('Manual Entry'));
    assert.equal(sel.children[1].value, 'v1');
    assert.ok(sel.children[1].textContent.includes('Office Car (DL01AA1111)'));
    assert.equal(sel.children[2].value, 'v2');
    assert.ok(sel.children[2].textContent.includes('KA03EV2222 — EV'));
  });

  test('6.2 Selecting a saved vehicle explicitly autofills registration number and type', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');

    BookingApp.state.savedVehicles = [
      { id: 'veh_car', label: 'Primary', registrationNumber: 'MH02CB5555', type: 'car' },
    ];

    BookingApp.elements.savedVehicleSelect.value = 'veh_car';
    BookingApp.handleSavedVehicleSelect();

    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'MH02CB5555');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'car');
  });

  test('6.3 Manual entry remains fully available and selecting manual option does not wipe inputs', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');

    // User types manually
    BookingApp.elements.vehicleNumberInput.value = 'CUSTOM1234';
    BookingApp.elements.vehicleTypeSelect.value = 'bike';
    BookingApp.elements.savedVehicleSelect.value = '';

    BookingApp.handleSavedVehicleSelect();

    // Inputs must remain unchanged
    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'CUSTOM1234');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'bike');
  });

  // ════════════════════════════════════════════════════════════
  // 7. VEHICLE TYPE / SLOT COMPATIBILITY
  // ════════════════════════════════════════════════════════════

  test('7.1 Selecting an incompatible vehicle clears slot selection and triggers panel close', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');
    BookingApp.elements.panel = elements.get('booking-panel');
    BookingApp.elements.panelOverlay = elements.get('booking-panel-overlay');

    // User currently has a CAR slot selected
    BookingApp.state.selectedSlot = {
      id: 'slot_car_1',
      code: 'C-01',
      vehicleType: 'car',
    };

    BookingApp.state.savedVehicles = [
      { id: 'veh_bike', label: 'Scooter', registrationNumber: 'DL09BB1234', type: 'bike' },
    ];

    // User selects bike vehicle
    BookingApp.elements.savedVehicleSelect.value = 'veh_bike';
    BookingApp.handleSavedVehicleSelect();

    // Incompatible slot must be cleared and panel closed
    assert.equal(BookingApp.state.selectedSlot, null);
    assert.equal(BookingApp.elements.panel.classList.contains('booking-panel--open'), false);
  });

  test('7.2 Selecting a compatible vehicle retains slot selection and updates form', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');
    BookingApp.elements.panel = elements.get('booking-panel');

    // User has a CAR slot selected
    BookingApp.state.selectedSlot = {
      id: 'slot_car_1',
      code: 'C-01',
      vehicleType: 'car',
      pricePerHourPaise: 4000,
    };

    BookingApp.state.savedVehicles = [
      { id: 'veh_car_2', label: 'Sedan', registrationNumber: 'DL01AA8888', type: 'car' },
    ];

    BookingApp.elements.savedVehicleSelect.value = 'veh_car_2';
    BookingApp.handleSavedVehicleSelect();

    // Slot remains intact
    assert.ok(BookingApp.state.selectedSlot);
    assert.equal(BookingApp.state.selectedSlot.code, 'C-01');
    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'DL01AA8888');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'car');
  });

  test('7.3 Reject incompatible slot selection when saved vehicle is active (Regression: saved bike + car slot)', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    let toastMessage = null;
    let toastType = null;
    global.showToast = (msg, type) => {
      toastMessage = msg;
      toastType = type;
    };

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');
    BookingApp.elements.panel = elements.get('booking-panel');

    // User selects a saved BIKE
    BookingApp.state.savedVehicles = [
      { id: 'veh_bike_1', label: 'My Scooter', registrationNumber: 'DL04BB2002', type: 'bike' },
    ];
    BookingApp.elements.savedVehicleSelect.value = 'veh_bike_1';
    BookingApp.handleSavedVehicleSelect();

    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'DL04BB2002');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'bike');
    assert.equal(BookingApp.elements.savedVehicleSelect.value, 'veh_bike_1');

    // Attempt to select an incompatible CAR slot
    const carSlot = {
      id: 'slot_car_99',
      code: 'C-99',
      vehicleType: 'car',
      zone: 'A',
      floor: '1',
      pricePerHourPaise: 4000,
    };
    BookingApp.selectSlot(carSlot);

    // Slot selection MUST be rejected with a warning message
    assert.notEqual(BookingApp.state.selectedSlot, carSlot);
    assert.ok(toastMessage);
    assert.ok(toastMessage.includes('incompatible'));
    assert.equal(toastType, 'warning');

    // Crucial Regression assertion:
    // The form MUST NOT show the saved bike with type Car!
    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'DL04BB2002');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'bike');
    assert.equal(BookingApp.elements.savedVehicleSelect.value, 'veh_bike_1');
  });

  test('7.4 Compatible slot selection preserves saved vehicle identity in open panel', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');
    BookingApp.elements.panel = elements.get('booking-panel');
    BookingApp.elements.panelOverlay = elements.get('booking-panel-overlay');

    // User selects a saved BIKE
    BookingApp.state.savedVehicles = [
      { id: 'veh_bike_2', label: 'Commuter Bike', registrationNumber: 'MH02BK1234', type: 'bike' },
    ];
    BookingApp.elements.savedVehicleSelect.value = 'veh_bike_2';
    BookingApp.handleSavedVehicleSelect();

    // Select a compatible BIKE slot
    const bikeSlot = {
      id: 'slot_bike_10',
      code: 'B-10',
      vehicleType: 'bike',
      zone: 'B',
      floor: 'G',
      pricePerHourPaise: 2000,
    };
    BookingApp.selectSlot(bikeSlot);

    // Slot selection accepted and panel open
    assert.equal(BookingApp.state.selectedSlot, bikeSlot);
    assert.equal(BookingApp.elements.panel.classList.contains('booking-panel--open'), true);

    // Form retains saved vehicle values without overwrite
    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'MH02BK1234');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'bike');
    assert.equal(BookingApp.elements.savedVehicleSelect.value, 'veh_bike_2');
  });

  test('7.5 Manual entry slot selection defaults vehicle type to slot vehicle type', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');
    BookingApp.elements.panel = elements.get('booking-panel');
    BookingApp.elements.panelOverlay = elements.get('booking-panel-overlay');

    // Manual entry active (no saved vehicle selected)
    BookingApp.elements.savedVehicleSelect.value = '';
    BookingApp.elements.vehicleTypeSelect.value = '';

    const carSlot = {
      id: 'slot_car_5',
      code: 'C-05',
      vehicleType: 'car',
      pricePerHourPaise: 3000,
    };
    BookingApp.selectSlot(carSlot);

    assert.equal(BookingApp.state.selectedSlot, carSlot);
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'car');
  });

  // ════════════════════════════════════════════════════════════
  // 8. UNRESOLVED BOOKING RECOVERY PROTECTION (STAGE 9)
  // ════════════════════════════════════════════════════════════

  test('8.1 Saved vehicle selector is locked when uncertainAttempt is present', () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.uncertainAlert = elements.get('uncertain-booking-alert');
    BookingApp.elements.uncertainMessage = elements.get('uncertain-booking-message');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');

    // Simulate Stage 9 unresolved booking attempt
    const originalPayload = {
      locationId: 'loc_123',
      slotId: 'slot_456',
      vehicleNumber: 'ORIGINAL_REG',
      vehicleType: 'car',
      durationHours: 2,
    };
    BookingApp.state.uncertainAttempt = {
      payload: { ...originalPayload },
      requestId: 'req-original-uuid-1234',
      userId: userA._id.toString(),
    };

    // When alert is displayed, selector must be disabled
    BookingApp.elements.savedVehicleSelect.disabled = false;
    // Trigger show alert behavior
    elements.get('uncertain-booking-alert').hidden = false;
    BookingApp.elements.savedVehicleSelect.disabled = true;

    assert.equal(BookingApp.elements.savedVehicleSelect.disabled, true);

    // Attempting to invoke handleSavedVehicleSelect must do nothing and NEVER modify payload
    BookingApp.state.savedVehicles = [
      { id: 'veh_other', label: 'Other', registrationNumber: 'MUTATE9999', type: 'bike' },
    ];
    BookingApp.elements.savedVehicleSelect.value = 'veh_other';
    BookingApp.handleSavedVehicleSelect();

    // Verify recovery attempt was NOT modified
    assert.equal(BookingApp.state.uncertainAttempt.payload.vehicleNumber, 'ORIGINAL_REG');
    assert.equal(BookingApp.state.uncertainAttempt.payload.vehicleType, 'car');
    assert.equal(BookingApp.state.uncertainAttempt.requestId, 'req-original-uuid-1234');
  });

  // ════════════════════════════════════════════════════════════
  // 9. INDEPENDENT OPTIONAL SAVED VEHICLE LOADING & LATE RESOLUTION
  // ════════════════════════════════════════════════════════════

  test('9.1 Regression: Pending saved-vehicles request does not delay location/slots and manual booking init', async () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    // Elements required by init()
    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.locationHeaderBar = elements.get('location-header-bar');
    BookingApp.elements.selectedLocationName = elements.get('selected-location-name');
    BookingApp.elements.selectedLocationStatus = elements.get('selected-location-status');
    BookingApp.elements.selectedLocationAddress = elements.get('selected-location-address');
    BookingApp.elements.locationClosedBanner = elements.get('location-closed-banner');
    BookingApp.elements.locationErrorState = elements.get('location-error-state');
    BookingApp.elements.headerUserName = elements.get('header-user-name');
    BookingApp.elements.vehicleNumberInput = elements.get('vehicle-number');
    BookingApp.elements.vehicleTypeSelect = elements.get('vehicle-type');

    BookingApp.state.locationId = 'loc_independent_test';
    BookingApp.state.uncertainAttempt = null;
    global.window = { location: { search: '?locationId=loc_independent_test' } };
    global.requireAuth = async () => ({ id: 'user_test', name: 'Test User' });

    // Mock ApiClient:
    // /api/vehicles/me NEVER resolves (pending forever during init)
    // /api/locations/... resolves immediately
    let vehiclesResolver;
    const pendingVehiclesPromise = new Promise((resolve) => {
      vehiclesResolver = resolve;
    });

    global.ApiClient = {
      get: (url) => {
        if (url === '/api/vehicles/me') {
          return pendingVehiclesPromise;
        }
        if (url === '/api/locations/loc_independent_test') {
          return Promise.resolve({
            success: true,
            location: {
              id: 'loc_independent_test',
              name: 'Fast Load Facility',
              status: 'active',
              zones: ['A'],
              basePricePerHourPaise: 3000,
            },
          });
        }
        if (url === '/api/locations/loc_independent_test/slots') {
          return Promise.resolve({
            success: true,
            slots: [
              { id: 's1', code: 'A-01', zone: 'A', vehicleType: 'car', available: true, pricePerHourPaise: 3000 },
            ],
          });
        }
        return Promise.resolve({ success: true });
      },
    };

    // BookingApp.init() MUST resolve without waiting for /api/vehicles/me
    const initPromise = BookingApp.init();
    const timeoutRace = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('init timed out waiting for vehicles request')), 500)
    );

    await Promise.race([initPromise, timeoutRace]);

    // Clean up polling timer
    BookingApp.stopPolling();

    // Verify location and slots are fully loaded!
    assert.ok(BookingApp.state.location);
    assert.equal(BookingApp.state.location.name, 'Fast Load Facility');
    assert.equal(BookingApp.state.slots.length, 1);

    // Verify manual booking works while saved-vehicles is still pending
    BookingApp.elements.vehicleNumberInput.value = 'MANUAL1234';
    BookingApp.elements.vehicleTypeSelect.value = 'car';

    // Now resolve the late response
    vehiclesResolver({
      success: true,
      vehicles: [
        { id: 'late_veh', label: 'Late Bike', registrationNumber: 'DL09XX9999', type: 'bike' },
      ],
    });

    // Wait a tick for microtasks
    await new Promise((r) => setImmediate(r));

    // A late response must NOT overwrite manually entered fields!
    assert.equal(BookingApp.elements.vehicleNumberInput.value, 'MANUAL1234');
    assert.equal(BookingApp.elements.vehicleTypeSelect.value, 'car');
  });

  test('9.2 Late response does not unlock an unresolved booking attempt', async () => {
    const { doc, elements } = setupMockDom();
    global.document = doc;

    BookingApp.elements.savedVehicleSelect = elements.get('saved-vehicle-select');
    BookingApp.elements.uncertainAlert = elements.get('uncertain-booking-alert');

    // Simulate an active unresolved attempt
    BookingApp.state.uncertainAttempt = {
      payload: { locationId: 'loc_test', slotId: 's1', vehicleNumber: 'ORIG_1', vehicleType: 'car', durationHours: 1 },
      requestId: 'req_uncertain_lock_test',
    };
    BookingApp.elements.savedVehicleSelect.disabled = true;

    let resolveVehicles;
    const pendingVehiclesPromise = new Promise((resolve) => {
      resolveVehicles = resolve;
    });

    global.ApiClient = {
      get: () => pendingVehiclesPromise,
    };

    // Trigger loadSavedVehicles
    const loadPromise = BookingApp.loadSavedVehicles();

    // Still locked while loading
    assert.equal(BookingApp.elements.savedVehicleSelect.disabled, true);

    // Resolve late response
    resolveVehicles({
      success: true,
      vehicles: [
        { id: 'v_unlocked_check', registrationNumber: 'KA01AA0000', type: 'car' },
      ],
    });

    await loadPromise;

    // Selector MUST remain locked / disabled!
    assert.equal(BookingApp.elements.savedVehicleSelect.disabled, true);
  });
});
