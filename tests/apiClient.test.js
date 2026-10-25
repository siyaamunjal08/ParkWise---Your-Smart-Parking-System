// tests/apiClient.test.js — Unit tests for ApiClient URL security and credential scoping
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiClient, ApiError, validateApiUrl } = require('../public/js/api');

test.describe('ApiClient Security & Destination Validation', () => {
  let originalWindow;
  let originalFetch;
  let originalSessionStore;
  let fetchCallCount;
  let lastFetchCall;

  test.beforeEach(() => {
    originalWindow = global.window;
    originalFetch = global.fetch;
    originalSessionStore = global.SessionStore;

    fetchCallCount = 0;
    lastFetchCall = null;

    // Simulate browser window location
    global.window = {
      location: {
        href: 'http://localhost:5000/dashboard.html',
        origin: 'http://localhost:5000',
      },
    };

    // Simulate active session with dummy JWT token
    global.SessionStore = {
      getToken: () => 'dummy-mock-jwt-token-12345',
    };

    // Mock fetch to track calls and prevent any network activity
    global.fetch = async (url, options) => {
      fetchCallCount++;
      lastFetchCall = { url, options };
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        json: async () => ({ success: true, data: 'mock-response' }),
        text: async () => JSON.stringify({ success: true, data: 'mock-response' }),
      };
    };
  });

  test.afterEach(() => {
    global.window = originalWindow;
    global.fetch = originalFetch;
    global.SessionStore = originalSessionStore;
  });

  test.it('1. Valid same-origin /api/ requests resolve correctly, attach Bearer token, and reach fetch', async () => {
    const result = await ApiClient.get('/api/auth/me');

    assert.equal(fetchCallCount, 1, 'Valid request must reach fetch exactly once');
    assert.equal(lastFetchCall.url, 'http://localhost:5000/api/auth/me');
    assert.equal(lastFetchCall.options.method, 'GET');
    assert.equal(
      lastFetchCall.options.headers['Authorization'],
      'Bearer dummy-mock-jwt-token-12345',
      'Must attach Bearer token from SessionStore'
    );
    assert.equal(result.data, 'mock-response');
  });

  test.it('2. Fully qualified same-origin URL to /api/ resolves and reaches fetch', async () => {
    await ApiClient.post('http://localhost:5000/api/auth/login', { email: 'test@example.com' });

    assert.equal(fetchCallCount, 1, 'Valid full same-origin URL must reach fetch');
    assert.equal(lastFetchCall.url, 'http://localhost:5000/api/auth/login');
    assert.equal(lastFetchCall.options.method, 'POST');
    assert.equal(
      lastFetchCall.options.headers['Authorization'],
      'Bearer dummy-mock-jwt-token-12345'
    );
  });

  test.it('3. Rejects external origin URLs; never reaches fetch and never leaks token', async () => {
    const externalUrls = [
      'https://example.com/api/steal',
      'http://attacker.org/api/auth',
      'https://subdomain.localhost:5000/api/test',
      'http://localhost:3000/api/auth/me', // Different port is different origin
    ];

    for (const url of externalUrls) {
      await assert.rejects(
        async () => {
          await ApiClient.get(url);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'CROSS_ORIGIN_FORBIDDEN');
          return true;
        },
        `Must reject external URL: ${url}`
      );
    }

    assert.equal(fetchCallCount, 0, 'Rejected external requests must NEVER call fetch');
  });

  test.it('4. Rejects protocol-relative URLs (//example.com/api); never reaches fetch', async () => {
    const protocolRelativeUrls = [
      '//example.com/api/steal',
      '//attacker.org/api/auth/login',
    ];

    for (const url of protocolRelativeUrls) {
      await assert.rejects(
        async () => {
          await ApiClient.get(url);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'CROSS_ORIGIN_FORBIDDEN');
          return true;
        },
        `Must reject protocol-relative URL: ${url}`
      );
    }

    assert.equal(fetchCallCount, 0, 'Protocol-relative requests must NEVER call fetch');
  });

  test.it('5. Rejects backslash-based URLs (\\\\example.com/api); never reaches fetch', async () => {
    const backslashUrls = [
      '\\\\example.com/api/steal',
      '\\example.com/api/auth',
      '\\\\\\example.com/api/test',
    ];

    for (const url of backslashUrls) {
      await assert.rejects(
        async () => {
          await ApiClient.get(url);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.ok(
            err.code === 'CROSS_ORIGIN_FORBIDDEN' || err.code === 'UNSUPPORTED_DESTINATION',
            `Expected rejection code, got ${err.code}`
          );
          return true;
        },
        `Must reject backslash-based URL: ${url}`
      );
    }

    assert.equal(fetchCallCount, 0, 'Backslash-based requests must NEVER call fetch');
  });

  test.it('6. Rejects non-API path destinations; never reaches fetch', async () => {
    const nonApiPaths = [
      '/login.html',
      '/dashboard.html',
      '/data/parking.json',
      '/not-api/test',
      '/api-fake/endpoint',
      '/api/../not-api/test', // Path traversal escaping /api/
    ];

    for (const path of nonApiPaths) {
      await assert.rejects(
        async () => {
          await ApiClient.get(path);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'UNSUPPORTED_DESTINATION');
          return true;
        },
        `Must reject non-API path: ${path}`
      );
    }

    assert.equal(fetchCallCount, 0, 'Non-API destination requests must NEVER call fetch');
  });

  test.it('7. Rejects unsupported protocols (javascript:, ftp:, data:); never reaches fetch', async () => {
    const badProtocolUrls = [
      'javascript:alert(1)',
      'ftp://localhost:5000/api/test',
      'data:text/html,<script>alert(1)</script>',
    ];

    for (const url of badProtocolUrls) {
      await assert.rejects(
        async () => {
          await ApiClient.get(url);
        },
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.ok(
            err.code === 'UNSUPPORTED_PROTOCOL' ||
            err.code === 'CROSS_ORIGIN_FORBIDDEN' ||
            err.code === 'INVALID_URL'
          );
          return true;
        },
        `Must reject unsupported protocol: ${url}`
      );
    }

    assert.equal(fetchCallCount, 0, 'Unsupported protocol requests must NEVER call fetch');
  });

  test.it('8. Does not attach Authorization header if SessionStore has no token', async () => {
    global.SessionStore = { getToken: () => null };

    await ApiClient.get('/api/health');

    assert.equal(fetchCallCount, 1);
    assert.equal(
      lastFetchCall.options.headers['Authorization'],
      undefined,
      'Must NOT attach Authorization header when no session token exists'
    );
  });
});
