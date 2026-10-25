// tests/stage11a.test.js — Stage 11A Real Dashboard, History, Cancellation & Live Countdown Tests
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
const { validateDatabaseConfig, getJwtConfig } = require('../server/config/env');
const { generateToken } = require('../server/utils/authUtils');
const { ApiError } = require('../public/js/api');

// Frontend modules to test
const {
  DashboardApp,
  formatPaise: formatPaiseDash,
  calculateRemainingMs: calculateRemainingMsDash,
  formatRemainingTime: formatRemainingTimeDash,
  createBookingCard,
} = require('../public/js/dashboard');

const {
  HistoryApp,
  formatPaise: formatPaiseHist,
  calculateRemainingMs: calculateRemainingMsHist,
  formatRemainingTime: formatRemainingTimeHist,
  getVehicleIcon,
  createHistoryCard,
} = require('../public/js/history');

// ── Mock DOM Infrastructure ───────────────────────────────────

function createMockElement(tagName = 'div', id = '') {
  const children = [];
  const attributes = {};
  const listeners = new Map();
  let _textContent = '';
  let _innerHTML = '';
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
      if (_innerHTML) return _innerHTML;
      if (children.length > 0) {
        return children.map((c) => c.innerHTML).join('');
      }
      return _textContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    },
    set innerHTML(val) {
      _innerHTML = String(val);
      if (val === '') children.length = 0;
    },
    setAttribute: (k, v) => {
      attributes[k] = String(v);
      if (k.startsWith('data-')) {
        const prop = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        _dataset[prop] = String(v);
      }
    },
    getAttribute: (k) => attributes[k] ?? null,
    removeAttribute: (k) => {
      delete attributes[k];
      if (k.startsWith('data-')) {
        const prop = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete _dataset[prop];
      }
    },
    appendChild: (child) => {
      if (child) {
        child.parentElement = el;
        children.push(child);
      }
      return child;
    },
    remove: () => {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
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
    _listeners: listeners,
    dispatchEvent: (evt) => {
      let stopped = false;
      const eventObj = {
        target: el,
        currentTarget: el,
        type: typeof evt === 'string' ? evt : evt.type,
        bubbles: evt.bubbles !== false,
        persisted: evt.persisted,
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
    matches: (sel) => {
      const selectors = sel.split(',').map((s) => s.trim());
      for (const s of selectors) {
        if (s.startsWith('.') && el.classList?.contains(s.slice(1))) return true;
        if (s.startsWith('#') && el.id === s.slice(1)) return true;
        if (s.startsWith('[') && s.includes('=')) {
          const m = s.match(/\[([a-zA-Z0-9_\-]+)="?([^"\]]+)"?\]/);
          if (m && el.getAttribute && el.getAttribute(m[1]) === m[2]) return true;
        }
        if (s.startsWith('[') && !s.includes('=')) {
          const attr = s.slice(1, -1);
          if (el.getAttribute && el.getAttribute(attr) !== null) return true;
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
          if (sel.startsWith('[') && sel.includes('=')) {
            const m = sel.match(/\[([a-zA-Z0-9_\-]+)="?([^"\]]+)"?\]/);
            if (m && c.getAttribute && c.getAttribute(m[1]) === m[2]) return c;
          }
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
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) results.push(c);
          if (sel.includes('[data-countdown-end]') && c.getAttribute && c.getAttribute('data-countdown-end')) {
            results.push(c);
          }
          findMatching(c);
        }
      };
      findMatching(el);
      return results;
    },
    closest: (sel) => {
      let curr = el;
      while (curr) {
        if (curr.matches && curr.matches(sel)) return curr;
        curr = curr.parentElement;
      }
      return null;
    },
  };

  // Faithful browser HTMLElement.dataset: getter-only, throws TypeError on direct assignment
  Object.defineProperty(el, 'dataset', {
    get() {
      return datasetProxy;
    },
    set(_val) {
      throw new TypeError("Cannot set property dataset of #<HTMLElement> which has only a getter");
    },
    enumerable: true,
    configurable: true,
  });

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

  const ids = [
    // Dashboard IDs
    'header-user-name',
    'welcome-name',
    'welcome-meta',
    'nav-admin-link',
    'btn-logout',
    'stat-total-bookings',
    'stat-active-bookings',
    'stat-completed-bookings',
    'stat-cancelled-bookings',
    'active-bookings-count',
    'active-bookings-list',
    'dashboard-loading',
    'dashboard-error',
    'dashboard-error-msg',
    'btn-retry-dashboard',
    'no-bookings-msg',
    'dashboard-preview-notice',
    'dashboard-preview-text',
    'dashboard-preview-link',
    // History IDs
    'stat-total',
    'stat-active',
    'stat-completed',
    'stat-cancelled',
    'tab-all',
    'tab-active',
    'tab-completed',
    'tab-cancelled',
    'tab-count-all',
    'tab-count-active',
    'tab-count-completed',
    'tab-count-cancelled',
    'search-input',
    'sort-select',
    'results-count',
    'history-list',
    'history-empty-state',
    'history-loading',
    'history-error',
    'history-error-msg',
    'btn-retry-history',
    'history-pagination',
    'history-page-info',
    'history-prev-btn',
    'history-next-btn',
    'dashboard-initial-loading',
    'history-initial-loading',
    'main-content',
  ];

  ids.forEach((id) => getOrCreate(id));

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
        if (sel.includes('[data-countdown-end]') && el.getAttribute && el.getAttribute('data-countdown-end')) {
          results.push(el);
        }
        const inner = el.querySelectorAll(sel);
        results.push(...inner);
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
// TEST SUITE: STAGE 11A REAL DATA, HISTORY & LIVE COUNTDOWN
// ══════════════════════════════════════════════════════════════

