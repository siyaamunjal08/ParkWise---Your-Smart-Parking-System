// tests/adminFrontend.test.js — Stage 10 Admin Management Console Unit & Controller Tests
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Load modules to test
const {
  ALLOWED_LOCATION_FIELDS,
  ALLOWED_SLOT_FIELDS,
  ALLOWED_CATEGORIES,
  ALLOWED_VEHICLE_TYPES,
  KNOWN_FACILITY_VALUES,
  KNOWN_SLOT_FEATURE_VALUES,
  validateCoordinates,
  convertRupeesToPaise,
  formatPaiseToRupees,
  buildLocationPayload,
  buildSlotPayload,
  mergePreservedItems,
  AdminConsoleApp,
} = require('../public/js/admin');

const {
  getSafeReturnUrl,
  ALLOWED_RETURN_PAGES,
  requireAdminAuth,
  updateAdminNavigation,
} = require('../public/js/auth');

const { LocationDiscoveryApp } = require('../public/js/locations');

// ── Mock DOM Infrastructure ───────────────────────────────────

function createMockElement(tagName = 'div', id = '') {
  const children = [];
  const attributes = {};
  const listeners = new Map();
  let _textContent = '';
  let _innerHTML = '';

  const classList = {
    _classes: new Set(),
    add: (c) => classList._classes.add(c),
    remove: (c) => classList._classes.delete(c),
    contains: (c) => classList._classes.has(c),
  };
  let _value = '';

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    className: '',
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
      return _innerHTML;
    },
    set innerHTML(val) {
      _innerHTML = String(val);
      if (val === '') children.length = 0;
    },
    setAttribute: (k, v) => {
      attributes[k] = String(v);
    },
    getAttribute: (k) => attributes[k] ?? null,
    removeAttribute: (k) => {
      delete attributes[k];
    },
    appendChild: (child) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    addEventListener: (evt, fn) => {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    dispatchEvent: (evt) => {
      const fns = listeners.get(evt.type) || [];
      fns.forEach((fn) => fn(evt));
      if (typeof el[`on${evt.type}`] === 'function') {
        el[`on${evt.type}`](evt);
      }
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
      const findMatching = (node) => {
        for (const c of node.children || []) {
          if (sel.includes('input') && c.tagName === 'INPUT') results.push(c);
          else if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) results.push(c);
          findMatching(c);
        }
      };
      findMatching(el);
      return results;
    },
    reset: () => {
      el.value = '';
      for (const ch of el.children) {
        if (ch.tagName === 'INPUT') {
          ch.value = '';
          ch.checked = false;
        }
      }
    },
    contains: (target) => {
      let curr = target;
      while (curr) {
        if (curr === el) return true;
        curr = curr.parentElement;
      }
      return false;
    },
    focus: () => {
      if (global.document) global.document.activeElement = el;
    },
  };

  return el;
}

