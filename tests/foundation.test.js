// tests/foundation.test.js — Stage 1 Foundation, Health, and Security Isolation Tests

'use strict';

process.env.NODE_ENV = 'test';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const app    = require('../server/app');

let server;
let baseUrl;

before((_, done) => {
  server = http.createServer(app);
  // Listen on ephemeral port 0
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

after((_, done) => {
  if (server) {
    server.close(done);
  } else {
    done();
  }
});

describe('1. API Liveness and Readiness Probes', () => {
  test('GET /api/health returns 200 with process liveness info', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.timestamp);
  });

  test('GET /api/ready returns 503 since database is not connected without server startup', async () => {
    const res = await fetch(`${baseUrl}/api/ready`);
    assert.equal(res.status, 503);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.connected, false);
    assert.ok(body.message.includes('not connected'));
  });

  test('GET /api/unknown-endpoint returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('Internal error response does not expose stack trace in JSON', async () => {
    const res = await fetch(`${baseUrl}/api/test-error`);
    assert.equal(res.status, 500);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.message, 'Simulated internal server failure');
    assert.equal(body.stack, undefined, 'Response must never contain stack trace');
  });
});

describe('2. Frontend Static Pages & Assets Delivery', () => {
  const pages = [
    { path: '/', expectedContent: 'ParkWise' },
    { path: '/index.html', expectedContent: 'ParkWise' },
    { path: '/login.html', expectedContent: 'Login' },
    { path: '/register.html', expectedContent: 'Register' },
    { path: '/dashboard.html', expectedContent: 'Dashboard' },
    { path: '/booking.html', expectedContent: 'Book' },
    { path: '/history.html', expectedContent: 'History' },
  ];

  for (const page of pages) {
    test(`GET ${page.path} returns 200 and renders HTML`, async () => {
      const res = await fetch(`${baseUrl}${page.path}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/html'));

      const text = await res.text();
      assert.ok(text.includes('<!DOCTYPE html>'));
      assert.ok(text.includes(page.expectedContent));
    });
  }

  test('GET /css/style.css returns 200 with CSS content', async () => {
    const res = await fetch(`${baseUrl}/css/style.css`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/css'));
    const css = await res.text();
    assert.ok(css.includes('--color-primary'));
  });

  test('GET /js/index.js returns 200 with JavaScript content', async () => {
    const res = await fetch(`${baseUrl}/js/index.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('javascript'));
  });

  test('GET /assets/images/hero-parking.svg returns 200 with SVG image', async () => {
    const res = await fetch(`${baseUrl}/assets/images/hero-parking.svg`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('image/svg'));
  });
});

describe('3. Legacy Data Route', () => {
  test('GET /data/parking.json explicitly serves the 60-slot seed file', async () => {
    const res = await fetch(`${baseUrl}/data/parking.json`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.meta.lotName, 'Smart Parking Complex');
    assert.equal(data.meta.totalSlots, 60);
    assert.equal(data.slots.length, 60);
  });
});

describe('4. Security & Path Traversal Isolation Tests', () => {
  const privatePaths = [
    '/server/app.js',
    '/%73erver/app.js',
    '/server%2Fapp.js',
    '/.env',
    '/.env.example',
    '/.gitignore',
    '/package.json',
    '/docs/eval2-plan.md',
    '/data/other.json',
    '/tests/foundation.test.js',
  ];

  for (const privatePath of privatePaths) {
    test(`GET ${privatePath} must NOT expose private server/config files (returns 404)`, async () => {
      const res = await fetch(`${baseUrl}${privatePath}`);
      // Express static strictly bounds to public/ so anything outside is 404
      assert.equal(res.status, 404);
    });
  }

  test('Response includes Helmet security headers and Content-Security-Policy', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.ok(res.headers.get('content-security-policy'), 'CSP header is set');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('5. Landing Page (index.html) Header Auth & Script Order', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const indexPath = path.resolve(__dirname, '../public/index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');

  function createTestElement(tagName = 'div', id = '') {
    const listeners = new Map();
    const children = [];
    let _textContent = '';
    const attributes = {};
    const classList = {
      _classes: new Set(),
      add: (c) => classList._classes.add(c),
      remove: (c) => classList._classes.delete(c),
      contains: (c) => classList._classes.has(c),
    };

    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className: '',
      children,
      parentElement: null,
      attributes,
      classList,
      get textContent() {
        return _textContent;
      },
      set textContent(val) {
        _textContent = val !== null && val !== undefined ? String(val) : '';
      },
      get href() {
        return attributes.href || '';
      },
      set href(val) {
        attributes.href = String(val);
      },
      setAttribute: (k, v) => {
        attributes[k] = String(v);
      },
      getAttribute: (k) => attributes[k] ?? null,
      removeAttribute: (k) => {
        delete attributes[k];
        if (k === 'href') delete el.href;
      },
      appendChild: (child) => {
        child.parentElement = el;
        children.push(child);
        return child;
      },
      set innerHTML(val) {
        if (val === '') {
          children.length = 0;
          _textContent = '';
        }
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
    };
    return el;
  }

  test('public/index.html loads scripts in exact dependency order: storage -> api -> auth -> index defer', () => {
    const storageIdx = indexHtml.indexOf('<script src="js/storage.js"></script>');
    const apiIdx = indexHtml.indexOf('<script src="js/api.js"></script>');
    const authIdx = indexHtml.indexOf('<script src="js/auth.js"></script>');
    const indexIdx = indexHtml.indexOf('<script src="js/index.js" defer></script>');

    assert.ok(storageIdx !== -1, 'storage.js script tag is present');
    assert.ok(apiIdx !== -1, 'api.js script tag is present');
    assert.ok(authIdx !== -1, 'auth.js script tag is present');
    assert.ok(indexIdx !== -1, 'index.js script tag is present with defer');

    assert.ok(storageIdx < apiIdx, 'storage.js must load before api.js');
    assert.ok(apiIdx < authIdx, 'api.js must load before auth.js');
    assert.ok(authIdx < indexIdx, 'auth.js must load before index.js');
  });

  test('public/index.html header contains required navigation links and dynamic #header-auth container', () => {
    assert.ok(indexHtml.includes('id="header-auth"'), '#header-auth container is present');
    assert.ok(indexHtml.includes('id="nav-admin-link"'), '#nav-admin-link is present');
    assert.ok(indexHtml.includes('class="hidden"'), '#nav-admin-link has hidden class');
    assert.ok(indexHtml.includes('href="dashboard.html"'), 'Dashboard link is present');
    assert.ok(indexHtml.includes('href="locations.html"'), 'Find Parking link is present');
    assert.ok(indexHtml.includes('href="#features"'), 'Features link is present');
    assert.ok(indexHtml.includes('href="#how-it-works"'), 'How It Works link is present');
    assert.ok(indexHtml.includes('href="#statistics"'), 'Statistics link is present');
  });

  test('initHeaderAuth renders guest state with Login and Register links when unauthenticated', async () => {
    const { initHeaderAuth } = require('../public/js/index');

    const authContainer = createTestElement('div', 'header-auth');
    const adminNav = createTestElement('li', 'nav-admin-link');
    adminNav.classList.add('hidden');

    global.document = {
      getElementById: (id) => {
        if (id === 'header-auth') return authContainer;
        if (id === 'nav-admin-link') return adminNav;
        return null;
      },
      createElement: (tag) => createTestElement(tag),
    };

    global.SessionStore = {
      isLoggedIn: () => false,
      get: () => null,
      getName: () => null,
      clear: () => {},
    };

    await initHeaderAuth();

    assert.equal(authContainer.children.length, 2);
    assert.equal(authContainer.children[0].tagName, 'A');
    assert.equal(authContainer.children[0].getAttribute('href'), 'login.html');
    assert.equal(authContainer.children[0].textContent, 'Login');
    assert.equal(authContainer.children[1].tagName, 'A');
    assert.equal(authContainer.children[1].getAttribute('href'), 'register.html');
    assert.equal(authContainer.children[1].textContent, 'Register');
    assert.ok(adminNav.classList.contains('hidden'));
  });

  test('initHeaderAuth renders user badge and Logout button when authenticated as regular user', async () => {
    const { initHeaderAuth } = require('../public/js/index');

    const authContainer = createTestElement('div', 'header-auth');
    const adminNav = createTestElement('li', 'nav-admin-link');
    adminNav.classList.add('hidden');

    let sessionCleared = false;
    global.document = {
      getElementById: (id) => {
        if (id === 'header-auth') return authContainer;
        if (id === 'nav-admin-link') return adminNav;
        return null;
      },
      createElement: (tag) => createTestElement(tag),
    };

    global.SessionStore = {
      isLoggedIn: () => true,
      get: () => ({ user: { name: 'Priya Sharma', role: 'user' } }),
      getName: () => 'Priya Sharma',
      clear: () => { sessionCleared = true; },
    };

    global.verifySession = async () => ({
      authenticated: true,
      user: { name: 'Priya Sharma', role: 'user' },
    });

    await initHeaderAuth();

    assert.equal(authContainer.children.length, 2);
    const badge = authContainer.children[0];
    const logoutBtn = authContainer.children[1];

    assert.equal(badge.className, 'header-user-badge');
    assert.equal(badge.textContent, 'Priya Sharma');
    assert.equal(logoutBtn.tagName, 'BUTTON');
    assert.equal(logoutBtn.textContent, 'Logout');
    assert.ok(adminNav.classList.contains('hidden'), 'Admin Console remains hidden for regular user');

    // Test logout click
    logoutBtn.dispatchEvent({ type: 'click' });
    assert.ok(sessionCleared, 'Session was cleared on logout click');
  });

  test('initHeaderAuth reveals Admin Console only for verified admin users', async () => {
    const { initHeaderAuth } = require('../public/js/index');

    const authContainer = createTestElement('div', 'header-auth');
    const adminNav = createTestElement('li', 'nav-admin-link');
    adminNav.classList.add('hidden');
    adminNav.setAttribute('hidden', '');

    global.document = {
      getElementById: (id) => {
        if (id === 'header-auth') return authContainer;
        if (id === 'nav-admin-link') return adminNav;
        return null;
      },
      createElement: (tag) => createTestElement(tag),
    };

    global.SessionStore = {
      isLoggedIn: () => true,
      get: () => ({ user: { name: 'Admin User', role: 'admin' } }),
      getName: () => 'Admin User',
      clear: () => {},
    };

    global.verifySession = async () => ({
      authenticated: true,
      user: { name: 'Admin User', role: 'admin' },
    });

    global.updateAdminNavigation = (user) => {
      if (user?.role === 'admin') {
        adminNav.classList.remove('hidden');
        adminNav.removeAttribute('hidden');
      }
    };

    await initHeaderAuth();

    assert.ok(!adminNav.classList.contains('hidden'), 'hidden class removed for admin');
    assert.equal(adminNav.getAttribute('hidden'), null, 'hidden attribute removed for admin');
  });

  test('initHeaderAuth reverts to guest state on 401 unauthorized without redirecting', async () => {
    const { initHeaderAuth } = require('../public/js/index');

    const authContainer = createTestElement('div', 'header-auth');
    const adminNav = createTestElement('li', 'nav-admin-link');

    let sessionCleared = false;
    let redirected = false;

    global.document = {
      getElementById: (id) => {
        if (id === 'header-auth') return authContainer;
        if (id === 'nav-admin-link') return adminNav;
        return null;
      },
      createElement: (tag) => createTestElement(tag),
    };

    global.SessionStore = {
      isLoggedIn: () => true,
      get: () => ({ user: { name: 'Expired User', role: 'user' } }),
      getName: () => 'Expired User',
      clear: () => { sessionCleared = true; },
    };

    global.verifySession = async () => ({
      authenticated: false,
      reason: 'UNAUTHORIZED',
    });

    global.window = {
      location: {
        href: 'http://localhost:5000/index.html',
        replace: () => { redirected = true; },
        assign: () => { redirected = true; },
      },
    };

    await initHeaderAuth();

    assert.ok(sessionCleared, 'SessionStore was cleared on 401');
    assert.equal(redirected, false, 'Guest is never redirected away from landing page');
    assert.equal(authContainer.children.length, 2);
    assert.equal(authContainer.children[0].textContent, 'Login');
    assert.equal(authContainer.children[1].textContent, 'Register');
    assert.ok(adminNav.classList.contains('hidden'));
  });

  test('initHeaderAuth strictly prevents HTML injection via user name (XSS prevention)', async () => {
    const { initHeaderAuth } = require('../public/js/index');

    const authContainer = createTestElement('div', 'header-auth');
    const adminNav = createTestElement('li', 'nav-admin-link');

    global.document = {
      getElementById: (id) => {
        if (id === 'header-auth') return authContainer;
        if (id === 'nav-admin-link') return adminNav;
        return null;
      },
      createElement: (tag) => createTestElement(tag),
    };

    const maliciousName = '<img src=x onerror=alert(1)>Malicious';
    global.SessionStore = {
      isLoggedIn: () => true,
      get: () => ({ user: { name: maliciousName, role: 'user' } }),
      getName: () => maliciousName,
      clear: () => {},
    };

    global.verifySession = async () => ({
      authenticated: true,
      user: { name: maliciousName, role: 'user' },
    });

    await initHeaderAuth();

    const badge = authContainer.children[0];
    assert.equal(badge.textContent, maliciousName);
    assert.equal(badge.children.length, 0, 'No HTML child nodes created inside user badge');
  });
});

test.describe('6. Phase B UI Invariants — Home Page & Find Parking Modern Polish', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const locationsHtml = fs.readFileSync(path.join(__dirname, '../public/locations.html'), 'utf8');
  const indexJs = fs.readFileSync(path.join(__dirname, '../public/js/index.js'), 'utf8');
  const locationsJs = fs.readFileSync(path.join(__dirname, '../public/js/locations.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  const locationsCss = fs.readFileSync(path.join(__dirname, '../public/css/locations.css'), 'utf8');

  // Standard unicode emoji regex (pictographs, emoticons, symbols)
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u;

  test('no emojis remain in Home/Find Parking HTML or their page-specific JS', () => {
    assert.strictEqual(indexHtml.match(emojiRegex), null, 'index.html must not contain emoji icons');
    assert.strictEqual(locationsHtml.match(emojiRegex), null, 'locations.html must not contain emoji icons');
    assert.strictEqual(indexJs.match(emojiRegex), null, 'index.js must not contain emoji icons');
    assert.strictEqual(locationsJs.match(emojiRegex), null, 'locations.js must not contain emoji icons');
  });

  test('SVG icons in Home and Find Parking have aria-hidden="true" where decorative', () => {
    // Check that SVG elements in index.html and locations.html include aria-hidden="true"
    const indexSvgMatches = indexHtml.match(/<svg[^>]*>/g) || [];
    assert.ok(indexSvgMatches.length > 0, 'index.html contains SVG icons');
    for (const svg of indexSvgMatches) {
      assert.ok(svg.includes('aria-hidden="true"'), `index.html SVG must have aria-hidden="true": ${svg}`);
    }

    const locSvgMatches = locationsHtml.match(/<svg[^>]*>/g) || [];
    assert.ok(locSvgMatches.length > 0, 'locations.html contains SVG icons');
    for (const svg of locSvgMatches) {
      assert.ok(svg.includes('aria-hidden="true"'), `locations.html SVG must have aria-hidden="true": ${svg}`);
    }
  });

  test('Find Parking loads required auth and Leaflet dependencies in strict order', () => {
    const storageIdx = locationsHtml.indexOf('<script src="js/storage.js"></script>');
    const apiIdx = locationsHtml.indexOf('<script src="js/api.js"></script>');
    const utilsIdx = locationsHtml.indexOf('<script src="js/utils.js"></script>');
    const authIdx = locationsHtml.indexOf('<script src="js/auth.js"></script>');
    const leafletIdx = locationsHtml.indexOf('<script src="vendor/leaflet/leaflet.js"></script>');
    const locationsIdx = locationsHtml.indexOf('<script src="js/locations.js"></script>');

    assert.ok(storageIdx !== -1, 'storage.js is loaded');
    assert.ok(apiIdx !== -1, 'api.js is loaded');
    assert.ok(utilsIdx !== -1, 'utils.js is loaded');
    assert.ok(authIdx !== -1, 'auth.js is loaded');
    assert.ok(leafletIdx !== -1, 'leaflet.js is loaded');
    assert.ok(locationsIdx !== -1, 'locations.js is loaded');

    assert.ok(storageIdx < apiIdx, 'storage.js before api.js');
    assert.ok(apiIdx < utilsIdx, 'api.js before utils.js');
    assert.ok(utilsIdx < authIdx, 'utils.js before auth.js');
    assert.ok(authIdx < leafletIdx, 'auth.js before leaflet.js');
    assert.ok(leafletIdx < locationsIdx, 'leaflet.js before locations.js');
  });

  test('all existing critical DOM IDs remain present in index.html and locations.html', () => {
    const requiredIndexIds = [
      'main-content',
      'hero',
      'hero-heading',
      'features',
      'features-heading',
      'how-it-works',
      'how-it-works-heading',
      'statistics',
      'statistics-heading',
      'stat-total-slots',
      'stat-available',
      'stat-occupied',
      'stat-bookings',
      'cta',
      'cta-heading',
      'header-auth',
      'nav-admin-link',
    ];

    for (const id of requiredIndexIds) {
      assert.ok(indexHtml.includes(`id="${id}"`), `index.html must keep id="${id}"`);
    }

    const requiredLocationIds = [
      'main-content',
      'header-auth',
      'nav-dashboard-link',
      'nav-admin-link',
      'filters-form',
      'search-input',
      'filter-city',
      'filter-area',
      'btn-clear-filters',
      'results-count',
      'loading-state',
      'error-state',
      'error-title',
      'error-message',
      'btn-retry',
      'empty-state',
      'btn-empty-clear',
      'locations-list',
      'pagination',
      'btn-prev-page',
      'page-indicator',
      'btn-next-page',
      'map-pin-count',
      'map-tile-notice',
      'map',
      'map-fallback',
      'map-empty',
      'location-detail-modal',
      'modal-location-name',
      'modal-location-category',
      'modal-location-status',
      'btn-close-modal',
      'modal-error',
      'modal-error-text',
      'modal-content-details',
      'modal-location-address',
      'modal-location-city-area',
      'modal-location-coords',
      'modal-phone-container',
      'modal-location-phone',
      'modal-available-slots',
      'modal-total-slots',
      'modal-facilities-container',
      'modal-facilities-list',
      'modal-booking-section',
      'modal-booking-desc',
      'modal-closed-warning',
      'btn-modal-view-slots',
    ];

    for (const id of requiredLocationIds) {
      assert.ok(locationsHtml.includes(`id="${id}"`), `locations.html must keep id="${id}"`);
    }
  });

  test('style.css and locations.css define modern SaaS layout, button system and responsive rules', () => {
    const requiredCssPatterns = [
      '.site-header',
      '.header-inner',
      '.header-user-badge',
      '.btn-primary',
      '.btn-outline',
      ':focus-visible',
    ];

    for (const pat of requiredCssPatterns) {
      assert.ok(styleCss.includes(pat), `style.css must define ${pat}`);
      assert.ok(locationsCss.includes(pat), `locations.css must define ${pat}`);
    }
  });
});

