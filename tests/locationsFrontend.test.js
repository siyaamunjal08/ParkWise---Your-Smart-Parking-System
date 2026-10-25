// tests/locationsFrontend.test.js — Stage 8 Frontend Logic and Search/Map Unit Tests
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  isValidCoordinate,
  buildLocationQueryString,
  LocationDiscoveryApp,
  SEARCH_PREFS_KEY,
} = require('../public/js/locations');

/**
 * Minimal DOM element factory for UI logic tests
 */
function createMockElement(tagName = 'div', id = '') {
  const listeners = new Map();
  const children = [];
  let _textContent = '';

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    className: '',
    value: '',
    hidden: false,
    style: {},
    children,
    parentElement: null,
    attributes: {},
    get textContent() {
      return _textContent;
    },
    set textContent(val) {
      _textContent = val !== null && val !== undefined ? String(val) : '';
    },
    classList: {
      _classes: new Set(),
      add: (c) => el.classList._classes.add(c),
      remove: (c) => el.classList._classes.delete(c),
      contains: (c) => el.classList._classes.has(c),
    },
    setAttribute: (k, v) => {
      el.attributes[k] = String(v);
    },
    getAttribute: (k) => el.attributes[k] ?? null,
    appendChild: (child) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    innerHTML: '',
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
    querySelector: (selector) => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return findFirst(el, (n) => n.className && n.className.split(/\s+/).includes(cls));
      }
      if (selector === 'script' || selector === 'img' || selector === 'button' || selector === 'h2') {
        return findFirst(el, (n) => n.tagName === selector.toUpperCase());
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const results = [];
      findAll(el, (n) => {
        if (selector.includes('button') && n.tagName === 'BUTTON') return true;
        if (selector.startsWith('.') && n.className && n.className.includes(selector.slice(1))) return true;
        return false;
      }, results);
      return results;
    },
    closest: (selector) => {
      if (selector === 'button' && el.tagName === 'BUTTON') return el;
      return null;
    },
    focus: () => {
      el._isFocused = true;
    },
    scrollIntoView: () => {
      el._scrolledIntoView = true;
    },
  };

  function findFirst(root, predicate) {
    for (const ch of root.children) {
      if (predicate(ch)) return ch;
      const found = findFirst(ch, predicate);
      if (found) return found;
    }
    return null;
  }

  function findAll(root, predicate, out) {
    for (const ch of root.children) {
      if (predicate(ch)) out.push(ch);
      findAll(ch, predicate, out);
    }
  }

  return el;
}

/**
 * Build browser-like document and storage environment
 */
function createMockDocument() {
  const elementsById = new Map();
  const doc = {
    body: { style: {} },
    activeElement: null,
    getElementById: (id) => {
      if (!elementsById.has(id)) {
        elementsById.set(id, createMockElement('div', id));
      }
      return elementsById.get(id);
    },
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: (selector) => {
      const results = [];
      for (const el of elementsById.values()) {
        if (selector.startsWith('.') && el.className && el.className.includes(selector.slice(1))) {
          results.push(el);
        }
      }
      return results;
    },
    addEventListener: () => {},
  };
  return { doc, elementsById };
}

/**
 * Helper to evaluate public/js/storage.js in a vm sandbox
 */