function setupMockDocument() {
  const elements = new Map();

  const getOrCreate = (id, tag = 'div') => {
    if (!elements.has(id)) {
      const el = createMockElement(tag, id);
      elements.set(id, el);
    }
    return elements.get(id);
  };

  // Pre-populate core IDs needed by admin.js
  const ids = [
    'header-auth',
    'admin-initial-loading',
    'admin-access-denied',
    'admin-console-app',
    'admin-user-badge',
    'btn-admin-logout',
    'btn-refresh-all',
    'nav-admin-link',
    'admin-global-alert',
    'admin-global-alert-message',
    'btn-close-global-alert',
    'tab-btn-overview',
    'tab-btn-locations',
    'tab-btn-slots',
    'tab-btn-bookings',
    'panel-overview',
    'panel-locations',
    'panel-slots',
    'panel-bookings',
    'overview-loading',
    'metric-loc-total',
    'metric-loc-draft',
    'metric-loc-active',
    'metric-loc-closed',
    'metric-loc-archived',
    'metric-slots-total',
    'metric-slots-enabled',
    'metric-slots-maintenance',
    'metric-slots-archived',
    'metric-bookings-total',
    'metric-bookings-active',
    'metric-bookings-completed',
    'metric-bookings-cancelled',
    'metric-users-total',
    'filter-location-status',
    'btn-open-add-location',
    'btn-refresh-locations',
    'locations-loading',
    'locations-error',
    'locations-error-message',
    'btn-retry-locations',
    'locations-empty',
    'locations-table-wrapper',
    'locations-tbody',
    'btn-prev-locations',
    'btn-next-locations',
    'locations-page-info',
    'slots-parent-header',
    'slots-parent-name',
    'slots-parent-meta',
    'select-slot-location',
    'btn-open-add-slot',
    'btn-refresh-slots',
    'slots-no-selection',
    'slots-table-card',
    'slots-loading',
    'slots-error',
    'slots-error-message',
    'btn-retry-slots',
    'slots-empty',
    'slots-table-wrapper',
    'slots-tbody',
    'filter-booking-location',
    'filter-booking-status',
    'btn-refresh-bookings',
    'bookings-loading',
    'bookings-error',
    'bookings-error-message',
    'btn-retry-bookings',
    'bookings-empty',
    'bookings-table-wrapper',
    'bookings-tbody',
    'btn-prev-bookings',
    'btn-next-bookings',
    'bookings-page-info',
    'modal-location',
    'modal-location-title',
    'btn-close-location-modal',
    'btn-cancel-location',
    'form-location',
    'loc-id',
    'loc-name',
    'loc-category',
    'loc-address',
    'loc-city',
    'loc-area',
    'loc-phone',
    'loc-latitude',
    'loc-longitude',
    'btn-clear-pin',
    'admin-map',
    'admin-map-fallback',
    'btn-save-location',
    'loc-form-error',
    'loc-form-error-text',
    'loc-form-error-violations',
    'modal-slot',
    'modal-slot-title',
    'btn-close-slot-modal',
    'btn-cancel-slot',
    'form-slot',
    'slot-id',
    'slot-location-id',
    'slot-code',
    'slot-zone',
    'slot-floor',
    'slot-vehicle-type',
    'slot-price-rupees',
    'slot-distance',
    'group-slot-status',
    'slot-service-status',
    'slot-status-claimed-note',
    'btn-save-slot',
    'slot-form-error',
    'slot-form-error-text',
    'modal-confirm',
    'modal-confirm-title',
    'btn-close-confirm-modal',
    'btn-confirm-cancel',
    'btn-confirm-proceed',
    'confirm-modal-message',
    'confirm-modal-warning',
  ];

  for (const id of ids) {
    getOrCreate(id);
  }

  const doc = {
    activeElement: null,
    createElement: (tag) => createMockElement(tag),
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return getOrCreate(sel.slice(1));
      if (sel.includes('ul')) return getOrCreate('nav-ul', 'ul');
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  return { doc, elements, getOrCreate };
}

// ── Test Suite ────────────────────────────────────────────────

test('Stage 10 — Admin Console Unit & Security Tests', async (t) => {
  // ── 1. Return Path Allowlist & Redirection Protection ───────
  await t.test('1. Return Path Allowlist includes admin.html safely', () => {
    assert.strictEqual(ALLOWED_RETURN_PAGES.has('admin.html'), true, 'admin.html must be in ALLOWED_RETURN_PAGES');

    // Valid admin return destination
    const valid1 = getSafeReturnUrl('admin.html');
    assert.strictEqual(valid1, 'admin.html');

    const valid2 = getSafeReturnUrl('/admin.html');
    assert.strictEqual(valid2, 'admin.html');

    // Reject malicious open redirects
    assert.strictEqual(getSafeReturnUrl('/https://evil.com'), 'dashboard.html');
    assert.strictEqual(getSafeReturnUrl('//evil.example.com'), 'dashboard.html');
    assert.strictEqual(getSafeReturnUrl('\\evil.example.com'), 'dashboard.html');
    assert.strictEqual(getSafeReturnUrl('/\\admin.html'), 'dashboard.html');
    assert.strictEqual(getSafeReturnUrl('http://localhost:5000///example.com'), 'dashboard.html');
  });

  // ── 2. Pure Coordinate Validation ───────────────────────────
  await t.test('2. Coordinate Validation (validates bounds and accepts valid 0, 0)', () => {
    // Valid coordinates
    assert.deepStrictEqual(validateCoordinates('19.0760', '72.8777'), {
      valid: true,
      lat: 19.076,
      lng: 72.8777,
    });

    // Valid zero coordinates (must be accepted!)
    assert.deepStrictEqual(validateCoordinates(0, 0), {
      valid: true,
      lat: 0,
      lng: 0,
    });
    assert.deepStrictEqual(validateCoordinates('0', '0'), {
      valid: true,
      lat: 0,
      lng: 0,
    });

    // Empty/omitted coordinates (optional)
    assert.deepStrictEqual(validateCoordinates('', ''), {
      valid: true,
      lat: undefined,
      lng: undefined,
    });

    // Invalid latitudes
    const latOver = validateCoordinates(90.1, 0);
    assert.strictEqual(latOver.valid, false);
    assert.match(latOver.error, /Latitude/);

    const latUnder = validateCoordinates(-91, 0);
    assert.strictEqual(latUnder.valid, false);

    // Invalid longitudes
    const lngOver = validateCoordinates(0, 180.5);
    assert.strictEqual(lngOver.valid, false);
    assert.match(lngOver.error, /Longitude/);

    const lngUnder = validateCoordinates(0, -181);
    assert.strictEqual(lngUnder.valid, false);

    // Non-numeric / NaN
    assert.strictEqual(validateCoordinates('abc', 10).valid, false);
    assert.strictEqual(validateCoordinates(10, 'xyz').valid, false);
  });

  // ── 3. Price Conversion & Currency Formatting ───────────────
  await t.test('3. Currency & Price Conversion (Rupees to Integer Paise)', () => {
    // Valid rupees inputs
    assert.deepStrictEqual(convertRupeesToPaise('50'), { valid: true, paise: 5000 });
    assert.deepStrictEqual(convertRupeesToPaise('45.50'), { valid: true, paise: 4550 });
    assert.deepStrictEqual(convertRupeesToPaise('0'), { valid: true, paise: 0 });
    assert.deepStrictEqual(convertRupeesToPaise('120.5'), { valid: true, paise: 12050 });

    // Formatting paise to rupees display
    assert.strictEqual(formatPaiseToRupees(5000), '₹50.00');
    assert.strictEqual(formatPaiseToRupees(4550), '₹45.50');
    assert.strictEqual(formatPaiseToRupees(0), '₹0.00');

    // Invalid price formats (more than 2 decimal places, negatives, invalid text)
    const tooManyDecimals = convertRupeesToPaise('50.123');
    assert.strictEqual(tooManyDecimals.valid, false);
    assert.match(tooManyDecimals.error, /2 decimal places/);

    const negative = convertRupeesToPaise('-10');
    assert.strictEqual(negative.valid, false);

    const invalidStr = convertRupeesToPaise('free');
    assert.strictEqual(invalidStr.valid, false);
  });

  // ── 4. Strict Allowlist Payload Construction ────────────────
  await t.test('4. Payload Allowlist Enforcement (Location & Slot)', () => {
    // Location payload
    const dirtyLocation = {
      name: '  Downtown Parking  ',
      category: 'office',
      city: 'Delhi',
      latitude: '28.6139',
      longitude: '77.2090',
      facilities: ['cctv', 'ev-charging'],
      // Forbidden fields that should be stripped
      _id: 'injected_id',
      status: 'active', // status transitions must be explicit
      bookingRevision: 99,
      isDemo: true,
      hackerProp: 'evil',
    };

    const cleanLoc = buildLocationPayload(dirtyLocation);
    assert.strictEqual(cleanLoc.name, 'Downtown Parking');
    assert.strictEqual(cleanLoc.category, 'office');
    assert.strictEqual(cleanLoc.city, 'Delhi');
    assert.strictEqual(cleanLoc.latitude, 28.6139);
    assert.strictEqual(cleanLoc.longitude, 77.2090);
    assert.deepStrictEqual(cleanLoc.facilities, ['cctv', 'ev-charging']);
    assert.strictEqual(cleanLoc.status, undefined, 'Status must not be injected in standard payload');
    assert.strictEqual(cleanLoc._id, undefined);
    assert.strictEqual(cleanLoc.hackerProp, undefined);

    // Unsupported categories sanitize to 'other'
    const invalidCatLoc = buildLocationPayload({ name: 'Commercial Tower', category: 'commercial' });
    assert.strictEqual(invalidCatLoc.category, 'other');

    // Slot payload
    const dirtySlot = {
      code: '  b-204  ',
      zone: 'b',
      floor: '2',
      vehicleType: 'car',
      pricePerHourPaise: 4000,
      distanceFromEntry: '25.5',
      features: ['covered'],
      // Forbidden fields
      location: 'fake_location', // slot cannot change parent location!
      activeBooking: 'fake_booking_id', // cannot force slot available!
      _id: 'injected_id',
    };

    const cleanSlot = buildSlotPayload(dirtySlot);
    assert.strictEqual(cleanSlot.code, 'B-204', 'Slot code must be uppercase');
    assert.strictEqual(cleanSlot.zone, 'B', 'Zone must be uppercase');
    assert.strictEqual(cleanSlot.floor, 2);
    assert.strictEqual(cleanSlot.pricePerHourPaise, 4000);
    assert.strictEqual(cleanSlot.distanceFromEntry, 25.5);
    assert.deepStrictEqual(cleanSlot.features, ['covered']);
    assert.strictEqual(cleanSlot.location, undefined, 'Parent location cannot be modified in slot payload');
    assert.strictEqual(cleanSlot.activeBooking, undefined, 'activeBooking cannot be cleared or forced');

    // Unsupported vehicle type sanitizes to 'car'
    const invalidVehicleSlot = buildSlotPayload({ code: 'T-10', vehicleType: 'truck' });
    assert.strictEqual(invalidVehicleSlot.vehicleType, 'car');
  });

  // ── 5. Server Authentication & Role Verification Guard ──────
  await t.test('5. Authentication Guard (requireAdminAuth)', async () => {
    // Setup environment mocks
    global.window = {
      location: {
        origin: 'http://localhost:5000',
        href: 'http://localhost:5000/admin.html',
        search: '',
        pathname: '/admin.html',
      },
    };

    let redirectTarget = null;
    global.redirectTo = (url) => {
      redirectTarget = url;
    };

    // Case A: Unauthenticated user (no token)
    global.SessionStore = {
      isLoggedIn: () => false,
      clear: () => {},
    };
    const resUnauth = await requireAdminAuth('admin.html');
    assert.strictEqual(resUnauth.authorized, false);
    assert.strictEqual(redirectTarget, 'login.html?returnUrl=admin.html');

    // Case B: Standard user (logged in, but role is 'user')
    redirectTarget = null;
    global.SessionStore = {
      isLoggedIn: () => true,
      getToken: () => 'valid_user_token',
      clear: () => {},
      updateUser: () => {},
    };
    global.ApiClient = {
      get: async (url) => {
        if (url === '/api/auth/me') {
          return {
            success: true,
            user: { id: 'u1', name: 'John Doe', role: 'user', email: 'john@example.com' },
          };
        }
        return null;
      },
    };
    const resStandard = await requireAdminAuth('admin.html');
    assert.strictEqual(resStandard.authorized, false);
    assert.strictEqual(resStandard.denied, true, 'Standard user must receive denied: true');
    assert.strictEqual(resStandard.user.role, 'user');
    assert.strictEqual(redirectTarget, null, 'Standard user must NOT be redirected or logged out');

    // Case C: Verified Administrator (role is 'admin')
    global.ApiClient.get = async (url) => {
      if (url === '/api/auth/me') {
        return {
          success: true,
          user: { id: 'a1', name: 'Admin Alice', role: 'admin', email: 'admin@parkwise.internal' },
        };
      }
      return null;
    };
    const resAdmin = await requireAdminAuth('admin.html');
    assert.strictEqual(resAdmin.authorized, true);
    assert.strictEqual(resAdmin.user.role, 'admin');
    assert.strictEqual(resAdmin.user.name, 'Admin Alice');
  });

  // ── 6. Admin Navigation Link Display ────────────────────────
  await t.test('6. Admin Navigation Link helper updates DOM for verified admins', () => {
    const { doc, elements } = setupMockDocument();
    global.document = doc;

    const navLink = elements.get('nav-admin-link');
    navLink.classList.add('hidden');

    // When standard user logs in, link remains hidden
    updateAdminNavigation({ role: 'user' });
    assert.strictEqual(navLink.classList.contains('hidden'), true);

    // When admin user logs in, link is revealed
    updateAdminNavigation({ role: 'admin' });
    assert.strictEqual(navLink.classList.contains('hidden'), false);
  });

  // ── 7. Stale Response Protection on Rapid Location Switching 
  await t.test('7. Stale Response Protection in Slot Inventory View', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    // Mock delayed API responses
    let resolveLoc1;
    let resolveLoc2;

    global.ApiClient = {
      get: (url) => {
        if (url.includes('/api/admin/locations/loc-1/slots')) {
          return new Promise((resolve) => {
            resolveLoc1 = resolve;
          });
        }
        if (url.includes('/api/admin/locations/loc-2/slots')) {
          return new Promise((resolve) => {
            resolveLoc2 = resolve;
          });
        }
        return Promise.resolve({ success: true, slots: [] });
      },
    };

    // User rapidly switches from Location 1 to Location 2
    app.locations = [
      { id: 'loc-1', name: 'Location One', status: 'active' },
      { id: 'loc-2', name: 'Location Two', status: 'active' },
    ];

    const promise1 = app.loadSlotsForLocation('loc-1');
    const promise2 = app.loadSlotsForLocation('loc-2');

    // Response for Location 2 completes FIRST
    resolveLoc2({
      success: true,
      slots: [{ code: 'L2-01', zone: 'A', vehicleType: 'car', serviceStatus: 'enabled' }],
    });
    await promise2;
    assert.strictEqual(app.slots.length, 1);
    assert.strictEqual(app.slots[0].code, 'L2-01');

    // Later, delayed response for Location 1 completes
    resolveLoc1({
      success: true,
      slots: [{ code: 'L1-99', zone: 'Z', vehicleType: 'car', serviceStatus: 'enabled' }],
    });
    await promise1;

    // Location 2 slots MUST NOT be overwritten by the stale Location 1 response!
    assert.strictEqual(app.slots.length, 1);
    assert.strictEqual(app.slots[0].code, 'L2-01', 'Stale response for loc-1 must be discarded');
  });

  // ── 8. Claimed Slot Modification Safeguards ─────────────────
  await t.test('8. Claimed Slot Enforcement (Editing occupied slot restricts to maintenance)', () => {
    const { doc } = setupMockDocument();
    global.document = doc;

    const app = new AdminConsoleApp();
    app.cacheElements();
    app.selectedLocationId = 'loc-123';
    app.selectedLocation = { id: 'loc-123', name: 'Test Mall' };

    const claimedSlot = {
      id: 'slot-occupied',
      code: 'OCC-01',
      zone: 'A',
      floor: 1,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      serviceStatus: 'enabled',
      activeBooking: 'booking_active_123', // CLAIMED!
    };

    app.openEditSlotModal(claimedSlot);

    // Code, zone, floor, price must be disabled
    assert.strictEqual(app.el.slotCode.disabled, true);
    assert.strictEqual(app.el.slotZone.disabled, true);
    assert.strictEqual(app.el.slotPriceRupees.disabled, true);

    // Only serviceStatus is editable (to allow putting into maintenance)
    assert.strictEqual(app.el.slotServiceStatus.disabled, false);
    assert.match(app.el.slotStatusClaimedNote.textContent, /occupied/i);
  });

  // ── 9. Backend Security Boundary Verification ───────────────
  await t.test('9. Backend Admin Endpoints Security Boundary (401 & 403 checks)', async (t2) => {
    const expressApp = require('../server/app');
    const { User } = require('../server/models');
    const { generateToken } = require('../server/utils/authUtils');
    const { getJwtConfig } = require('../server/config/env');

    const jwtConfig = getJwtConfig();

    const standardUserToken = generateToken(
      { id: '60d5ec49f1b2c82d88c2e111', role: 'user', email: 'user@example.com' },
      jwtConfig
    );

    // Mock User.findById for standard user lookup in requireAuth
    t2.mock.method(User, 'findById', (id) => {
      const idStr = String(id);
      if (idStr === '60d5ec49f1b2c82d88c2e111') {
        return Promise.resolve({
          _id: idStr,
          role: 'user',
          name: 'Standard User',
          email: 'user@example.com',
        });
      }
      return Promise.resolve(null);
    });

    const server = http.createServer(expressApp);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    // Helper for HTTP requests
    const makeReq = (path, token) => {
      return new Promise((resolve, reject) => {
        const headers = { Connection: 'close' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path,
            method: 'GET',
            headers,
            agent: false,
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(body) });
              } catch {
                resolve({ status: res.statusCode, body });
              }
            });
          }
        );
        req.on('error', reject);
        req.end();
      });
    };

    try {
      // 1. Unauthenticated request to /api/admin/summary -> 401
      const resUnauth = await makeReq('/api/admin/summary', null);
      assert.strictEqual(resUnauth.status, 401, 'Unauthenticated admin summary request must return 401');

      // 2. Standard user request to /api/admin/summary -> 403
      const resStandard = await makeReq('/api/admin/summary', standardUserToken);
      assert.strictEqual(resStandard.status, 403, 'Standard user admin summary request must return 403');

      // 3. Unauthenticated request to /api/admin/locations -> 401
      const resLocUnauth = await makeReq('/api/admin/locations', null);
      assert.strictEqual(resLocUnauth.status, 401, 'Unauthenticated locations request must return 401');

      // 4. Standard user request to /api/admin/locations -> 403
      const resLocStandard = await makeReq('/api/admin/locations', standardUserToken);
      assert.strictEqual(resLocStandard.status, 403, 'Standard user locations request must return 403');

      // 5. Unauthenticated request to /api/admin/bookings -> 401
      const resBookUnauth = await makeReq('/api/admin/bookings', null);
      assert.strictEqual(resBookUnauth.status, 401, 'Unauthenticated bookings request must return 401');

      // 6. Standard user request to /api/admin/bookings -> 403
      const resBookStandard = await makeReq('/api/admin/bookings', standardUserToken);
      assert.strictEqual(resBookStandard.status, 403, 'Standard user bookings request must return 403');
    } finally {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 10. Category and Vehicle Type Whitelist & HTML Options ──
  await t.test('10. Category and Vehicle Type Whitelist & HTML Options', () => {
    // Validate whitelists
    assert.deepStrictEqual(
      Array.from(ALLOWED_CATEGORIES).sort(),
      ['hospital', 'mall', 'office', 'other'].sort(),
      'ALLOWED_CATEGORIES must strictly match backend ParkingLocation model'
    );
    assert.deepStrictEqual(
      Array.from(ALLOWED_VEHICLE_TYPES).sort(),
      ['bike', 'car', 'ev'].sort(),
      'ALLOWED_VEHICLE_TYPES must strictly match backend ParkingSlot model (no truck)'
    );

    // Read public/admin.html and verify select options
    const adminHtml = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
    assert.ok(!adminHtml.includes('value="commercial"'), 'admin.html must not include unsupported "commercial" category');
    assert.ok(!adminHtml.includes('value="airport"'), 'admin.html must not include unsupported "airport" category');
    assert.ok(!adminHtml.includes('value="station"'), 'admin.html must not include unsupported "station" category');
    assert.ok(!adminHtml.includes('value="truck"'), 'admin.html must not include unsupported "truck" vehicle option');
    assert.ok(adminHtml.includes('value="office"'), 'admin.html must include supported "office" category');
  });

  // ── 11. Slot edit PATCH omits unchanged serviceStatus ────────
  await t.test('11. Slot edit PATCH omits unchanged serviceStatus', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();
    app.selectedLocationId = 'loc-123';
    app.selectedLocation = { id: 'loc-123', name: 'Test Mall', status: 'active' };

    // Slot is currently 'enabled'
    const slot = {
      id: 'slot-1',
      code: 'A-101',
      zone: 'A',
      floor: 1,
      vehicleType: 'car',
      pricePerHourPaise: 5000,
      serviceStatus: 'enabled',
      activeBooking: null,
    };

    app.openEditSlotModal(slot);
    // User does not change status (leaves it as 'enabled')
    app.el.slotCode.value = 'A-101';
    app.el.slotPriceRupees.value = '50';
    app.el.slotServiceStatus.value = 'enabled';

    let interceptedPayload = null;
    global.ApiClient = {
      patch: async (url, payload) => {
        interceptedPayload = payload;
        return { success: true, slot };
      },
      get: async () => ({ success: true, slots: [], locations: [], summary: {} }),
    };

    const fakeEvent = { preventDefault: () => {} };
    await app.handleSlotSubmit(fakeEvent);

    assert.ok(interceptedPayload, 'PATCH request should be sent');
    assert.strictEqual(
      interceptedPayload.serviceStatus,
      undefined,
      'Unchanged serviceStatus must NOT be included in slot PATCH request'
    );

    // Now change serviceStatus to 'maintenance'
    app.openEditSlotModal(slot);
    app.el.slotServiceStatus.value = 'maintenance';
    interceptedPayload = null;

    await app.handleSlotSubmit(fakeEvent);
    assert.strictEqual(
      interceptedPayload.serviceStatus,
      'maintenance',
      'Changed serviceStatus must be included in slot PATCH request'
    );
  });

  // ── 12. Occupied slot submit sends strictly serviceStatus ───
  await t.test('12. Occupied slot submit sends strictly serviceStatus and excludes disabled fields', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();
    app.selectedLocationId = 'loc-123';
    app.selectedLocation = { id: 'loc-123', name: 'Test Mall', status: 'active' };

    const occupiedSlot = {
      id: 'slot-occ',
      code: 'OCC-99',
      zone: 'Z',
      floor: 3,
      vehicleType: 'car',
      pricePerHourPaise: 7500,
      serviceStatus: 'enabled',
      activeBooking: 'booking_active_456', // CLAIMED!
    };

    app.openEditSlotModal(occupiedSlot);
    app.el.slotServiceStatus.value = 'maintenance';

    let interceptedPayload = null;
    global.ApiClient = {
      patch: async (url, payload) => {
        interceptedPayload = payload;
        return { success: true, slot: { ...occupiedSlot, serviceStatus: 'maintenance' } };
      },
      get: async () => ({ success: true, slots: [], locations: [], summary: {} }),
    };

    const fakeEvent = { preventDefault: () => {} };
    await app.handleSlotSubmit(fakeEvent);

    assert.ok(interceptedPayload, 'PATCH should be sent for occupied slot maintenance');
    assert.strictEqual(interceptedPayload.serviceStatus, 'maintenance');
    // Disabled fields must NOT be included in the payload
    assert.strictEqual(interceptedPayload.code, undefined, 'code must not be submitted for occupied slot');
    assert.strictEqual(interceptedPayload.zone, undefined, 'zone must not be submitted for occupied slot');
    assert.strictEqual(interceptedPayload.floor, undefined, 'floor must not be submitted for occupied slot');
    assert.strictEqual(interceptedPayload.pricePerHourPaise, undefined, 'pricePerHourPaise must not be submitted for occupied slot');
    assert.strictEqual(interceptedPayload.features, undefined, 'features must not be submitted for occupied slot');

    // Attempting submit without status change should reject without sending PATCH
    app.openEditSlotModal(occupiedSlot);
    app.el.slotServiceStatus.value = 'enabled'; // unchanged
    interceptedPayload = null;
    await app.handleSlotSubmit(fakeEvent);
    assert.strictEqual(interceptedPayload, null, 'PATCH must not be sent if occupied slot status is unchanged');
    assert.match(app.el.slotFormErrorText.textContent, /occupied/i);
  });

  // ── 13. Preservation of unrepresented facilities and features ─
  await t.test('13. Preservation of unrepresented facilities and features during edits', async () => {
    // 1. Pure mergePreservedItems test
    const customFacs = ['Wheelchair Accessible', 'VIP Valet', 'cctv'];
    const checkedFacs = ['cctv', 'ev-charging'];
    const mergedFacs = mergePreservedItems(customFacs, checkedFacs, KNOWN_FACILITY_VALUES);
    assert.ok(mergedFacs.includes('Wheelchair Accessible'), 'Custom facility must be preserved');
    assert.ok(mergedFacs.includes('VIP Valet'), 'Custom facility must be preserved');
    assert.ok(mergedFacs.includes('ev-charging'), 'Checked standard facility must be added');
    assert.ok(mergedFacs.includes('cctv'), 'Checked standard facility must remain');

    // When managed item is unchecked, it is removed
    const uncheckedFacs = ['ev-charging']; // cctv unchecked
    const mergedWithoutCctv = mergePreservedItems(customFacs, uncheckedFacs, KNOWN_FACILITY_VALUES);
    assert.ok(mergedWithoutCctv.includes('Wheelchair Accessible'));
    assert.ok(mergedWithoutCctv.includes('VIP Valet'));
    assert.ok(!mergedWithoutCctv.includes('cctv'), 'Unchecked managed facility must be removed');

    // 2. Location form submission preserves custom facilities
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    const existingLoc = {
      id: 'loc-custom',
      name: 'Custom Plaza',
      facilities: ['Wheelchair Accessible', 'cctv'],
      latitude: 19.0,
      longitude: 72.8,
    };

    app.openEditLocationModal(existingLoc);
    app.el.locName.value = 'Custom Plaza';

    let interceptedLocPayload = null;
    global.ApiClient = {
      patch: async (url, payload) => {
        interceptedLocPayload = payload;
        return { success: true, location: existingLoc };
      },
      get: async () => ({ success: true, locations: [] }),
    };

    const fakeEvent = { preventDefault: () => {} };
    await app.handleLocationSubmit(fakeEvent);

    assert.ok(interceptedLocPayload);
    assert.ok(
      interceptedLocPayload.facilities.includes('Wheelchair Accessible'),
      'Custom facility must be preserved during location update'
    );
  });

  // ── 14. Global location pickers decoupled and follow pagination (>100 locations) ──
  await t.test('14. Global location pickers follow pagination until complete (>100 locations)', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    // Generate 150 mocked locations to test multi-page picker retrieval (>100)
    const mockedLocations = Array.from({ length: 150 }, (_, i) => ({
      id: `loc-${i}`,
      name: `Location ${i}`,
      city: `City ${i % 5}`,
      status: i % 2 === 0 ? 'active' : 'draft',
    }));

    global.ApiClient = {
      get: async (url) => {
        if (url.includes('page=1&limit=100')) {
          return {
            success: true,
            total: 150,
            page: 1,
            limit: 100,
            locations: mockedLocations.slice(0, 100),
          };
        }
        if (url.includes('page=2&limit=100')) {
          return {
            success: true,
            total: 150,
            page: 2,
            limit: 100,
            locations: mockedLocations.slice(100, 150),
          };
        }
        if (url.includes('status=draft')) {
          return { success: true, locations: [mockedLocations[1]], total: 1 };
        }
        return { success: true, locations: [] };
      },
    };

    // Table is filtered to draft only
    app.locationsStatusFilter = 'draft';
    await app.loadLocations();
    assert.strictEqual(app.locations.length, 1, 'Table only has filtered locations');

    // Pickers load ALL locations globally across pages until complete
    await app.loadAllLocationsForPickers();
    assert.strictEqual(app.pickerLocations.length, 150, 'Picker locations must paginate and contain all 150 locations');
    assert.strictEqual(app.pickerLocations[0].id, 'loc-0');
    assert.strictEqual(app.pickerLocations[149].id, 'loc-149');

    // Dropdown contains all 150 locations plus default placeholder
    assert.strictEqual(app.el.selectSlotLocation.children.length, 151, 'Dropdown should have 1 header + 150 options');

    // Out-of-order sequence check for pickers
    let resolveFirst;
    let resolveSecond;
    global.ApiClient.get = (url) => {
      if (url.includes('limit=100')) {
        if (!resolveFirst) {
          return new Promise((res) => { resolveFirst = res; });
        }
        return new Promise((res) => { resolveSecond = res; });
      }
      return Promise.resolve({ success: true, locations: [] });
    };

    const p1 = app.loadAllLocationsForPickers();
    const p2 = app.loadAllLocationsForPickers();

    // Second completes first with fresh data
    resolveSecond({ success: true, total: 1, locations: [{ id: 'fresh', name: 'Fresh Loc', status: 'active' }] });
    await p2;
    assert.strictEqual(app.pickerLocations[0].id, 'fresh');

    // First completes later with stale data
    resolveFirst({ success: true, total: 1, locations: [{ id: 'stale', name: 'Stale Loc', status: 'active' }] });
    await p1;
    assert.strictEqual(app.pickerLocations[0].id, 'fresh', 'Stale pickers response must not overwrite fresh data');
  });

  // ── 15. locations.html includes auth.js and verified admin navigation ──
  await t.test('15. locations.html includes auth.js and authoritatively verifies admin navigation', async () => {
    // 1. Verify locations.html includes auth.js
    const locationsHtml = fs.readFileSync(path.join(__dirname, '../public/locations.html'), 'utf8');
    assert.match(
      locationsHtml,
      /<script src="js\/auth\.js"><\/script>/,
      'locations.html must include js/auth.js'
    );
    // auth.js must be before locations.js
    const authIdx = locationsHtml.indexOf('js/auth.js');
    const locIdx = locationsHtml.indexOf('js/locations.js');
    assert.ok(authIdx !== -1 && locIdx !== -1 && authIdx < locIdx, 'auth.js must be loaded before locations.js');

    // 2. Verify updateHeaderAuthState in locations.js
    const { doc, elements } = setupMockDocument();
    global.document = doc;
    global.updateAdminNavigation = updateAdminNavigation;

    const navAdmin = elements.get('nav-admin-link');
    navAdmin.classList.add('hidden');

    // When logged in as standard user
    global.SessionStore = {
      isLoggedIn: () => true,
      get: () => ({ user: { role: 'user', name: 'Regular Bob' } }),
      getName: () => 'Regular Bob',
      clear: () => {},
    };
    global.verifySession = async () => ({
      authenticated: true,
      user: { role: 'user', name: 'Regular Bob' },
    });

    await LocationDiscoveryApp.updateHeaderAuthState();
    assert.strictEqual(navAdmin.classList.contains('hidden'), true, 'Admin link must remain hidden for standard users');

    // When verified as admin
    global.verifySession = async () => ({
      authenticated: true,
      user: { role: 'admin', name: 'Admin Alice' },
    });

    await LocationDiscoveryApp.updateHeaderAuthState();
    assert.strictEqual(navAdmin.classList.contains('hidden'), false, 'Admin link must be revealed for verified admins');
  });

  // ── 16. Duplicate submit guards and modal focus trap & restoration ──
  await t.test('16. Duplicate submit guards and accessible modal focus trap & restoration', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    // 1. Duplicate submission guard
    let patchCount = 0;
    global.ApiClient = {
      patch: async () => {
        patchCount++;
        return { success: true };
      },
    };

    app.isSubmittingLocation = true;
    const fakeEvent = { preventDefault: () => {} };
    await app.handleLocationSubmit(fakeEvent);
    assert.strictEqual(patchCount, 0, 'handleLocationSubmit must return immediately if already submitting');

    app.isSubmittingSlot = true;
    await app.handleSlotSubmit(fakeEvent);
    assert.strictEqual(patchCount, 0, 'handleSlotSubmit must return immediately if already submitting');

    // 2. Modal focus restoration
    const openerBtn = doc.createElement('button');
    openerBtn.id = 'test-opener-btn';
    doc.activeElement = openerBtn;

    app.openEditLocationModal({ id: 'l1', name: 'Loc 1', facilities: [] });
    assert.strictEqual(app.lastFocusedElement, openerBtn, 'Opening modal should capture trigger element');
    assert.strictEqual(app.activeModal, app.el.modalLocation);

    app.closeLocationModal();
    assert.strictEqual(doc.activeElement, openerBtn, 'Closing modal should restore focus to trigger element');
    assert.strictEqual(app.activeModal, null);
  });

  // ── 17. Slot-Save Responses After Location Switching (Deferred-Response Test) ──
  await t.test('17. Slot-Save Responses After Location Switching (Deferred-Response Controller Test)', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    const locA = { id: 'loc-A', name: 'Location A', status: 'active' };
    const locB = { id: 'loc-B', name: 'Location B', status: 'active' };
    app.pickerLocations = [locA, locB];
    app.locations = [locA, locB];

    // User starts at Location A
    app.selectLocationForSlots('loc-A');
    assert.strictEqual(app.selectedLocationId, 'loc-A');

    const slotA = {
      id: 'slot-A1',
      code: 'A-101',
      zone: 'A',
      floor: 1,
      vehicleType: 'car',
      pricePerHourPaise: 4000,
      serviceStatus: 'enabled',
      activeBooking: null,
    };

    app.openEditSlotModal(slotA);
    assert.strictEqual(app.el.slotLocationId.value, 'loc-A');
    assert.strictEqual(app.el.slotId.value, 'slot-A1');

    // Create a deferred promise for Location A's save
    let resolveSaveA;
    const savePromise = new Promise((resolve) => {
      resolveSaveA = resolve;
    });

    global.ApiClient = {
      patch: async (url, payload) => {
        if (url.includes('loc-A/slots/slot-A1')) {
          await savePromise;
          return { success: true, slot: { ...slotA, ...payload } };
        }
        return { success: true };
      },
      get: async (url) => {
        if (url.includes('loc-A/slots')) {
          return { success: true, slots: [slotA] };
        }
        if (url.includes('loc-B/slots')) {
          return {
            success: true,
            slots: [{ id: 'slot-B1', code: 'B-201', zone: 'B', floor: 2, vehicleType: 'car', serviceStatus: 'enabled', pricePerHourPaise: 5000 }],
          };
        }
        return { success: true, locations: [], summary: {} };
      },
    };

    // Begin saving slot A (in-flight / deferred)
    const fakeEvent = { preventDefault: () => {} };
    const submitPromise = app.handleSlotSubmit(fakeEvent);

    // WHILE save for A is in-flight:
    // User switches to Location B and loads B's slots
    app.selectLocationForSlots('loc-B');
    await app.loadSlotsForLocation('loc-B');
    assert.strictEqual(app.selectedLocationId, 'loc-B');
    assert.strictEqual(app.slots.length, 1);
    assert.strictEqual(app.slots[0].code, 'B-201');

    // User opens a newer editor for Location B (e.g. Add Slot)
    app.openAddSlotModal();
    assert.strictEqual(app.el.modalSlot.classList.contains('hidden'), false);
    assert.strictEqual(app.el.slotLocationId.value, 'loc-B');
    assert.strictEqual(app.el.slotId.value, '');

    // Now resolve Location A's deferred save
    resolveSaveA();
    await submitPromise;

    // Assertions:
    // 1. Location B's slot view MUST NOT be replaced with Location A's slots
    assert.strictEqual(app.selectedLocationId, 'loc-B');
    assert.strictEqual(app.slots.length, 1);
    assert.strictEqual(app.slots[0].code, 'B-201', 'Location B slots must remain intact and not replaced with A slots');

    // 2. The newer editor opened for Location B MUST NOT be closed by Location A's save resolution
    assert.strictEqual(app.el.modalSlot.classList.contains('hidden'), false, 'Newer editor for Location B must remain open');
    assert.strictEqual(app.el.slotLocationId.value, 'loc-B');
  });

  // ── 18. Stale-Response Guards for Locations and Bookings Tables ─
  await t.test('18. Stale-Response Guards for Locations and Bookings Tables', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();

    // 1. Locations table stale response guard
    let resolveLocPage1;
    let resolveLocPage2;
    global.ApiClient = {
      get: (url) => {
        if (url.includes('/api/admin/locations?page=1')) {
          return new Promise((res) => { resolveLocPage1 = res; });
        }
        if (url.includes('/api/admin/locations?page=2')) {
          return new Promise((res) => { resolveLocPage2 = res; });
        }
        return Promise.resolve({ success: true, locations: [], total: 0 });
      },
    };

    app.locationsPage = 1;
    const locP1 = app.loadLocations();

    app.locationsPage = 2;
    const locP2 = app.loadLocations();

    // Page 2 resolves first
    resolveLocPage2({
      success: true,
      total: 20,
      locations: [{ id: 'p2-loc', name: 'Page 2 Location', status: 'active' }],
    });
    await locP2;
    assert.strictEqual(app.locations[0].id, 'p2-loc');

    // Page 1 resolves later (stale)
    resolveLocPage1({
      success: true,
      total: 20,
      locations: [{ id: 'p1-loc', name: 'Page 1 Location', status: 'active' }],
    });
    await locP1;
    assert.strictEqual(app.locations[0].id, 'p2-loc', 'Stale page 1 locations response must not overwrite page 2');

    // 2. Bookings table stale response guard
    let resolveActiveBookings;
    let resolveCancelledBookings;
    global.ApiClient.get = (url) => {
      if (url.includes('status=active')) {
        return new Promise((res) => { resolveActiveBookings = res; });
      }
      if (url.includes('status=cancelled')) {
        return new Promise((res) => { resolveCancelledBookings = res; });
      }
      return Promise.resolve({ success: true, bookings: [], total: 0 });
    };

    app.bookingsStatusFilter = 'active';
    const bP1 = app.loadBookings();

    app.bookingsStatusFilter = 'cancelled';
    const bP2 = app.loadBookings();

    // Cancelled resolves first
    resolveCancelledBookings({
      success: true,
      total: 5,
      bookings: [{ id: 'b-cancelled', status: 'cancelled' }],
    });
    await bP2;
    assert.strictEqual(app.bookings[0].id, 'b-cancelled');

    // Active resolves later (stale)
    resolveActiveBookings({
      success: true,
      total: 10,
      bookings: [{ id: 'b-active', status: 'active' }],
    });
    await bP1;
    assert.strictEqual(app.bookings[0].id, 'b-cancelled', 'Stale active bookings response must not overwrite cancelled bookings');
  });

  // ── 19. Real DTO Vehicle Type Rendering in Bookings Table ────
  await t.test('19. Real DTO Vehicle Type Rendering in Bookings Table (booking.vehicle.type)', () => {
    const { doc } = setupMockDocument();
    global.document = doc;

    const app = new AdminConsoleApp();
    app.cacheElements();

    // Backend DTO provides vehicle.type (not vehicleType)
    app.bookings = [
      {
        id: 'b1',
        createdAt: '2026-10-20T10:00:00.000Z',
        user: { name: 'Alice Smith', email: 'alice@example.com' },
        locationName: 'City Center Mall',
        slotCode: 'C-101',
        vehicle: {
          registrationNumber: 'DL-01-AB-1234',
          type: 'car',
          label: 'My Sedan',
        },
        startTime: '2026-10-20T10:00:00.000Z',
        endTime: '2026-10-20T12:00:00.000Z',
        durationHours: 2,
        totalPaise: 8000,
        status: 'active',
      },
      {
        id: 'b2',
        createdAt: '2026-10-20T11:00:00.000Z',
        user: { name: 'Bob Jones' },
        locationName: 'Metro Station',
        slotCode: 'B-005',
        vehicle: {
          registrationNumber: 'MH-02-XY-9876',
          type: 'ev',
        },
        durationHours: 1,
        totalPaise: 5000,
        status: 'completed',
      },
    ];

    app.renderBookingsTable();

    // Find rendered rows in tbody
    const tbody = app.el.bookingsTbody;
    assert.strictEqual(tbody.children.length, 2);

    // Row 1 vehicle col
    const row1Cells = tbody.children[0].children;
    const vehicleCell1 = row1Cells[3]; // Col 4: Vehicle
    const cell1Text = vehicleCell1.textContent;
    assert.ok(cell1Text.includes('DL-01-AB-1234'));
    assert.ok(cell1Text.includes('CAR'), `Rendered vehicle cell should include 'CAR' from vehicle.type: "${cell1Text}"`);

    // Row 2 vehicle col
    const row2Cells = tbody.children[1].children;
    const vehicleCell2 = row2Cells[3];
    const cell2Text = vehicleCell2.textContent;
    assert.ok(cell2Text.includes('MH-02-XY-9876'));
    assert.ok(cell2Text.includes('EV'), `Rendered vehicle cell should include 'EV' from vehicle.type: "${cell2Text}"`);
  });

  // ── 20. Occupied Slot Actions & State Guard ───────────────────
  await t.test('20. Occupied Slot Actions & State Guard (No Enable/Archive, Lock In Maintenance)', async () => {
    const { doc } = setupMockDocument();
    global.document = doc;
    global.setText = () => {};

    const app = new AdminConsoleApp();
    app.cacheElements();
    app.selectedLocationId = 'loc-test';
    app.selectedLocation = { id: 'loc-test', name: 'Test Mall', status: 'active' };

    const occupiedEnabledSlot = {
      id: 'slot-occ-en',
      code: 'OCC-1',
      serviceStatus: 'enabled',
      activeBooking: 'booking_123',
    };

    const occupiedMaintenanceSlot = {
      id: 'slot-occ-maint',
      code: 'OCC-2',
      serviceStatus: 'maintenance',
      activeBooking: 'booking_456',
    };

    app.slots = [occupiedEnabledSlot, occupiedMaintenanceSlot];
    app.renderSlotsTable();

    const tbody = app.el.slotsTbody;
    assert.strictEqual(tbody.children.length, 2);

    // Row 1: Occupied in 'enabled'
    const row1Actions = tbody.children[0].children[7].children;
    const row1ButtonTexts = row1Actions.map((c) => c.textContent);
    assert.ok(row1ButtonTexts.includes('Edit'), 'Edit button should be offered');
    assert.ok(row1ButtonTexts.includes('Maintenance'), 'Maintenance button should be offered for occupied enabled slot');
    assert.ok(!row1ButtonTexts.includes('Enable'), 'Enable button must NOT be offered for occupied slot');
    assert.ok(!row1ButtonTexts.includes('Archive'), 'Archive button must NOT be offered for occupied slot');

    // Row 2: Occupied ALREADY in 'maintenance'
    const row2Actions = tbody.children[1].children[7].children;
    const row2ButtonTexts = row2Actions.map((c) => c.textContent);
    assert.ok(row2ButtonTexts.includes('Edit'), 'Edit button should be offered');
    assert.ok(!row2ButtonTexts.includes('Enable'), 'Enable button must NOT be offered for occupied slot in maintenance');
    assert.ok(!row2ButtonTexts.includes('Maintenance'), 'Maintenance toggle button must NOT be offered when already in maintenance');
    assert.ok(!row2ButtonTexts.includes('Archive'), 'Archive button must NOT be offered for occupied slot');
    const row2Text = tbody.children[1].children[7].textContent;
    assert.ok(row2Text.includes('In Maintenance'), 'Should display "In Maintenance" state without invalid transition');

    // Modal check for occupied enabled slot:
    app.openEditSlotModal(occupiedEnabledSlot);
    const selectOptions1 = Array.from(app.el.slotServiceStatus.children).map((c) => c.value);
    assert.ok(selectOptions1.includes('maintenance'), 'Must offer maintenance transition');
    assert.ok(!selectOptions1.includes('archived'), 'Must NOT offer archived transition for occupied slot');
    assert.strictEqual(app.el.slotServiceStatus.disabled, false);

    // Modal check for occupied slot ALREADY in maintenance:
    app.openEditSlotModal(occupiedMaintenanceSlot);
    const selectOptions2 = Array.from(app.el.slotServiceStatus.children).map((c) => c.value);
    assert.deepStrictEqual(selectOptions2, ['maintenance'], 'Only maintenance state should be present');
    assert.strictEqual(app.el.slotServiceStatus.disabled, true, 'Status select must be disabled');
    assert.strictEqual(app.el.btnSaveSlot.disabled, true, 'Save button must be disabled for occupied maintenance slot');

    // Direct toggleSlotMaintenance reject check:
    let alertCalled = false;
    app.showGlobalAlert = (msg, type) => {
      alertCalled = true;
      assert.strictEqual(type, 'error');
    };
    await app.toggleSlotMaintenance(occupiedMaintenanceSlot);
    assert.strictEqual(alertCalled, true, 'Attempting to toggle occupied maintenance slot to enabled must reject');
  });

  // ── 21. Admin Console Modern UI Structure & Zero Emoji Invariant ──
  await t.test('21. Admin Console Modern UI Structure & Zero Emoji Invariant', async () => {
    const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');
    const adminCssPath = path.join(__dirname, '..', 'public', 'css', 'admin.css');
    const adminJsPath = path.join(__dirname, '..', 'public', 'js', 'admin.js');

    const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
    const adminCss = fs.readFileSync(adminCssPath, 'utf8');
    const adminJs = fs.readFileSync(adminJsPath, 'utf8');

    // Emoji regex checking standard emoji ranges (symbols, pictographs, emoticons, transport)
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

    // A. admin.html must not contain any emoji icons
    const htmlEmojiMatch = adminHtml.match(emojiRegex);
    assert.strictEqual(htmlEmojiMatch, null, `admin.html must not contain emoji icons. Found: ${htmlEmojiMatch && htmlEmojiMatch[0]}`);

    // B. admin.js must not contain any emoji icons in status or badge code
    const jsEmojiMatch = adminJs.match(emojiRegex);
    assert.strictEqual(jsEmojiMatch, null, `admin.js must not contain emoji icons. Found: ${jsEmojiMatch && jsEmojiMatch[0]}`);

    // C. SVG icons must be present and marked aria-hidden="true"
    assert.ok(adminHtml.includes('<svg class="admin-icon"'), 'admin.html must include decorative admin SVG icons');
    assert.ok(adminHtml.includes('aria-hidden="true"'), 'admin.html SVGs must include aria-hidden="true"');

    // D. Preserved text labels in buttons & tabs
    assert.ok(adminHtml.includes('<span>Overview</span>'), 'Overview text label preserved');
    assert.ok(adminHtml.includes('<span>Locations</span>'), 'Locations text label preserved');
    assert.ok(adminHtml.includes('<span>Slot Inventory</span>'), 'Slot Inventory text label preserved');
    assert.ok(adminHtml.includes('<span>Bookings</span>'), 'Bookings text label preserved');
    assert.ok(adminHtml.includes('<span>Refresh</span>'), 'Refresh text label preserved');
    assert.ok(adminHtml.includes('<span>Add Location</span>'), 'Add Location text label preserved');
    assert.ok(adminHtml.includes('<span>Add Slot</span>'), 'Add Slot text label preserved');
    assert.ok(adminHtml.includes('<span>Refresh Bookings</span>'), 'Refresh Bookings text label preserved');

    // E. Essential CSS tokens, button classes, and semantic badges defined in admin.css
    const requiredCssSelectors = [
      'header.site-header',
      '.header-inner',
      '.header-user-badge',
      '.btn',
      '.btn-primary',
      '.btn-outline',
      '.btn-secondary',
      '.btn-danger',
      '.btn-sm',
      '.btn-xs',
      ':focus-visible',
      '.tab-toolbar',
      '.toolbar-filters',
      '.toolbar-actions',
      '.badge-draft',
      '.badge-active',
      '.badge-closed',
      '.badge-archived',
      '.badge-enabled',
      '.badge-maintenance',
      '.badge-occupied',
      '.badge-available',
      '.badge-completed',
      '.badge-cancelled',
    ];

    for (const sel of requiredCssSelectors) {
      assert.ok(adminCss.includes(sel), `admin.css must define "${sel}" selector`);
    }
  });
});