test.describe('Stage 11A — Real Dashboard, History, Cancellation & Live Countdown', () => {
  let server;
  let baseUrl;
  let userA, userB;
  let userAToken, userBToken;
  let loc, slotA1, slotB1;
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
      passwordHash: 'dummy_hash_for_testing',
      role: 'user',
    });
    createdUserIds.push(userA._id);
    userAToken = generateToken(userA, jwtConfig);

    // Create User B (for user ownership tests)
    userB = await User.create({
      name: `User B ${runId}`,
      email: `userb_${runId}@example.com`,
      phone: '9876543211',
      passwordHash: 'dummy_hash_for_testing',
      role: 'user',
    });
    createdUserIds.push(userB._id);
    userBToken = generateToken(userB, jwtConfig);

    // Create Location
    loc = await ParkingLocation.create({
      name: `Grand Mall ${runId}`,
      slug: `grand-mall-${runId}`,
      category: 'mall',
      address: '123 Main St',
      city: 'Delhi',
      area: 'Central',
      latitude: 28.6139,
      longitude: 77.209,
      totalSlots: 10,
      availableSlots: 8,
      status: 'active',
    });
    createdLocationIds.push(loc._id);

    // Create Slots
    slotA1 = await ParkingSlot.create({
      location: loc._id,
      code: 'A-01',
      zone: 'A',
      vehicleType: 'car',
      floor: 1,
      distanceFromEntry: 15,
      pricePerHourPaise: 5000,
      isAvailable: false,
      status: 'claimed',
    });
    createdSlotIds.push(slotA1._id);

    slotB1 = await ParkingSlot.create({
      location: loc._id,
      code: 'B-01',
      zone: 'B',
      vehicleType: 'ev',
      floor: 1,
      distanceFromEntry: 25,
      pricePerHourPaise: 8000,
      isAvailable: true,
      status: 'available',
    });
    createdSlotIds.push(slotB1._id);

    const now = new Date();
    const inTwoHours = new Date(now.getTime() + 7200000);
    const pastTwoHours = new Date(now.getTime() - 7200000);
    const pastOneHour = new Date(now.getTime() - 3600000);

    // 1. Active booking for User A
    const bA1 = await Booking.create({
      user: userA._id,
      location: loc._id,
      slot: slotA1._id,
      locationName: loc.name,
      slotCode: 'A-01',
      vehicle: { registrationNumber: 'DL01AA1111', type: 'car' },
      pricePerHourPaise: 5000,
      startTime: now,
      endTime: inTwoHours,
      durationHours: 2,
      totalPaise: 10000,
      status: 'active',
      requestId: randomUUID(),
    });
    createdBookingIds.push(bA1._id);

    // 2. Completed booking for User A
    const bA2 = await Booking.create({
      user: userA._id,
      location: loc._id,
      slot: slotA1._id,
      locationName: loc.name,
      slotCode: 'A-01',
      vehicle: { registrationNumber: 'DL01BB2222', type: 'bike' },
      pricePerHourPaise: 2000,
      startTime: pastTwoHours,
      endTime: pastOneHour,
      durationHours: 1,
      totalPaise: 2000,
      status: 'completed',
      requestId: randomUUID(),
    });
    createdBookingIds.push(bA2._id);

    // 3. Cancelled booking for User A
    const bA3 = await Booking.create({
      user: userA._id,
      location: loc._id,
      slot: slotB1._id,
      locationName: loc.name,
      slotCode: 'B-01',
      vehicle: { registrationNumber: 'KA03EV3333', type: 'ev' },
      pricePerHourPaise: 8000,
      startTime: pastTwoHours,
      endTime: pastOneHour,
      durationHours: 1,
      totalPaise: 8000,
      status: 'cancelled',
      requestId: randomUUID(),
    });
    createdBookingIds.push(bA3._id);

    // 4. Active booking for User B (User A must never see this)
    const bB1 = await Booking.create({
      user: userB._id,
      location: loc._id,
      slot: slotB1._id,
      locationName: loc.name,
      slotCode: 'B-01',
      vehicle: { registrationNumber: 'MH12SECRET', type: 'ev' },
      pricePerHourPaise: 8000,
      startTime: now,
      endTime: inTwoHours,
      durationHours: 2,
      totalPaise: 16000,
      status: 'active',
      requestId: randomUUID(),
    });
    createdBookingIds.push(bB1._id);

    // Start HTTP server on dynamic port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  // ── Teardown & Scoped Cleanup ─────────────────────────────────
  test.after(async () => {
    try {
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

  // ── Helper: Authenticated Fetch ──────────────────────────────
  async function apiGet(path, token) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  // ══════════════════════════════════════════════════════════════
  // PART 1: BACKEND EXTENSION & ISOLATION TESTS
  // ══════════════════════════════════════════════════════════════

  test.it('1. GET /api/bookings/me returns all-time counts breakdown and serverTime', async () => {
    const { status, data } = await apiGet('/api/bookings/me', userAToken);
    assert.equal(status, 200);
    assert.ok(data.success);
    assert.ok(data.serverTime, 'Must include serverTime');

    // Counts breakdown
    assert.ok(data.counts, 'Must include all-time counts breakdown');
    assert.equal(data.counts.total, 3, 'User A total bookings should be 3');
    assert.equal(data.counts.active, 1, 'User A active bookings should be 1');
    assert.equal(data.counts.completed, 1, 'User A completed bookings should be 1');
    assert.equal(data.counts.cancelled, 1, 'User A cancelled bookings should be 1');
  });

  test.it('2. User Ownership Isolation: User A cannot see or search User B bookings', async () => {
    // User A searches for User B's vehicle registration
    const { status, data } = await apiGet('/api/bookings/me?search=MH12SECRET', userAToken);
    assert.equal(status, 200);
    assert.equal(data.total, 0, 'User A must find 0 results for User B vehicle');
    assert.equal(data.bookings.length, 0);

    // User B searches for User B's vehicle registration
    const { status: statusB, data: dataB } = await apiGet('/api/bookings/me?search=MH12SECRET', userBToken);
    assert.equal(statusB, 200);
    assert.equal(dataB.total, 1, 'User B must find own booking');
    assert.equal(dataB.bookings[0].vehicle.registrationNumber, 'MH12SECRET');
  });

  test.it('3. GET /api/bookings/me search queries across location, slot, vehicle, and type', async () => {
    // Search by slotCode (User A has bA1 and bA2 in slot A-01 -> total 2)
    const resSlot = await apiGet('/api/bookings/me?search=A-01', userAToken);
    assert.equal(resSlot.data.total, 2);
    assert.equal(resSlot.data.bookings[0].slotCode, 'A-01');

    // Search by vehicle type
    const resType = await apiGet('/api/bookings/me?search=bike', userAToken);
    assert.equal(resType.data.total, 1);
    assert.equal(resType.data.bookings[0].vehicle.type, 'bike');

    // Search by vehicle registration
    const resReg = await apiGet('/api/bookings/me?search=DL01AA1111', userAToken);
    assert.equal(resReg.data.total, 1);
    assert.equal(resReg.data.bookings[0].vehicle.registrationNumber, 'DL01AA1111');
  });

  test.it('4. GET /api/bookings/me sorting strictly validates whitelist with Map and includes _id tie-breaker', async () => {
    // Sort cost-high: User A has 10000 paise (car), 8000 paise (ev), 2000 paise (bike)
    const resCost = await apiGet('/api/bookings/me?sort=cost-high', userAToken);
    assert.equal(resCost.status, 200);
    assert.equal(resCost.data.bookings[0].totalPaise, 10000);
    assert.equal(resCost.data.bookings[1].totalPaise, 8000);
    assert.equal(resCost.data.bookings[2].totalPaise, 2000);

    // Sort cost-low
    const resCostLow = await apiGet('/api/bookings/me?sort=cost-low', userAToken);
    assert.equal(resCostLow.status, 200);
    assert.equal(resCostLow.data.bookings[0].totalPaise, 2000);

    // Prototype pollution attempt: 'toString' or 'constructor' must be rejected and fallback to default sort
    const resProto = await apiGet('/api/bookings/me?sort=toString', userAToken);
    assert.equal(resProto.status, 200);
    assert.equal(resProto.data.bookings.length, 3);

    const resConstructor = await apiGet('/api/bookings/me?sort=constructor', userAToken);
    assert.equal(resConstructor.status, 200);
    assert.equal(resConstructor.data.bookings.length, 3);
  });

  // ══════════════════════════════════════════════════════════════
  // MOCK DOM BEFORE EACH
  // ══════════════════════════════════════════════════════════════
  let currentDoc;
  let currentElements;

  test.beforeEach(() => {
    DashboardApp.resetDisposed();
    HistoryApp.resetDisposed();

    const { doc, elements } = setupMockDocument();
    currentDoc = doc;
    currentElements = elements;
    global.document = doc;
    global.getElement = (id) => doc.getElementById(id);
    global.setText = (id, val) => {
      const el = doc.getElementById(id);
      if (el) el.textContent = String(val ?? '');
    };
    global.showToast = () => {};
    global.formatDateTime = () => 'Today';
    global.formatTime = () => '10:00';
    global.formatDuration = (d) => `${d} hr`;
    global.getStatusClass = (s) => `status--${s}`;
    global.getVehicleTypeLabel = (t) => String(t || '').toUpperCase();
    global.capitalise = (s) => String(s || '').toUpperCase();
    global.formatCurrency = (n) => `₹${n}`;
    const windowListeners = new Map();
    global.window = {
      confirm: () => true,
      addEventListener: (evt, fn) => {
        if (!windowListeners.has(evt)) windowListeners.set(evt, []);
        windowListeners.get(evt).push(fn);
      },
      removeEventListener: (evt, fn) => {
        if (windowListeners.has(evt)) {
          const list = windowListeners.get(evt);
          const idx = list.indexOf(fn);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
      dispatchEvent: (evt) => {
        const eventObj = typeof evt === 'string' ? { type: evt } : evt;
        const fns = [...(windowListeners.get(eventObj.type) || [])];
        fns.forEach((fn) => fn(eventObj));
      },
      location: { pathname: '/dashboard.html', search: '', href: 'http://localhost:5000/dashboard.html' },
    };
    global.requireAuth = async () => ({ id: 'test-user-1', name: 'Test User', role: 'user' });
  });

  // ══════════════════════════════════════════════════════════════
  // PART 2: FRONTEND UNIT & FORMATTING TESTS
  // ══════════════════════════════════════════════════════════════

  test.it('5. Currency & Paise formatting produces integer Rupee strings without decimals', () => {
    assert.ok(formatPaiseDash(5000).includes('50'));
    assert.ok(formatPaiseDash(10000).includes('100'));
    assert.ok(formatPaiseDash(0).includes('0'));
    assert.ok(formatPaiseHist(8500).includes('85'));
  });

  test.it('6. Live countdown calculation applies serverClockOffset and clamps at zero', () => {
    const now = Date.now();
    const futureEndTime = new Date(now + 120000).toISOString(); // 2 minutes future
    const pastEndTime = new Date(now - 30000).toISOString(); // 30s past

    // Zero offset
    DashboardApp.setServerClockOffset(0);
    const remFuture = calculateRemainingMsDash(futureEndTime);
    assert.ok(remFuture > 115000 && remFuture <= 120000);

    const remPast = calculateRemainingMsDash(pastEndTime);
    assert.equal(remPast, 0, 'Past end time must clamp to zero');
    assert.equal(formatRemainingTimeDash(0), 'Checking booking status…');

    // Server clock offset: Server is 1 minute behind client (-60000ms)
    DashboardApp.setServerClockOffset(-60000);
    const remWithOffset = calculateRemainingMsDash(futureEndTime);
    assert.ok(remWithOffset > 175000 && remWithOffset <= 180000);
  });

  test.it('7. DTO Card Builders adhere to getter-only dataset and construct safe DOM without markup execution or attribute injection', () => {
    const mockBooking = {
      id: 'b-test-123',
      locationName: 'Mall "Grand" & \'Central\' <script>alert(1)</script>',
      slotCode: 'A-01',
      vehicle: { registrationNumber: 'DL01"test"<tag>1234', type: 'car' },
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    // Verify getter-only dataset: assigning to article.dataset must throw in faithful mock
    const testEl = createMockElement('article');
    assert.throws(
      () => {
        testEl.dataset = {};
      },
      TypeError,
      'Assigning to dataset property directly must throw TypeError'
    );

    // Verify Dashboard card builder executes cleanly without throwing
    const card = createBookingCard(mockBooking);
    assert.ok(card);
    assert.equal(card.dataset.status, 'active');
    assert.equal(card.dataset.id, 'b-test-123');

    // Safe DOM checks: location text is set via textContent
    const locEl = card.querySelector('.booking-card__location');
    assert.ok(locEl);
    assert.ok(locEl.textContent.includes('Mall "Grand" & \'Central\' <script>alert(1)</script>'));

    // Cancel button dataset preserves quotes literally without corrupting attribute
    const cancelBtn = card.querySelector('.btn-cancel');
    assert.ok(cancelBtn);
    assert.equal(cancelBtn.dataset.locationName, 'Mall "Grand" & \'Central\' <script>alert(1)</script>');
    assert.equal(cancelBtn.getAttribute('data-location-name'), 'Mall "Grand" & \'Central\' <script>alert(1)</script>');
    assert.equal(cancelBtn.dataset.bookingId, 'b-test-123');

    // Verify History card builder executes cleanly
    const histCard = createHistoryCard(mockBooking);
    assert.ok(histCard);
    assert.equal(histCard.dataset.status, 'active');
    assert.equal(histCard.dataset.id, 'b-test-123');
    const histLoc = histCard.querySelector('.history-card__location');
    assert.ok(histLoc.textContent.includes('Mall "Grand" & \'Central\' <script>alert(1)</script>'));
  });

  // ══════════════════════════════════════════════════════════════
  // PART 3: CONTROLLER MOCK DOM & STATE MANAGEMENT TESTS
  // ══════════════════════════════════════════════════════════════

  test.it('8. Dashboard Totals populate from all-time counts across multiple pages & handles preview notice', async () => {
    const doc = currentDoc;
    const elements = currentElements;

    // Mock ApiClient returning 1 active card on page 1, but all-time counts = 12 total, 55 active
    global.ApiClient = {
      get: async (url) => {
        return {
          success: true,
          total: 55,
          serverTime: new Date().toISOString(),
          counts: { total: 100, active: 55, completed: 40, cancelled: 5 },
          bookings: [
            {
              id: 'bk-act-1',
              locationName: 'City Center',
              slotCode: 'C-01',
              vehicle: { registrationNumber: 'KA01AA1234', type: 'car' },
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
              durationHours: 1,
              totalPaise: 4000,
              status: 'active',
            },
          ],
        };
      },
    };

    await DashboardApp.loadDashboardData({ silent: false });

    assert.equal(elements.get('stat-total-bookings').textContent, '100');
    assert.equal(elements.get('stat-active-bookings').textContent, '55');
    assert.equal(elements.get('stat-completed-bookings').textContent, '40');
    assert.equal(elements.get('stat-cancelled-bookings').textContent, '5');
    assert.equal(elements.get('active-bookings-count').textContent, '55');

    // Preview notice is displayed because 55 active > 1 rendered
    const previewNotice = elements.get('dashboard-preview-notice');
    assert.ok(previewNotice);
    assert.equal(previewNotice.classList.contains('hidden'), false);
    assert.ok(elements.get('dashboard-preview-text').textContent.includes('Showing latest 1 of 55 active bookings'));

    DashboardApp.cleanup();
  });

  test.it('9. History Filters, Search, Sorting, and Pagination Boundary auto-correction', async () => {
    let lastQueriedUrl = '';
    let mockTotal = 25;
    global.ApiClient = {
      get: async (url) => {
        lastQueriedUrl = url;
        return {
          success: true,
          total: mockTotal,
          page: 1,
          limit: 10,
          serverTime: new Date().toISOString(),
          counts: { total: mockTotal, active: 2, completed: 20, cancelled: 3 },
          bookings: [],
        };
      },
    };

    // Test status tab change
    const activeTab = createMockElement('button', 'tab-active');
    activeTab.dataset.status = 'active';
    HistoryApp.activateStatusTab(activeTab);
    assert.equal(HistoryApp.getCurrentPage(), 1);
    assert.equal(HistoryApp.getActiveStatus(), 'active');
    assert.ok(lastQueriedUrl.includes('status=active'));

    // Test search filter
    HistoryApp.setSearchQuery('A-01');
    HistoryApp.setCurrentPage(1);
    await HistoryApp.loadHistory({ silent: false });
    assert.ok(lastQueriedUrl.includes('search=A-01'));
    assert.ok(lastQueriedUrl.includes('page=1'));

    // Test pagination boundary recovery:
    // If user is on page 4, but filtered total drops to 5 (maxPage = 1),
    // currentPage should automatically correct to 1 instead of showing "Page 4 of 1"
    mockTotal = 5;
    HistoryApp.setCurrentPage(4);
    await HistoryApp.loadHistory({ silent: false });
    assert.equal(HistoryApp.getCurrentPage(), 1, 'Current page must move to valid page (1) and refetch');

    HistoryApp.cleanup();
  });

  test.it('10. Stale response protection discards out-of-order responses', async () => {
    const doc = currentDoc;
    let resolveFirst;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });

    let callCount = 0;
    global.ApiClient = {
      get: async (url) => {
        callCount++;
        if (callCount === 1) {
          await firstPromise;
          return {
            success: true,
            total: 999,
            counts: { total: 999, active: 999, completed: 0, cancelled: 0 },
            bookings: [],
          };
        }
        return {
          success: true,
          total: 5,
          counts: { total: 5, active: 1, completed: 3, cancelled: 1 },
          bookings: [],
        };
      },
    };

    // Trigger first request
    const p1 = DashboardApp.loadDashboardData({ silent: true });
    // Trigger second request immediately
    const p2 = DashboardApp.loadDashboardData({ silent: true });

    await p2;
    // Resolve first request late
    resolveFirst();
    await p1;

    // Stat total should reflect the newer response (5), NOT the stale response (999)
    assert.equal(doc.getElementById('stat-total-bookings').textContent, '5');

    DashboardApp.cleanup();
  });

  test.it('11. Cancellation: pending tracking, network ambiguity, refresh failure recovery, and 401 handling', async () => {
    let confirmAnswer = false;
    global.window = {
      confirm: () => confirmAnswer,
      location: { pathname: '/dashboard.html', search: '', href: 'http://localhost:5000/dashboard.html' },
    };

    let toastMsg = '';
    let toastType = '';
    global.showToast = (msg, type) => {
      toastMsg = msg;
      toastType = type;
    };

    const cancelBtn = createMockElement('button');
    cancelBtn.textContent = 'Cancel';

    // 1. User cancels confirm modal -> no action
    confirmAnswer = false;
    await DashboardApp.handleCancelBooking('b-1', 'A-01', 'Facility A', cancelBtn);
    assert.equal(cancelBtn.disabled, false);
    assert.equal(toastMsg, '');

    // 2. User confirms -> returns completed (already settled)
    confirmAnswer = true;
    global.ApiClient = {
      patch: async () => {
        return {
          success: true,
          booking: { id: 'b-1', status: 'completed' },
        };
      },
      get: async () => ({ success: true, bookings: [], counts: {} }),
    };

    await DashboardApp.handleCancelBooking('b-1', 'A-01', 'Facility A', cancelBtn);
    assert.ok(toastMsg.includes('had already expired and is now marked completed'));
    assert.equal(toastType, 'info');

    // 3. Network error with ApiError contract -> explicit unconfirmed statement without claiming failure
    global.ApiClient = {
      patch: async () => {
        throw new ApiError('Network disconnected', { status: 0, code: 'NETWORK_ERROR', isNetwork: true });
      },
    };

    await DashboardApp.handleCancelBooking('b-2', 'B-01', 'Facility B', cancelBtn);
    assert.equal(toastMsg, 'Cancellation outcome is not yet confirmed. Refresh to check before trying again.');
    assert.equal(toastType, 'warning');
    assert.equal(cancelBtn.disabled, false);
    assert.equal(cancelBtn.textContent, 'Retry Cancellation');

    // 4. Cancellation succeeds, but subsequent list refresh fails:
    // Should NOT leave button permanently stuck on "Cancelling…"
    global.ApiClient = {
      patch: async () => ({
        success: true,
        booking: { id: 'b-3', status: 'cancelled' },
      }),
      get: async () => {
        throw new Error('Refresh error');
      },
    };

    await DashboardApp.handleCancelBooking('b-3', 'C-01', 'Facility C', cancelBtn);
    assert.equal(cancelBtn.disabled, false);
    assert.equal(cancelBtn.textContent, 'Refresh List');

    // 5. 401 Session expiry handling: cleans up and redirects safely
    let redirectedUrl = '';
    global.redirectTo = (url) => {
      redirectedUrl = url;
    };
    let sessionCleared = false;
    global.SessionStore = {
      clear: () => { sessionCleared = true; },
      isLoggedIn: () => false,
    };

    global.ApiClient = {
      patch: async () => {
        throw new ApiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' });
      },
    };

    await DashboardApp.handleCancelBooking('b-4', 'D-01', 'Facility D', cancelBtn);
    assert.equal(sessionCleared, true, 'SessionStore.clear must be called on 401');
    assert.ok(redirectedUrl.includes('login.html'), 'Must redirect to login on 401');
    assert.equal(DashboardApp.isDisposed(), true, 'Dashboard must be disposed on 401 redirect');

    DashboardApp.cleanup();
  });

  test.it('12. Page lifecycle, hidden tab pausing, and overlapping refresh protection', async () => {
    let getCallCount = 0;
    global.ApiClient = {
      get: async () => {
        getCallCount++;
        return { success: true, bookings: [], counts: {} };
      },
    };

    // When document is hidden, silent background refresh should NOT fetch
    global.document.hidden = true;
    await DashboardApp.loadDashboardData({ silent: true });
    assert.equal(getCallCount, 0, 'Silent refresh must not fetch when document is hidden');

    global.document.hidden = false;
    await DashboardApp.loadDashboardData({ silent: true });
    assert.equal(getCallCount, 1, 'Silent refresh must fetch when document is visible');

    // Successful silent refresh clears any prior error banner
    const elements = currentElements;
    elements.get('dashboard-error').classList.remove('hidden');
    await DashboardApp.loadDashboardData({ silent: true });
    assert.equal(elements.get('dashboard-error').classList.contains('hidden'), true, 'Successful silent refresh must clear error banner');

    DashboardApp.cleanup();
  });

  test.it('13. No legacy localStorage booking mutations occur during operations', async () => {
    let setItemCalled = false;

    global.localStorage = {
      getItem: () => null,
      setItem: (key) => {
        if (key.includes('booking') || key.includes('slot')) setItemCalled = true;
      },
    };

    global.ApiClient = {
      get: async () => ({ success: true, bookings: [], counts: { total: 0, active: 0, completed: 0, cancelled: 0 } }),
    };

    await DashboardApp.loadDashboardData({ silent: true });
    await HistoryApp.loadHistory({ silent: true });

    assert.equal(setItemCalled, false, 'Dashboard and History must never write to localStorage booking stores');

    DashboardApp.cleanup();
    HistoryApp.cleanup();
  });

  test.it('14. Browser Back/Forward restoration: pagehide suspends, pageshow restores fetching/timers through registered event listeners, and hidden-tab pausing works', async () => {
    let getCallCount = 0;
    global.ApiClient = {
      get: async (url) => {
        getCallCount++;
        return {
          success: true,
          bookings: [
            {
              id: 'b-bfcache-1',
              status: 'active',
              endTime: new Date(Date.now() + 60000).toISOString(),
              slotCode: 'A-01',
              locationName: 'Test Park',
            },
          ],
          total: 1,
          counts: { total: 1, active: 1, completed: 0, cancelled: 0 },
        };
      },
    };

    // 1. Initialize Dashboard and verify initial state
    await DashboardApp.initDashboard();
    assert.equal(DashboardApp.isSuspended(), false);
    assert.equal(DashboardApp.isDisposed(), false);
    assert.equal(getCallCount, 1, 'Initial load should fetch once');

    // 2. Simulate beforeunload firing before pagehide (must NOT trigger permanent cleanup)
    global.window.dispatchEvent({ type: 'beforeunload' });
    assert.equal(DashboardApp.isDisposed(), false, 'beforeunload must not dispose dashboard');

    // 3. Dispatch pagehide({ persisted: true }) through registered window listener
    global.window.dispatchEvent({ type: 'pagehide', persisted: true });
    assert.equal(DashboardApp.isSuspended(), true, 'pagehide must suspend page');
    assert.equal(DashboardApp.isDisposed(), false, 'pagehide must not permanently dispose page');

    // While suspended, silent background refresh must NOT fetch
    const countBeforeHidden = getCallCount;
    await DashboardApp.loadDashboardData({ silent: true });
    assert.equal(getCallCount, countBeforeHidden, 'Suspended page must not fetch');

    // 4. Dispatch pageshow({ persisted: true }) through registered window listener (not direct call)
    global.window.dispatchEvent({ type: 'pageshow', persisted: true });
    assert.equal(DashboardApp.isSuspended(), false, 'pageshow must resume page');
    assert.equal(DashboardApp.isDisposed(), false);
    assert.ok(getCallCount > countBeforeHidden, 'pageshow restoration must refresh data');

    // 5. Verify hidden-tab pausing still works after restoration
    const countBeforeHideTab = getCallCount;
    global.document.hidden = true;
    global.document.dispatchEvent({ type: 'visibilitychange' });

    // Silent refresh while hidden does nothing
    await DashboardApp.loadDashboardData({ silent: true });
    assert.equal(getCallCount, countBeforeHideTab, 'Hidden tab must pause fetching');

    // Unhide tab and dispatch visibilitychange
    global.document.hidden = false;
    global.document.dispatchEvent({ type: 'visibilitychange' });
    assert.ok(getCallCount > countBeforeHideTab, 'Becoming visible must resume fetching');

    // 6. Avoid duplicate listeners/timers across repeated beforeunload -> pagehide -> pageshow cycles
    for (let i = 0; i < 3; i++) {
      global.window.dispatchEvent({ type: 'beforeunload' });
      assert.equal(DashboardApp.isDisposed(), false);
      global.window.dispatchEvent({ type: 'pagehide', persisted: true });
      assert.equal(DashboardApp.isSuspended(), true);
      global.window.dispatchEvent({ type: 'pageshow', persisted: true });
      assert.equal(DashboardApp.isSuspended(), false);
    }

    DashboardApp.cleanup();
    assert.equal(DashboardApp.isDisposed(), true, 'Explicit cleanup must mark page disposed');

    // 7. Verify same restoration behavior across beforeunload -> pagehide -> pageshow on HistoryApp
    let historyGetCount = 0;
    global.ApiClient = {
      get: async () => {
        historyGetCount++;
        return { success: true, bookings: [], total: 0, counts: { total: 0, active: 0, completed: 0, cancelled: 0 } };
      },
    };

    await HistoryApp.initHistoryPage();
    assert.equal(HistoryApp.isSuspended(), false);
    assert.equal(HistoryApp.isDisposed(), false);
    assert.equal(historyGetCount, 1);

    global.window.dispatchEvent({ type: 'beforeunload' });
    assert.equal(HistoryApp.isDisposed(), false, 'beforeunload must not dispose history');

    global.window.dispatchEvent({ type: 'pagehide', persisted: true });
    assert.equal(HistoryApp.isSuspended(), true);

    global.window.dispatchEvent({ type: 'pageshow', persisted: true });
    assert.equal(HistoryApp.isSuspended(), false);
    assert.ok(historyGetCount >= 2, 'History pageshow restoration must refresh data');

    for (let i = 0; i < 3; i++) {
      global.window.dispatchEvent({ type: 'beforeunload' });
      assert.equal(HistoryApp.isDisposed(), false);
      global.window.dispatchEvent({ type: 'pagehide', persisted: true });
      assert.equal(HistoryApp.isSuspended(), true);
      global.window.dispatchEvent({ type: 'pageshow', persisted: true });
      assert.equal(HistoryApp.isSuspended(), false);
    }

    HistoryApp.cleanup();
    assert.equal(HistoryApp.isDisposed(), true);
  });

  test.it('15. Refresh List is a refresh-only action: bubbled click sends GET only, never triggers PATCH or modal, and maintains confirmed cancellation', async () => {
    let patchCount = 0;
    let getCount = 0;

    const mockBooking = {
      id: 'b-cancel-refresh-test-42',
      locationName: 'Central Plaza',
      slotCode: 'C-42',
      vehicle: { registrationNumber: 'DL01TEST42', type: 'car' },
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      durationHours: 1,
      totalPaise: 5000,
      status: 'active',
    };

    global.ApiClient = {
      get: async (url) => {
        getCount++;
        return {
          success: true,
          bookings: [mockBooking],
          counts: { total: 1, active: 1, completed: 0, cancelled: 0 },
        };
      },
    };

    await DashboardApp.initDashboard();
    assert.equal(getCount, 1);

    // List now has the card with .btn-cancel
    const listEl = currentDoc.getElementById('active-bookings-list');
    const cancelBtn = listEl.querySelector('.btn-cancel');
    assert.ok(cancelBtn, 'Cancel button must exist on active booking card');
    assert.equal(cancelBtn.dataset.bookingId, 'b-cancel-refresh-test-42');

    // Make cancellation PATCH succeed and subsequent GET fail
    global.ApiClient = {
      patch: async (url) => {
        patchCount++;
        return {
          success: true,
          booking: { id: 'b-cancel-refresh-test-42', status: 'cancelled' },
          serverTime: new Date().toISOString(),
        };
      },
      get: async (url) => {
        getCount++;
        throw new Error('Simulated network error during post-cancellation list refresh');
      },
    };

    // Trigger cancellation
    await DashboardApp.handleCancelBooking('b-cancel-refresh-test-42', 'C-42', 'Central Plaza', cancelBtn);

    // Verify cancellation outcome confirmed, but refresh failed
    assert.equal(patchCount, 1, 'Cancellation PATCH must have been called exactly once');
    assert.equal(getCount, 2, 'Subsequent list refresh GET was attempted and failed');

    // The button must now be a refresh-only control
    assert.equal(cancelBtn.classList.contains('btn-cancel'), false, 'Must not retain .btn-cancel');
    assert.equal(cancelBtn.classList.contains('btn-refresh-card'), true, 'Must have .btn-refresh-card');
    assert.equal(cancelBtn.dataset.action, 'refresh', 'Must have data-action="refresh"');
    assert.equal(cancelBtn.dataset.bookingId, undefined, 'Must not retain booking ID');
    assert.equal(cancelBtn.textContent, 'Refresh List');

    // Configure ApiClient for subsequent clicks:
    // If a PATCH is attempted, it throws an error. GET succeeds.
    global.ApiClient = {
      patch: async () => {
        patchCount++;
        throw new Error('FAIL: Unexpected second PATCH request sent!');
      },
      get: async (url) => {
        getCount++;
        return {
          success: true,
          bookings: [],
          counts: { total: 1, active: 0, completed: 0, cancelled: 1 },
        };
      },
    };

    // Click "Refresh List" using normal event bubbling
    cancelBtn.dispatchEvent({ type: 'click', bubbles: true });

    // Allow async event propagation and handler completion
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert the total PATCH count remains exactly one!
    assert.equal(patchCount, 1, 'Total PATCH count remains exactly one after clicking Refresh List with normal bubbling');
    assert.ok(getCount >= 3, 'Clicking Refresh List must send a GET request');

    // Test that pending/confirmed state applies to card when polling re-renders
    DashboardApp.renderActiveBookings([mockBooking], 1);
    const reRenderedBtn = listEl.querySelector('.btn-refresh-card');
    assert.ok(reRenderedBtn, 'Re-rendered card must retain refresh-only button via confirmedCancellations');
    assert.equal(reRenderedBtn.classList.contains('btn-cancel'), false);

    // Bubbling click on the re-rendered button also sends GET only
    reRenderedBtn.dispatchEvent({ type: 'click', bubbles: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(patchCount, 1, 'Total PATCH count remains exactly one after clicking re-rendered button');

    DashboardApp.cleanup();

    // Also test history.js page-boundary refetch rethrow:
    // When cancellation reduces records so currentPage > maxPage,
    // page-boundary refetch passes rethrow so failures still reach the cancellation recovery handler
    let histPatchCount = 0;
    let histGetCount = 0;

    await HistoryApp.initHistoryPage();
    HistoryApp.setCurrentPage(2);

    const histCancelBtn = createMockElement('button');
    histCancelBtn.classList.add('btn-cancel');
    histCancelBtn.dataset.bookingId = 'b-hist-1';
    histCancelBtn.textContent = 'Cancel';

    global.ApiClient = {
      patch: async () => {
        histPatchCount++;
        return {
          success: true,
          booking: { id: 'b-hist-1', status: 'cancelled' },
          serverTime: new Date().toISOString(),
        };
      },
      get: async () => {
        histGetCount++;
        // First get: returns total=5 (maxPage=1, triggering currentPage > maxPage branch)
        // Second get (refetch for page 1): throws error
        if (histGetCount === 1) {
          return { success: true, total: 5, limit: 10, bookings: [], counts: {} };
        }
        throw new Error('Refetch failed on boundary page');
      },
    };

    await HistoryApp.handleCancelBooking('b-hist-1', 'D-01', 'Facility D', histCancelBtn);

    assert.equal(histPatchCount, 1);
    assert.equal(histCancelBtn.textContent, 'Refresh List');
    assert.equal(histCancelBtn.classList.contains('btn-refresh-card'), true);
    assert.equal(histCancelBtn.classList.contains('btn-cancel'), false);

    HistoryApp.cleanup();
  });

  test('16. Phase D UI Invariants — Modern Dashboard, History, Login, and Register UI', async (t) => {
    const fs = require('node:fs');
    const path = require('node:path');

    const dashboardHtml = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
    const historyHtml = fs.readFileSync(path.join(__dirname, '../public/history.html'), 'utf8');
    const loginHtml = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
    const registerHtml = fs.readFileSync(path.join(__dirname, '../public/register.html'), 'utf8');

    const dashboardJs = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
    const historyJs = fs.readFileSync(path.join(__dirname, '../public/js/history.js'), 'utf8');
    const loginJs = fs.readFileSync(path.join(__dirname, '../public/js/login.js'), 'utf8');
    const registerJs = fs.readFileSync(path.join(__dirname, '../public/js/register.js'), 'utf8');

    const dashboardCss = fs.readFileSync(path.join(__dirname, '../public/css/dashboard.css'), 'utf8');
    const historyCss = fs.readFileSync(path.join(__dirname, '../public/css/history.css'), 'utf8');
    const authCss = fs.readFileSync(path.join(__dirname, '../public/css/auth.css'), 'utf8');

    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

    await t.test('16.1 Zero emojis remain in Dashboard, History, Login, Register HTML and JS files', () => {
      assert.strictEqual(dashboardHtml.match(emojiRegex), null, 'dashboard.html must not contain emojis');
      assert.strictEqual(historyHtml.match(emojiRegex), null, 'history.html must not contain emojis');
      assert.strictEqual(loginHtml.match(emojiRegex), null, 'login.html must not contain emojis');
      assert.strictEqual(registerHtml.match(emojiRegex), null, 'register.html must not contain emojis');
      assert.strictEqual(dashboardJs.match(emojiRegex), null, 'dashboard.js must not contain emojis');
      assert.strictEqual(historyJs.match(emojiRegex), null, 'history.js must not contain emojis');
      assert.strictEqual(loginJs.match(emojiRegex), null, 'login.js must not contain emojis');
      assert.strictEqual(registerJs.match(emojiRegex), null, 'register.js must not contain emojis');
    });

    await t.test('16.2 Decorative inline SVGs use aria-hidden="true" across Dashboard and History', () => {
      const dashSvgs = dashboardHtml.match(/<svg[^>]*>/g) || [];
      assert.ok(dashSvgs.length > 0, 'dashboard.html contains SVGs');
      for (const svg of dashSvgs) {
        assert.ok(svg.includes('aria-hidden="true"'), `dashboard.html SVG must have aria-hidden="true": ${svg}`);
      }

      const histSvgs = historyHtml.match(/<svg[^>]*>/g) || [];
      assert.ok(histSvgs.length > 0, 'history.html contains SVGs');
      for (const svg of histSvgs) {
        assert.ok(svg.includes('aria-hidden="true"'), `history.html SVG must have aria-hidden="true": ${svg}`);
      }
    });

    await t.test('16.3 Critical DOM IDs and elements remain intact across all 4 pages', () => {
      const requiredDashIds = [
        'welcome-heading', 'welcome-name', 'welcome-meta', 'welcome-book-btn',
        'stat-total-bookings', 'stat-active-bookings', 'stat-completed-bookings', 'stat-cancelled-bookings',
        'active-bookings-heading', 'active-bookings-count', 'active-bookings-list',
        'dashboard-loading', 'dashboard-error', 'dashboard-error-msg', 'btn-retry-dashboard',
        'no-bookings-msg', 'dashboard-preview-notice', 'dashboard-preview-text', 'dashboard-preview-link',
        'vehicles-heading', 'vehicles-count', 'btn-add-vehicle',
        'vehicle-modal', 'vehicle-modal-title', 'btn-close-vehicle-modal',
        'vehicle-form', 'vehicle-edit-id', 'vehicle-input-reg', 'vehicle-reg-error',
        'vehicle-input-type', 'vehicle-type-error', 'vehicle-input-label', 'vehicle-label-error',
        'vehicle-form-error-banner', 'btn-cancel-vehicle-modal', 'btn-save-vehicle',
        'vehicles-list', 'vehicles-loading', 'vehicles-error', 'vehicles-error-msg',
        'btn-retry-vehicles', 'no-vehicles-msg', 'btn-add-vehicle-empty',
        'quick-actions-heading', 'action-book', 'action-history',
        'header-user-name', 'btn-logout', 'nav-admin-link',
      ];
      for (const id of requiredDashIds) {
        assert.ok(dashboardHtml.includes(`id="${id}"`), `dashboard.html must keep id="${id}"`);
      }

      const requiredHistIds = [
        'header-user-name', 'btn-logout', 'main-content',
        'stat-total', 'stat-active', 'stat-completed', 'stat-cancelled',
        'search-input', 'sort-select',
        'tab-all', 'tab-count-all', 'tab-active', 'tab-count-active',
        'tab-completed', 'tab-count-completed', 'tab-cancelled', 'tab-count-cancelled',
        'history-list-heading', 'results-count', 'history-list',
        'history-loading', 'history-error', 'history-error-msg', 'btn-retry-history',
        'history-empty-state', 'history-pagination', 'history-prev-btn', 'history-page-info', 'history-next-btn',
        'nav-admin-link',
      ];
      for (const id of requiredHistIds) {
        assert.ok(historyHtml.includes(`id="${id}"`), `history.html must keep id="${id}"`);
      }

      const requiredLoginIds = ['login-heading', 'eval1-notice', 'login-form', 'email', 'password', 'login-error'];
      for (const id of requiredLoginIds) {
        assert.ok(loginHtml.includes(`id="${id}"`), `login.html must keep id="${id}"`);
      }

      const requiredRegisterIds = ['register-heading', 'eval1-notice', 'name', 'email', 'phone', 'password', 'confirm-password'];
      for (const id of requiredRegisterIds) {
        assert.ok(registerHtml.includes(`id="${id}"`), `register.html must keep id="${id}"`);
      }
    });

    await t.test('16.4 Script dependency load order is strictly preserved on login and register', () => {
      const loginScripts = [
        'js/storage.js',
        'js/utils.js',
        'js/api.js',
        'js/validation.js',
        'js/auth.js',
        'js/login.js',
      ];
      let lastLoginIdx = -1;
      for (const script of loginScripts) {
        const idx = loginHtml.indexOf(script);
        assert.ok(idx !== -1, `login.html must load ${script}`);
        assert.ok(idx > lastLoginIdx, `login.html script load order violated for ${script}`);
        lastLoginIdx = idx;
      }

      const regScripts = [
        'js/storage.js',
        'js/utils.js',
        'js/api.js',
        'js/validation.js',
        'js/auth.js',
        'js/register.js',
      ];
      let lastRegIdx = -1;
      for (const script of regScripts) {
        const idx = registerHtml.indexOf(script);
        assert.ok(idx !== -1, `register.html must load ${script}`);
        assert.ok(idx > lastRegIdx, `register.html script load order violated for ${script}`);
        lastRegIdx = idx;
      }
    });

    await t.test('16.5 Modern SaaS CSS tokens and responsive rules defined in dashboard, history, auth', () => {
      for (const css of [dashboardCss, historyCss, authCss]) {
        assert.ok(css.includes('--color-bg-base'), 'defines --color-bg-base');
        assert.ok(css.includes('--color-primary'), 'defines --color-primary');
        assert.ok(css.includes(':focus-visible'), 'defines focus-visible styles');
        assert.ok(css.includes('prefers-reduced-motion'), 'defines reduced motion query');
      }
    });

    await t.test('16.6 Protected Dashboard and History flash prevention gates', () => {
      // Protected dashboard and history start hidden in HTML source
      assert.ok(dashboardHtml.includes('id="dashboard-initial-loading"'), 'dashboard.html must have initial loading gate');
      assert.ok(dashboardHtml.includes('class="auth-loading-gate"'), 'dashboard.html initial loading gate has auth-loading-gate class');
      assert.ok(dashboardHtml.includes('<main id="main-content" class="hidden">'), 'dashboard.html main-content starts hidden to prevent flash');

      assert.ok(historyHtml.includes('id="history-initial-loading"'), 'history.html must have initial loading gate');
      assert.ok(historyHtml.includes('class="auth-loading-gate"'), 'history.html initial loading gate has auth-loading-gate class');
      assert.ok(historyHtml.includes('<main id="main-content" class="hidden">'), 'history.html main-content starts hidden to prevent flash');

      // CSS strict hiding rules
      assert.ok(dashboardCss.includes('.auth-loading-gate.hidden') || dashboardCss.includes('.hidden'));
      assert.ok(historyCss.includes('.auth-loading-gate.hidden') || historyCss.includes('.hidden'));
    });

    await t.test('16.7 Authenticated Dashboard reveal on session verification', async () => {
      const initialLoadingEl = currentElements.get('dashboard-initial-loading');
      const mainContentEl = currentElements.get('main-content');
      initialLoadingEl.classList.remove('hidden');
      mainContentEl.classList.add('hidden');

      global.requireAuth = async () => ({ id: 'usr-123', name: 'Verified User', role: 'user' });
      global.ApiClient = {
        get: async () => ({
          success: true,
          total: 0,
          counts: { total: 0, active: 0, completed: 0, cancelled: 0 },
          bookings: [],
          vehicles: [],
        }),
      };

      await DashboardApp.initDashboard();
      assert.ok(initialLoadingEl.classList.contains('hidden'), 'Initial loading gate must be hidden once user is verified');
      assert.ok(!mainContentEl.classList.contains('hidden'), 'Main dashboard content must be revealed smoothly');
      DashboardApp.cleanup();
    });

    await t.test('16.8 Find Parking search wording and separated action controls', () => {
      const locationsHtml = fs.readFileSync(path.join(__dirname, '../public/locations.html'), 'utf8');
      const locationsCss = fs.readFileSync(path.join(__dirname, '../public/css/locations.css'), 'utf8');

      // Label & placeholder matches backend filter
      assert.ok(locationsHtml.includes('Search by location, city, or area'), 'locations.html must label search input by location, city, or area');
      assert.ok(!locationsHtml.includes('Search Facilities'), 'locations.html must not use ambiguous "Search Facilities" label');
      assert.ok(locationsHtml.includes('placeholder="Search by location, city, or area..."'));

      // Card actions separation & styling
      assert.ok(locationsCss.includes('.card-actions') || locationsCss.includes('.location-card-actions'));
      assert.ok(locationsCss.includes('gap:'));
      assert.ok(locationsCss.includes('min-height: 38px') || locationsCss.includes('min-height: 36px'));
      assert.ok(locationsCss.includes('.btn-secondary'));
      assert.ok(locationsCss.includes('.btn-primary'));

      // Responsive stacking in @media (max-width: 640px)
      assert.ok(locationsCss.includes('@media (max-width: 640px)'));
      assert.ok(locationsCss.includes('flex-direction: column'));
    });

    await t.test('16.9 Dashboard saved-vehicle action button sizing and hierarchy', () => {
      assert.ok(dashboardCss.includes('.btn-vehicle-action'), 'dashboard.css defines .btn-vehicle-action');
      assert.ok(dashboardCss.includes('min-height: 32px'), 'btn-vehicle-action has minimum 32px height');
      assert.ok(dashboardCss.includes('.btn-edit-vehicle'), 'dashboard.css defines .btn-edit-vehicle secondary action');
      assert.ok(dashboardCss.includes('.btn-delete-vehicle'), 'dashboard.css defines .btn-delete-vehicle danger action');

      // Verify dashboard.js assigns correct classes
      assert.ok(dashboardJs.includes('btn-vehicle-action'), 'dashboard.js assigns btn-vehicle-action class');
      assert.ok(dashboardJs.includes('btn-edit-vehicle'), 'dashboard.js assigns btn-edit-vehicle class');
      assert.ok(dashboardJs.includes('btn-delete-vehicle'), 'dashboard.js assigns btn-delete-vehicle class');
    });

    await t.test('16.10 History multi-page Next/Previous behavior and one-page disabled state', async () => {
      const pageInfoEl = currentElements.get('history-page-info');
      const prevBtn = currentElements.get('history-prev-btn');
      const nextBtn = currentElements.get('history-next-btn');

      let requestedPage = 1;
      global.ApiClient = {
        get: async (url) => {
          const match = url.match(/[?&]page=(\d+)/);
          requestedPage = match ? Number(match[1]) : 1;
          return {
            success: true,
            total: 25,
            page: requestedPage,
            limit: 10,
            counts: { total: 25, active: 2, completed: 20, cancelled: 3 },
            bookings: [
              {
                id: `bk-${requestedPage}-1`,
                locationName: 'Central Lot',
                slotCode: 'A-01',
                vehicle: { registrationNumber: 'KA01AA1111', type: 'car' },
                startTime: new Date().toISOString(),
                endTime: new Date(Date.now() + 3600000).toISOString(),
                durationHours: 1,
                totalPaise: 4000,
                status: 'completed',
              },
            ],
          };
        },
      };

      HistoryApp.setCurrentPage(1);
      await HistoryApp.loadHistory({ silent: false });

      // Page 1 of 3: Prev must be disabled, Next must be enabled
      assert.equal(HistoryApp.getCurrentPage(), 1);
      assert.equal(HistoryApp.getTotalPages(), 3);
      assert.ok(pageInfoEl.textContent.includes('Page 1 of 3'));
      assert.equal(prevBtn.disabled, true);
      assert.equal(prevBtn.getAttribute('aria-disabled'), 'true');
      assert.equal(nextBtn.disabled, false);
      assert.equal(nextBtn.getAttribute('aria-disabled'), 'false');

      // Click / call Next -> Page 2 of 3
      await HistoryApp.goToNextPage();
      assert.equal(HistoryApp.getCurrentPage(), 2);
      assert.equal(requestedPage, 2);
      assert.ok(pageInfoEl.textContent.includes('Page 2 of 3'));
      assert.equal(prevBtn.disabled, false);
      assert.equal(prevBtn.getAttribute('aria-disabled'), 'false');
      assert.equal(nextBtn.disabled, false);
      assert.equal(nextBtn.getAttribute('aria-disabled'), 'false');

      // Click / call Next -> Page 3 of 3 (last page boundary)
      await HistoryApp.goToNextPage();
      assert.equal(HistoryApp.getCurrentPage(), 3);
      assert.equal(requestedPage, 3);
      assert.ok(pageInfoEl.textContent.includes('Page 3 of 3'));
      assert.equal(prevBtn.disabled, false);
      assert.equal(prevBtn.getAttribute('aria-disabled'), 'false');
      assert.equal(nextBtn.disabled, true);
      assert.equal(nextBtn.getAttribute('aria-disabled'), 'true');

      // Click / call Previous -> Page 2 of 3
      await HistoryApp.goToPrevPage();
      assert.equal(HistoryApp.getCurrentPage(), 2);
      assert.equal(requestedPage, 2);
      assert.ok(pageInfoEl.textContent.includes('Page 2 of 3'));

      // Single-page test: total = 4 (< limit 10)
      global.ApiClient = {
        get: async () => ({
          success: true,
          total: 4,
          page: 1,
          limit: 10,
          counts: { total: 4, active: 1, completed: 3, cancelled: 0 },
          bookings: [
            {
              id: 'bk-single-1',
              locationName: 'Central Lot',
              slotCode: 'A-01',
              vehicle: { registrationNumber: 'KA01AA1111', type: 'car' },
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 3600000).toISOString(),
              durationHours: 1,
              totalPaise: 4000,
              status: 'completed',
            },
          ],
        }),
      };

      HistoryApp.setCurrentPage(1);
      await HistoryApp.loadHistory({ silent: false });
      assert.equal(HistoryApp.getTotalPages(), 1);
      assert.equal(pageInfoEl.textContent, 'Page 1 of 1');
      assert.equal(prevBtn.disabled, true);
      assert.equal(prevBtn.getAttribute('aria-disabled'), 'true');
      assert.equal(nextBtn.disabled, true);
      assert.equal(nextBtn.getAttribute('aria-disabled'), 'true');

      HistoryApp.cleanup();
    });
  });
});