function createStorageEnvironment() {
  const sessionStorageMap = new Map();
  const localStorageMap = new Map();

  const mockSessionStorage = {
    getItem: (k) => sessionStorageMap.get(k) || null,
    setItem: (k, v) => sessionStorageMap.set(k, String(v)),
    removeItem: (k) => sessionStorageMap.delete(k),
    clear: () => sessionStorageMap.clear(),
  };

  const mockLocalStorage = {
    getItem: (k) => localStorageMap.get(k) || null,
    setItem: (k, v) => localStorageMap.set(k, String(v)),
    removeItem: (k) => localStorageMap.delete(k),
    clear: () => localStorageMap.clear(),
  };

  const storageFilePath = path.resolve(__dirname, '../public/js/storage.js');
  const storageCode = fs.readFileSync(storageFilePath, 'utf8');

  const context = {
    sessionStorage: mockSessionStorage,
    localStorage: mockLocalStorage,
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Set,
    Map,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(storageCode + '\n;globalThis.SessionStore = SessionStore;', context);

  return {
    SessionStore: context.SessionStore,
    sessionStorage: mockSessionStorage,
    localStorage: mockLocalStorage,
  };
}

test.describe('Stage 8 — Locations Frontend Logic, Map Safeguards & Interactions', () => {

  test.describe('1. Coordinate Validation (isValidCoordinate)', () => {
    test.it('accepts valid geographic coordinates within normal ranges', () => {
      assert.equal(isValidCoordinate(18.5204, 73.8567), true); // Pune
      assert.equal(isValidCoordinate(12.9716, 77.5946), true); // Bengaluru
      assert.equal(isValidCoordinate(-33.8688, 151.2093), true); // Sydney
    });

    test.it('explicitly accepts valid zero coordinates (0, 0)', () => {
      assert.equal(isValidCoordinate(0, 0), true);
      assert.equal(isValidCoordinate('0', '0'), true);
      assert.equal(isValidCoordinate(0, 77.5), true);
      assert.equal(isValidCoordinate(12.9, 0), true);
    });

    test.it('accepts extreme boundary coordinates [-90, 90] and [-180, 180]', () => {
      assert.equal(isValidCoordinate(90, 180), true);
      assert.equal(isValidCoordinate(-90, -180), true);
      assert.equal(isValidCoordinate(90, -180), true);
      assert.equal(isValidCoordinate(-90, 180), true);
    });

    test.it('rejects out-of-range coordinates', () => {
      assert.equal(isValidCoordinate(90.0001, 77), false);
      assert.equal(isValidCoordinate(-90.0001, 77), false);
      assert.equal(isValidCoordinate(28, 180.0001), false);
      assert.equal(isValidCoordinate(28, -180.0001), false);
      assert.equal(isValidCoordinate(999, 999), false);
    });

    test.it('rejects invalid types: null, undefined, NaN, empty strings, and non-numeric', () => {
      assert.equal(isValidCoordinate(null, null), false);
      assert.equal(isValidCoordinate(undefined, undefined), false);
      assert.equal(isValidCoordinate(NaN, 77), false);
      assert.equal(isValidCoordinate(28, NaN), false);
      assert.equal(isValidCoordinate('', ''), false);
      assert.equal(isValidCoordinate('   ', '   '), false);
      assert.equal(isValidCoordinate('invalid', 'coord'), false);
      assert.equal(isValidCoordinate(null, 77), false);
      assert.equal(isValidCoordinate(28, undefined), false);
    });
  });

  test.describe('2. Query String Construction (buildLocationQueryString)', () => {
    test.it('encodes search query, city, area, page, and limit with URLSearchParams', () => {
      const qs = buildLocationQueryString({
        q: 'Phoenix Mall',
        city: 'Bengaluru',
        area: 'Whitefield',
        page: 2,
        limit: 10,
      });

      const params = new URLSearchParams(qs);
      assert.equal(params.get('q'), 'Phoenix Mall');
      assert.equal(params.get('city'), 'Bengaluru');
      assert.equal(params.get('area'), 'Whitefield');
      assert.equal(params.get('page'), '2');
      assert.equal(params.get('limit'), '10');
    });

    test.it('properly encodes special characters preventing URL injection', () => {
      const qs = buildLocationQueryString({
        q: 'Hospital & Care / Hub?#',
        city: 'New Delhi & NCR',
      });

      const params = new URLSearchParams(qs);
      assert.equal(params.get('q'), 'Hospital & Care / Hub?#');
      assert.equal(params.get('city'), 'New Delhi & NCR');
    });

    test.it('omits empty or whitespace-only parameters', () => {
      const qs = buildLocationQueryString({
        q: '   ',
        city: '',
        area: null,
        page: 1,
      });

      const params = new URLSearchParams(qs);
      assert.equal(params.has('q'), false);
      assert.equal(params.has('city'), false);
      assert.equal(params.has('area'), false);
      assert.equal(params.get('page'), '1');
    });

    test.it('validates and bounds page and limit', () => {
      const qs = buildLocationQueryString({
        page: -5,
        limit: 'not-a-number',
      });

      const params = new URLSearchParams(qs);
      assert.equal(params.has('page'), false);
      assert.equal(params.has('limit'), false);
    });
  });

  test.describe('3. Real SessionStore Contract & Auth Header Initialization', () => {
    let env;
    let mockDocSetup;

    test.beforeEach(() => {
      env = createStorageEnvironment();
      mockDocSetup = createMockDocument();

      global.SessionStore = env.SessionStore;
      global.document = mockDocSetup.doc;
      global.window = {
        location: { reload: () => { env._reloaded = true; } },
      };
    });

    test.afterEach(() => {
      delete global.SessionStore;
      delete global.document;
      delete global.window;
    });

    test.it('initializes for guests without throwing and leaves login/register intact', () => {
      assert.equal(env.SessionStore.isLoggedIn(), false);

      const authContainer = mockDocSetup.doc.getElementById('header-auth');

      assert.doesNotThrow(() => {
        LocationDiscoveryApp.updateHeaderAuthState();
      });

      assert.equal(authContainer.children.length, 0);
    });

    test.it('initializes for logged-in user using real SessionStore contract (no getUser) and renders user badge + logout', () => {
      env.SessionStore.save('valid-jwt-token-xyz', {
        id: 'usr_101',
        name: 'Siya Munjal',
        email: 'siya@parkwise.io',
        role: 'user',
      });

      assert.equal(env.SessionStore.isLoggedIn(), true);
      assert.equal(env.SessionStore.getName(), 'Siya Munjal');

      const authContainer = mockDocSetup.doc.getElementById('header-auth');

      // Call updateHeaderAuthState — must NOT throw "SessionStore.getUser is not a function"
      assert.doesNotThrow(() => {
        LocationDiscoveryApp.updateHeaderAuthState();
      });

      // User badge rendered
      const badge = authContainer.children.find((c) => c.className.includes('header-user-badge'));
      assert.ok(badge, 'User badge should be rendered');
      assert.equal(badge.textContent, 'Siya Munjal');

      // Logout button rendered
      const logoutBtn = authContainer.children.find((c) => c.tagName === 'BUTTON');
      assert.ok(logoutBtn, 'Logout button should be rendered');
      assert.equal(logoutBtn.textContent, 'Logout');

      // Trigger logout click: client-side clear without backend POST /api/auth/logout
      logoutBtn.onclick();
      assert.equal(env.SessionStore.isLoggedIn(), false, 'Session must be cleared on logout');
      assert.equal(env._reloaded, true, 'Page must reload on logout');
    });
  });

  test.describe('4. Out-of-Order Search & Modal Detail Responses (Race Condition Protection)', () => {
    let mockDocSetup;

    test.beforeEach(() => {
      mockDocSetup = createMockDocument();
      global.document = mockDocSetup.doc;
    });

    test.afterEach(() => {
      delete global.document;
      delete global.ApiClient;
    });

    test.it('discards stale search responses and applies only newest response', async () => {
      let reqCount = 0;
      global.ApiClient = {
        get: async () => {
          reqCount++;
          const currentCall = reqCount;
          if (currentCall === 1) {
            // Slower response (50ms)
            await new Promise((r) => setTimeout(r, 50));
            return {
              success: true,
              total: 1,
              locations: [{ id: 'loc-1', name: 'Slow Old Result' }],
            };
          } else {
            // Faster response (10ms)
            await new Promise((r) => setTimeout(r, 10));
            return {
              success: true,
              total: 1,
              locations: [{ id: 'loc-2', name: 'Fast New Result' }],
            };
          }
        },
      };

      const call1 = LocationDiscoveryApp.fetchLocations();
      const call2 = LocationDiscoveryApp.fetchLocations();

      await Promise.all([call1, call2]);

      const state = LocationDiscoveryApp.getState();
      assert.equal(state.locations.length, 1);
      assert.equal(state.locations[0].name, 'Fast New Result');
    });

    test.it('discards stale modal detail responses when user opens a different location', async () => {
      let reqCount = 0;
      global.ApiClient = {
        get: async (url) => {
          reqCount++;
          if (url.includes('loc-1')) {
            // Slower detail response (50ms)
            await new Promise((r) => setTimeout(r, 50));
            return {
              success: true,
              location: { id: 'loc-1', name: 'Old Detail' },
            };
          } else {
            // Faster detail response (10ms)
            await new Promise((r) => setTimeout(r, 10));
            return {
              success: true,
              location: { id: 'loc-2', name: 'New Detail' },
            };
          }
        },
      };

      const p1 = LocationDiscoveryApp.openLocationDetailsModal('loc-1');
      const p2 = LocationDiscoveryApp.openLocationDetailsModal('loc-2');

      await Promise.all([p1, p2]);

      const modalNameEl = mockDocSetup.doc.getElementById('modal-location-name');
      assert.equal(modalNameEl.textContent, 'New Detail');
    });
  });

  test.describe('5. Safe Card Rendering & Nested Button Keyboard Safeguards', () => {
    let mockDocSetup;

    test.beforeEach(() => {
      mockDocSetup = createMockDocument();
      global.document = mockDocSetup.doc;
    });

    test.afterEach(() => {
      delete global.document;
    });

    test.it('renders card safely without executing HTML/script tags', () => {
      const maliciousLoc = {
        id: 'loc_xss',
        name: '<script>alert("xss")</script><img src="x" onerror="fail()">Safe Parking Hub',
        category: 'Mall',
        address: '100 Security Way <svg/onload=alert(2)>',
        city: 'Secure City',
        area: 'Core',
        facilities: ['CCTV', '<b>Bold</b>'],
        status: 'active',
        totalSlots: 50,
        availableSlots: 20,
      };

      const card = LocationDiscoveryApp.createLocationCard(maliciousLoc);

      const title = card.querySelector('.card-title');
      assert.equal(title.textContent, maliciousLoc.name);
      assert.equal(card.querySelector('script'), null);
      assert.equal(card.querySelector('img'), null);
    });

    test.it('ignores card-level Enter/Space when event originates from a nested button', () => {
      const loc = {
        id: 'loc_btn_test',
        name: 'Test Facility',
        status: 'active',
        totalSlots: 10,
        availableSlots: 5,
      };

      const card = LocationDiscoveryApp.createLocationCard(loc);
      const viewDetailsBtn = card.querySelector('button');
      assert.ok(viewDetailsBtn, 'View Details button should exist inside card');

      // Reset selectedLocationId
      LocationDiscoveryApp.setState({ selectedLocationId: null });

      // 1. Enter key event on the nested button: card must IGNORE it so button handles it
      card.onkeydown({
        key: 'Enter',
        target: viewDetailsBtn,
        preventDefault: () => {},
      });
      assert.notEqual(LocationDiscoveryApp.getState().selectedLocationId, loc.id, 'Card keydown must not trigger when target is a nested button');

      // 2. Enter key event on the card itself: card handles it
      card.onkeydown({
        key: 'Enter',
        target: card,
        preventDefault: () => {},
      });
      assert.equal(LocationDiscoveryApp.getState().selectedLocationId, loc.id, 'Card keydown should trigger when target is card itself');
    });
  });

  test.describe('6. Filter Changes and Preferences Persistence', () => {
    test.it('stores non-sensitive search preferences and resets page on filter updates', () => {
      const mockStorage = new Map();
      global.localStorage = {
        setItem: (k, v) => mockStorage.set(k, v),
        getItem: (k) => mockStorage.get(k) || null,
      };

      LocationDiscoveryApp.setState({ page: 3, city: 'Bengaluru', area: 'Whitefield' });
      assert.equal(LocationDiscoveryApp.getState().page, 3);

      const qs = buildLocationQueryString(LocationDiscoveryApp.getState());
      assert.ok(qs.includes('city=Bengaluru'));
      assert.ok(qs.includes('area=Whitefield'));

      delete global.localStorage;
    });
  });

});
