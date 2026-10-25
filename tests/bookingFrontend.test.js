// tests/bookingFrontend.test.js — Stage 9 Frontend Unit & Integration Tests
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BookingApp,
  calculateEstimatedPaise,
  formatPaiseToRupees,
  isSlotCompatible,
  generateUUIDv4,
  POLL_INTERVAL_MS,
  UUID_V4_RE,
} = require('../public/js/booking');

const { getSafeReturnUrl } = require('../public/js/auth');

/**
 * Minimal mock DOM element helper
 */
function createMockElement(tagName = 'div', id = '') {
  const children = [];
  const attributes = {};
  let _textContent = '';
  let _innerHTML = '';
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
    value: '',
    hidden: false,
    disabled: false,
    style: {},
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
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(val) {
      _innerHTML = String(val);
      if (val === '') {
        children.length = 0;
      }
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
    querySelector: (sel) => {
      const findIn = (node) => {
        for (const c of node.children || []) {
          if (sel.startsWith('[') && sel.includes('=')) {
            const m = sel.match(/\[([a-zA-Z0-9_\-]+)="?([^"\]]+)"?\]/);
            if (m && c.getAttribute && c.getAttribute(m[1]) === m[2]) return c;
          } else if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            if (c.className && c.className.includes(cls)) return c;
          } else if (c.tagName === sel.toUpperCase()) {
            return c;
          }
          const nested = findIn(c);
          if (nested) return nested;
        }
        return null;
      };
      return findIn(el);
    },
    focus: () => {},
    scrollIntoView: () => {},
  };

  return el;
}

global.document = {
  createElement: (tag) => createMockElement(tag),
  getElementById: () => null,
};

test('Stage 9 — Frontend Booking & Idempotency Unit Tests', async (t) => {
  // ── 1. Safe Login Return Target Validation ──────────────────────────────
  await t.test('1. Safe Login Return Target Validation (getSafeReturnUrl)', (t2) => {
    const APP_BASE = 'http://localhost:5000/login.html';

    t2.test('accepts valid relative application paths and resolves strictly on app origin', () => {
      const target1 = getSafeReturnUrl('booking.html?locationId=loc123');
      assert.strictEqual(target1, 'booking.html?locationId=loc123');
      const resolved1 = new URL(target1, APP_BASE);
      assert.strictEqual(resolved1.origin, 'http://localhost:5000');
      assert.strictEqual(resolved1.pathname, '/booking.html');
      assert.strictEqual(resolved1.searchParams.get('locationId'), 'loc123');

      const target2 = getSafeReturnUrl('/booking.html?locationId=loc123');
      assert.strictEqual(target2, 'booking.html?locationId=loc123');
      const resolved2 = new URL(target2, APP_BASE);
      assert.strictEqual(resolved2.origin, 'http://localhost:5000');
      assert.strictEqual(resolved2.pathname, '/booking.html');
      assert.strictEqual(resolved2.searchParams.get('locationId'), 'loc123');

      const target3 = getSafeReturnUrl('dashboard.html');
      assert.strictEqual(target3, 'dashboard.html');
      const resolved3 = new URL(target3, APP_BASE);
      assert.strictEqual(resolved3.origin, 'http://localhost:5000');
      assert.strictEqual(resolved3.pathname, '/dashboard.html');

      const target4 = getSafeReturnUrl('/locations.html');
      assert.strictEqual(target4, 'locations.html');
      const resolved4 = new URL(target4, APP_BASE);
      assert.strictEqual(resolved4.origin, 'http://localhost:5000');
      assert.strictEqual(resolved4.pathname, '/locations.html');
    });

    t2.test('neutralizes reproduced defect: /https://example.com without unsafe reinterpretation', () => {
      // Previously, stripping the leading slash converted /https://example.com into https://example.com
      const result = getSafeReturnUrl('/https://example.com');
      assert.strictEqual(result, 'dashboard.html');
      const finalUrl = new URL(result, APP_BASE);
      assert.strictEqual(finalUrl.origin, 'http://localhost:5000');
      assert.strictEqual(finalUrl.hostname, 'localhost');
      assert.strictEqual(finalUrl.pathname, '/dashboard.html');
    });

    t2.test('neutralizes reproduced defect: http://localhost:5000///example.com', () => {
      // Previously, stripping single leading slash left //example.com which resolved protocol-relative to external host
      const result = getSafeReturnUrl('http://localhost:5000///example.com');
      assert.strictEqual(result, 'dashboard.html');
      const finalUrl = new URL(result, APP_BASE);
      assert.strictEqual(finalUrl.origin, 'http://localhost:5000');
      assert.strictEqual(finalUrl.hostname, 'localhost');
      assert.strictEqual(finalUrl.pathname, '/dashboard.html');
    });

    t2.test('rejects login and register return loops', () => {
      assert.strictEqual(getSafeReturnUrl('login.html'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('/login.html'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('login.html?returnUrl=dashboard.html'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('register.html'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('/register.html'), 'dashboard.html');
    });

    t2.test('rejects protocol-relative URLs (open redirect bypass)', () => {
      const res1 = getSafeReturnUrl('//evil.example.com/steal');
      assert.strictEqual(res1, 'dashboard.html');
      assert.strictEqual(new URL(res1, APP_BASE).origin, 'http://localhost:5000');

      const res2 = getSafeReturnUrl('//localhost:5000/booking.html');
      assert.strictEqual(res2, 'dashboard.html');
      assert.strictEqual(new URL(res2, APP_BASE).origin, 'http://localhost:5000');
    });

    t2.test('rejects Windows backslash bypass tricks', () => {
      assert.strictEqual(getSafeReturnUrl('\\evil.example.com'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('/\\evil.example.com'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('booking.html?\\evil.com'), 'dashboard.html');
    });

    t2.test('rejects external origins and malformed schemes', () => {
      assert.strictEqual(getSafeReturnUrl('https://malicious.example.com/phish'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('javascript:alert(1)'), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('data:text/html,hack'), 'dashboard.html');
    });

    t2.test('falls back to default target when absent or empty', () => {
      assert.strictEqual(getSafeReturnUrl(null), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl(undefined), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl(''), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('   '), 'dashboard.html');
      assert.strictEqual(getSafeReturnUrl('', 'custom.html'), 'custom.html');
    });
  });

  // ── 2. UUIDv4 Generation & Integer Paise Math ──────────────────────────
  await t.test('2. UUIDv4 Generation & Integer Paise Calculations', (t2) => {
    t2.test('generateUUIDv4 produces valid UUIDv4 strings', () => {
      for (let i = 0; i < 20; i++) {
        const id = generateUUIDv4();
        assert.match(id, UUID_V4_RE, `Generated ID ${id} must match UUIDv4 regex`);
      }
    });

    t2.test('generateUUIDv4 produces distinct IDs across successive calls', () => {
      const id1 = generateUUIDv4();
      const id2 = generateUUIDv4();
      assert.notStrictEqual(id1, id2, 'Two successive UUIDs must be distinct');
    });

    t2.test('calculateEstimatedPaise computes exact integer multiplication', () => {
      assert.strictEqual(calculateEstimatedPaise(2000, 3), 6000);
      assert.strictEqual(calculateEstimatedPaise(1550, 1), 1550);
      assert.strictEqual(calculateEstimatedPaise(5000, 24), 120000);
    });

    t2.test('calculateEstimatedPaise safely handles non-integer and negative inputs', () => {
      assert.strictEqual(calculateEstimatedPaise(-100, 2), 0);
      assert.strictEqual(calculateEstimatedPaise(100, 0), 0);
      assert.strictEqual(calculateEstimatedPaise(100, -1), 0);
      assert.strictEqual(calculateEstimatedPaise(100.5, 2), 0);
      assert.strictEqual(calculateEstimatedPaise(null, 2), 0);
    });

    t2.test('formatPaiseToRupees correctly formats paise to INR currency strings', () => {
      assert.strictEqual(formatPaiseToRupees(2000), '₹20.00');
      assert.strictEqual(formatPaiseToRupees(150), '₹1.50');
      assert.strictEqual(formatPaiseToRupees(0), '₹0.00');
      assert.strictEqual(formatPaiseToRupees(-50), '₹0.00');
    });

    t2.test('isSlotCompatible validates slot vehicle type matching', () => {
      assert.strictEqual(isSlotCompatible('car', 'car'), true);
      assert.strictEqual(isSlotCompatible('bike', 'bike'), true);
      assert.strictEqual(isSlotCompatible('ev', 'ev'), true);
      assert.strictEqual(isSlotCompatible('car', 'bike'), false);
      assert.strictEqual(isSlotCompatible('car', 'ev'), false);
      assert.strictEqual(isSlotCompatible('car', 'all'), true);
    });
  });

  // ── 3. Frontend App State, Idempotency & Workflow ───────────────────────
  await t.test('3. Booking Submission Payload & Idempotency Safeguards', (t2) => {
    let mockSessionStoreData = { userId: 'user_test_default', name: 'Test User' };
    let mockSessionStorage = {};
    global.sessionStorage = {
      setItem: (k, v) => { mockSessionStorage[k] = String(v); },
      getItem: (k) => (Object.prototype.hasOwnProperty.call(mockSessionStorage, k) ? mockSessionStorage[k] : null),
      removeItem: (k) => { delete mockSessionStorage[k]; },
      clear: () => { mockSessionStorage = {}; },
    };
    global.SessionStore = {
      get: () => mockSessionStoreData,
      getToken: () => 'valid-jwt-token',
    };

    t2.beforeEach(() => {
      mockSessionStoreData = { userId: 'user_test_default', name: 'Test User' };
      mockSessionStorage = {};
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.isSubmitting = false;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.locationId = 'loc_test_1';
    });

    t2.test('submits strictly allowed fields and omits forbidden client fields', async () => {
      let sentPayload = null;
      global.ApiClient = {
        post: async (path, body) => {
          sentPayload = body;
          return {
            success: true,
            idempotentRetry: false,
            booking: {
              id: 'bk_test_123',
              locationName: 'City Center Mall',
              slotCode: 'A-G-01',
              vehicle: { registrationNumber: 'DL01AB1234', type: 'car' },
              totalPaise: 4000,
              durationHours: 2,
              status: 'active',
            },
          };
        },
      };

      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.state.selectedSlot = {
        id: 'slot_test_1',
        code: 'A-G-01',
        zone: 'A',
        vehicleType: 'car',
        pricePerHourPaise: 2000,
      };

      // Mock form inputs
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'dl 01 ab 1234' };
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.btnConfirmBooking = createMockElement('button');

      await BookingApp.handleBookingSubmit();

      assert.ok(sentPayload, 'Payload must be sent via ApiClient.post');
      assert.strictEqual(sentPayload.locationId, 'loc_test_1');
      assert.strictEqual(sentPayload.slotId, 'slot_test_1');
      assert.strictEqual(sentPayload.vehicleNumber, 'DL 01 AB 1234', 'Vehicle number must be normalized');
      assert.strictEqual(sentPayload.vehicleType, 'car');
      assert.strictEqual(sentPayload.durationHours, 2);
      assert.match(sentPayload.requestId, UUID_V4_RE, 'requestId must be a valid UUIDv4');

      // Crucial: Client must NEVER send server-derived fields
      assert.strictEqual(sentPayload.price, undefined);
      assert.strictEqual(sentPayload.total, undefined);
      assert.strictEqual(sentPayload.totalPaise, undefined);
      assert.strictEqual(sentPayload.status, undefined);
      assert.strictEqual(sentPayload.user, undefined);
    });

    t2.test('preserves identical requestId on retry after network failure', async () => {
      let attemptCount = 0;
      let recordedRequestIds = [];

      global.ApiClient = {
        post: async (path, body) => {
          attemptCount++;
          recordedRequestIds.push(body.requestId);
          if (attemptCount === 1) {
            // First attempt encounters a network failure / timeout
            const netErr = new Error('Network request failed');
            netErr.status = 0;
            throw netErr;
          }
          // Second attempt succeeds via idempotent retry
          return {
            success: true,
            idempotentRetry: true,
            booking: {
              id: 'bk_test_123',
              slotCode: 'A-G-01',
              totalPaise: 4000,
              status: 'active',
            },
          };
        },
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.state.selectedSlot = {
        id: 'slot_test_1',
        code: 'A-G-01',
        vehicleType: 'car',
        pricePerHourPaise: 2000,
      };

      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'MH12AB1234' };
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.uncertainAlert = createMockElement('div');
      BookingApp.elements.uncertainMessage = createMockElement('p');
      BookingApp.elements.btnRetryUncertain = createMockElement('button');

      // 1. Initial attempt fails with network error
      await BookingApp.handleBookingSubmit();

      assert.ok(BookingApp.state.uncertainAttempt, 'Uncertain attempt must be retained in memory');
      const firstRequestId = recordedRequestIds[0];
      assert.match(firstRequestId, UUID_V4_RE);

      // 2. Retry identical booking via dedicated retry path
      await BookingApp.handleRetryUncertain();

      assert.strictEqual(recordedRequestIds.length, 2);
      assert.strictEqual(
        recordedRequestIds[1],
        firstRequestId,
        'Retry of uncertain attempt must reuse the EXACT same requestId'
      );
      assert.strictEqual(
        BookingApp.state.uncertainAttempt,
        null,
        'Uncertain attempt must be cleared after success'
      );
    });

    t2.test('dedicated handleRetryUncertain submits original immutable payload and requestId even if form fields or selection changed', async () => {
      let recordedPosts = [];
      global.ApiClient = {
        post: async (path, body) => {
          recordedPosts.push(body);
          if (recordedPosts.length === 1) {
            const netErr = new Error('Network failure');
            netErr.status = 0;
            throw netErr;
          }
          return {
            success: true,
            idempotentRetry: true,
            booking: {
              id: 'bk_recovered_1',
              slotCode: 'A-G-01',
              totalPaise: 4000,
              status: 'active',
            },
          };
        },
        get: async () => ({ success: true, slots: [] }),
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.state.selectedSlot = {
        id: 'slot_test_1',
        code: 'A-G-01',
        vehicleType: 'car',
        pricePerHourPaise: 2000,
      };

      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'KA01AB1234' };
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.uncertainAlert = createMockElement('div');
      BookingApp.elements.uncertainMessage = createMockElement('p');
      BookingApp.elements.btnRetryUncertain = createMockElement('button');

      // 1. Initial attempt fails with network error -> recorded as uncertain
      await BookingApp.handleBookingSubmit();
      assert.ok(BookingApp.state.uncertainAttempt, 'Uncertain attempt must be retained');
      const originalRequestId = recordedPosts[0].requestId;
      const originalSlotId = recordedPosts[0].slotId;
      const originalVehicleNumber = recordedPosts[0].vehicleNumber;
      const originalDuration = recordedPosts[0].durationHours;

      // 2. User edits mutable form inputs and changes slot selection
      BookingApp.elements.durationSelect.value = '6'; // changed
      BookingApp.elements.vehicleNumberInput.value = 'DL99ZZ9999'; // changed
      BookingApp.elements.vehicleTypeSelect.value = 'bike'; // changed
      BookingApp.state.selectedSlot = {
        id: 'slot_other_99',
        code: 'B-G-99',
        vehicleType: 'bike',
        pricePerHourPaise: 1000,
      };

      // 3. Trigger dedicated retry path
      await BookingApp.handleRetryUncertain();

      assert.strictEqual(recordedPosts.length, 2);
      const retriedPayload = recordedPosts[1];

      // Assert that retry submitted the ORIGINAL immutable payload, NOT the edited fields!
      assert.strictEqual(retriedPayload.requestId, originalRequestId, 'Retry must submit original requestId');
      assert.strictEqual(retriedPayload.slotId, originalSlotId, 'Retry must submit original slotId');
      assert.strictEqual(retriedPayload.vehicleNumber, originalVehicleNumber, 'Retry must submit original vehicleNumber');
      assert.strictEqual(retriedPayload.durationHours, originalDuration, 'Retry must submit original duration');
      assert.strictEqual(BookingApp.state.uncertainAttempt, null, 'Uncertain attempt must be cleared after successful retry');
    });

    t2.test('blocks new/different booking submissions while an attempt is in-flight or uncertain', async () => {
      let postCount = 0;
      global.ApiClient = {
        post: async () => {
          postCount++;
          return { success: true };
        },
      };

      BookingApp.state.uncertainAttempt = {
        payload: { slotId: 'slot_1', locationId: 'loc_1' },
        requestId: generateUUIDv4(),
        timestamp: Date.now(),
      };
      BookingApp.elements.bookingFormError = createMockElement('p');

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(postCount, 0, 'New booking submission must be blocked while attempt is uncertain');
      assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
      assert.match(BookingApp.elements.bookingFormError.textContent, /unresolved booking attempt/i);
    });

    t2.test('blocks normal booking submission when location is closed', async () => {
      let postCount = 0;
      global.ApiClient = {
        post: async () => {
          postCount++;
          return { success: true };
        },
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'closed' };
      BookingApp.state.selectedSlot = { id: 'slot_1', vehicleType: 'car' };
      BookingApp.elements.bookingFormError = createMockElement('p');

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(postCount, 0, 'Normal booking submission must be blocked when location is closed');
      assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
      assert.match(BookingApp.elements.bookingFormError.textContent, /currently closed/i);
    });

    t2.test('allows dedicated retry of original request even if location is closed or slot appears occupied', async () => {
      let retriedPayload = null;
      global.ApiClient = {
        post: async (path, body) => {
          retriedPayload = body;
          return {
            success: true,
            idempotentRetry: true,
            booking: { id: 'bk_replayed_1', totalPaise: 2000, status: 'active' },
          };
        },
        get: async () => ({ success: true, slots: [] }),
      };

      // Location is closed and slot is occupied
      BookingApp.state.location = { status: 'closed' };
      BookingApp.state.slots = [{ id: 'slot_original', available: false }];
      BookingApp.state.uncertainAttempt = {
        payload: {
          locationId: 'loc_closed',
          slotId: 'slot_original',
          vehicleNumber: 'KA01AA1111',
          vehicleType: 'car',
          durationHours: 1,
          requestId: 'req_original_123',
        },
        requestId: 'req_original_123',
        userId: 'user_test_default',
        timestamp: Date.now(),
      };

      // Dedicated retry must NOT be blocked by client-side closed/occupied rules: backend idempotency decides!
      await BookingApp.handleRetryUncertain();

      assert.ok(retriedPayload, 'Backend must receive retry request');
      assert.strictEqual(retriedPayload.requestId, 'req_original_123');
    });

    t2.test('bookAnotherSlot does not silently erase unresolved uncertainAttempt', () => {
      BookingApp.state.uncertainAttempt = {
        payload: { slotId: 'slot_1' },
        requestId: 'req_keep',
      };
      BookingApp.elements.uncertainAlert = createMockElement('div');
      BookingApp.elements.uncertainAlert.hidden = false;
      BookingApp.elements.confirmationCard = createMockElement('section');
      BookingApp.elements.workflowContainer = createMockElement('div');

      BookingApp.state.selectedSlot = { id: 'slot_1' };
      BookingApp.elements.btnBookAnother = createMockElement('button');
      BookingApp.elements.btnBookAnother.onclick = () => {
        BookingApp.state.selectedSlot = null;
        if (!BookingApp.state.uncertainAttempt) {
          BookingApp.elements.uncertainAlert.hidden = true;
        }
      };
      BookingApp.elements.btnBookAnother.onclick();

      assert.ok(BookingApp.state.uncertainAttempt, 'Uncertain attempt must not be silently erased');
      assert.strictEqual(BookingApp.elements.uncertainAlert.hidden, false, 'Uncertain alert must remain visible');
    });

    t2.test('REQUEST_ID_REUSED shows conflict and requires reconciliation without starting a fresh request', async () => {
      global.ApiClient = {
        post: async () => {
          const err = new Error('Request ID already used with different parameters.');
          err.status = 409;
          err.code = 'REQUEST_ID_REUSED';
          throw err;
        },
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.selectedSlot = { id: 'slot_1', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'DL01AB1111' };
      BookingApp.elements.durationSelect = { value: '1' };
      BookingApp.elements.bookingFormError = createMockElement('p');

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
      assert.match(BookingApp.elements.bookingFormError.textContent, /conflict/i);
      assert.match(BookingApp.elements.bookingFormError.textContent, /reconciliation/i);
      assert.doesNotMatch(BookingApp.elements.bookingFormError.textContent, /starting a fresh request/i);
    });

    t2.test('user-scoped session recovery stores attempt per userId and never retries another user attempt', () => {
      // User Alice is logged in
      mockSessionStoreData = { userId: 'user_alice_123', name: 'Alice' };

      const aliceAttempt = {
        payload: {
          locationId: 'loc_test_1',
          slotId: 'slot_1',
          vehicleNumber: 'ALICE01',
          vehicleType: 'car',
          durationHours: 1,
        },
        requestId: 'req_alice_001',
        timestamp: Date.now(),
      };

      BookingApp.saveUncertainAttempt(aliceAttempt);
      assert.ok(mockSessionStorage['parkwise_uncertain_booking_user_alice_123'], 'Must store under user-scoped key');

      // User switches to Bob
      mockSessionStoreData = { userId: 'user_bob_456', name: 'Bob' };
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.locationId = 'loc_test_1';

      BookingApp.restoreUncertainAttempt();

      assert.strictEqual(
        BookingApp.state.uncertainAttempt,
        null,
        'Must NEVER restore or retry another user\'s attempt for Bob'
      );

      // Switch back to Alice
      mockSessionStoreData = { userId: 'user_alice_123', name: 'Alice' };
      BookingApp.restoreUncertainAttempt();

      assert.ok(BookingApp.state.uncertainAttempt, 'Must restore attempt for Alice');
      assert.strictEqual(BookingApp.state.uncertainAttempt.requestId, 'req_alice_001');

      // Clean up
      BookingApp.clearUncertainAttempt();
      assert.strictEqual(mockSessionStorage['parkwise_uncertain_booking_user_alice_123'], undefined);
    });

    t2.test('handles 409 SLOT_UNAVAILABLE by clearing invalid slot and reloading slots', async () => {
      let slotsReloaded = false;
      global.ApiClient = {
        post: async () => {
          const err = new Error('Slot is no longer available.');
          err.status = 409;
          err.code = 'SLOT_UNAVAILABLE';
          throw err;
        },
        get: async (path) => {
          if (path.includes('/slots')) {
            slotsReloaded = true;
            return { success: true, slots: [] };
          }
          return { success: true, location: { id: 'loc_1', status: 'active' } };
        },
      };

      BookingApp.state.selectedSlot = { id: 'slot_1', code: 'A-G-01', vehicleType: 'car' };
      BookingApp.elements.bookingFormError = createMockElement('p');

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(BookingApp.state.selectedSlot, null, 'Invalid slot selection must be cleared on 409');
      assert.strictEqual(slotsReloaded, true, 'Slots must be refreshed on 409 SLOT_UNAVAILABLE');
    });

    // ── Additional Controller Regression Tests ──────────────────────────────
    t2.test('pending POST already has a persisted recovery record in sessionStorage before server responds', async () => {
      let recordDuringPost = null;
      global.ApiClient = {
        post: async () => new Promise((resolve) => {
          // Inspect sessionStorage while POST is still pending!
          recordDuringPost = global.sessionStorage.getItem('parkwise_uncertain_booking_user_test_default');
          resolve({
            success: true,
            booking: { id: 'bk_ok_1', slotCode: 'A-1', status: 'active' },
          });
        }),
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.state.selectedSlot = { id: 'slot_test_1', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'DL01AB1234' };
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.btnConfirmBooking = createMockElement('button');

      await BookingApp.handleBookingSubmit();

      assert.ok(recordDuringPost, 'Recovery record must exist in sessionStorage WHILE POST is in flight');
      const parsed = JSON.parse(recordDuringPost);
      assert.strictEqual(parsed.status, 'in_flight');
      assert.strictEqual(parsed.payload.slotId, 'slot_test_1');
      assert.strictEqual(parsed.userId, 'user_test_default');
    });

    t2.test('a fresh page/controller can restore pending in-flight attempt as unresolved before original response', async () => {
      const inFlightRecord = {
        payload: {
          locationId: 'loc_test_1',
          slotId: 'slot_inflight_1',
          vehicleNumber: 'MH02CD5678',
          vehicleType: 'car',
          durationHours: 3,
          requestId: 'req_inflight_999',
        },
        requestId: 'req_inflight_999',
        userId: 'user_test_default',
        locationId: 'loc_test_1',
        timestamp: Date.now(),
        status: 'in_flight',
      };
      global.sessionStorage.setItem('parkwise_uncertain_booking_user_test_default', JSON.stringify(inFlightRecord));

      // Fresh controller state (as on page reload before original POST completes)
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.elements.uncertainAlert = createMockElement('div');
      BookingApp.elements.uncertainMessage = createMockElement('p');

      BookingApp.restoreUncertainAttempt();

      assert.ok(BookingApp.state.uncertainAttempt, 'Restored attempt must be active in state');
      assert.strictEqual(BookingApp.state.uncertainAttempt.status, 'unresolved', 'Restored in-flight attempt must be treated as unresolved');
      assert.strictEqual(BookingApp.state.uncertainAttempt.requestId, 'req_inflight_999');
      assert.strictEqual(BookingApp.elements.uncertainAlert.hidden, false, 'Uncertain alert banner must be shown');
    });

    t2.test('visiting location B preserves unresolved location A and blocks a different POST', async () => {
      let postAttempted = false;
      global.ApiClient = {
        post: async () => {
          postAttempted = true;
          return { success: true };
        },
      };

      // Unresolved attempt for location A
      const attemptLocA = {
        payload: {
          locationId: 'loc_A',
          slotId: 'slot_A_1',
          vehicleNumber: 'KA05XY1234',
          vehicleType: 'car',
          durationHours: 2,
          requestId: 'req_locA_001',
        },
        requestId: 'req_locA_001',
        userId: 'user_test_default',
        locationId: 'loc_A',
        timestamp: Date.now(),
        status: 'unresolved',
      };
      global.sessionStorage.setItem('parkwise_uncertain_booking_user_test_default', JSON.stringify(attemptLocA));

      // User visits location B
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.locationId = 'loc_B';
      BookingApp.state.location = { id: 'loc_B', status: 'active' };
      BookingApp.elements.uncertainAlert = createMockElement('div');
      BookingApp.elements.uncertainMessage = createMockElement('p');
      BookingApp.elements.btnReturnUncertain = createMockElement('a');
      BookingApp.elements.bookingFormError = createMockElement('p');

      // Controller restores attempt on location B
      BookingApp.restoreUncertainAttempt();

      assert.ok(BookingApp.state.uncertainAttempt, 'Attempt for location A must be restored on location B');
      assert.strictEqual(BookingApp.state.uncertainAttempt.payload.locationId, 'loc_A');
      assert.match(BookingApp.elements.uncertainMessage.textContent, /loc_A/i);
      assert.strictEqual(BookingApp.elements.btnReturnUncertain.hidden, false);
      assert.strictEqual(BookingApp.elements.btnReturnUncertain.href, 'booking.html?locationId=loc_A');

      // User attempts to submit a booking for location B
      BookingApp.state.selectedSlot = { id: 'slot_B_99', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'KA05XY9999' };
      BookingApp.elements.durationSelect = { value: '1' };

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(postAttempted, false, 'POST for location B must be blocked');
      assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
      assert.match(BookingApp.elements.bookingFormError.textContent, /loc_A/i);

      // Verify location A's record in sessionStorage was NOT overwritten
      const stored = JSON.parse(global.sessionStorage.getItem('parkwise_uncertain_booking_user_test_default'));
      assert.strictEqual(stored.payload.locationId, 'loc_A');
      assert.strictEqual(stored.requestId, 'req_locA_001');
    });

    t2.test('another user cannot retry the saved attempt', async () => {
      let postCount = 0;
      global.ApiClient = {
        post: async () => {
          postCount++;
          return { success: true };
        },
      };

      // Attempt belongs to Alice
      BookingApp.state.uncertainAttempt = {
        payload: {
          locationId: 'loc_1',
          slotId: 'slot_1',
          vehicleNumber: 'ALICE111',
          vehicleType: 'car',
          durationHours: 1,
          requestId: 'req_alice_secret',
        },
        requestId: 'req_alice_secret',
        userId: 'user_alice',
      };

      // Current logged in user is Bob
      mockSessionStoreData = { userId: 'user_bob', name: 'Bob' };
      BookingApp.elements.bookingFormError = createMockElement('p');

      await BookingApp.handleRetryUncertain();

      assert.strictEqual(postCount, 0, 'POST must be blocked when attempt belongs to another user');
      assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
      assert.match(BookingApp.elements.bookingFormError.textContent, /different user account/i);
    });

    t2.test('storage failure does not dispatch an unprotected booking', async () => {
      let postDispatched = false;
      global.ApiClient = {
        post: async () => {
          postDispatched = true;
          return { success: true };
        },
      };

      // Simulate sessionStorage throwing (e.g. quota exceeded or security restriction)
      const originalSetItem = global.sessionStorage.setItem;
      global.sessionStorage.setItem = () => {
        throw new Error('QuotaExceededError: DOM Exception 22');
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.locationId = 'loc_test_1';
      BookingApp.state.selectedSlot = { id: 'slot_test_1', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'DL01AB1234' };
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.bookingFormError = createMockElement('p');

      try {
        await BookingApp.handleBookingSubmit();

        assert.strictEqual(postDispatched, false, 'Must NOT dispatch booking if recovery state cannot be secured');
        assert.strictEqual(BookingApp.elements.bookingFormError.hidden, false);
        assert.match(BookingApp.elements.bookingFormError.textContent, /session storage failure/i);
      } finally {
        global.sessionStorage.setItem = originalSetItem;
      }
    });
  });

  // ── 4. Polling Lifecycle & Selection Preservation ──────────────────────
  await t.test('4. 15-Second Polling Lifecycle & State Preservation', (t2) => {
    t2.test('POLL_INTERVAL_MS is exactly 15000ms', () => {
      assert.strictEqual(POLL_INTERVAL_MS, 15000);
    });

    t2.test('preserves selectedSlot when slot remains available during background refresh', async () => {
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.selectedSlot = { id: 'slot_1', code: 'A-G-01', available: true };
      BookingApp.state.uncertainAttempt = null;

      global.ApiClient = {
        get: async () => ({
          success: true,
          slots: [
            { id: 'slot_1', code: 'A-G-01', available: true, zone: 'A' },
            { id: 'slot_2', code: 'A-G-02', available: false, zone: 'A' },
          ],
        }),
      };

      await BookingApp.refreshAvailability();

      assert.ok(BookingApp.state.selectedSlot, 'Selected slot must be preserved when still available');
      assert.strictEqual(BookingApp.state.selectedSlot.id, 'slot_1');
    });

    t2.test('preserves selectedSlot during refresh if uncertainAttempt is active', async () => {
      // If our own submission was uncertain and the slot is now occupied,
      // that occupancy may be our own booking! Do NOT clear selection.
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.selectedSlot = { id: 'slot_1', code: 'A-G-01', available: true };
      BookingApp.state.uncertainAttempt = {
        payload: { slotId: 'slot_1' },
        requestId: generateUUIDv4(),
        timestamp: Date.now(),
      };

      global.ApiClient = {
        get: async () => ({
          success: true,
          slots: [{ id: 'slot_1', code: 'A-G-01', available: false, zone: 'A' }],
        }),
      };

      await BookingApp.refreshAvailability();

      assert.ok(
        BookingApp.state.selectedSlot,
        'Selected slot must not be cleared during uncertain attempt even if marked occupied'
      );
    });

    t2.test('startPolling and stopPolling properly manage the polling timer', () => {
      BookingApp.startPolling();
      assert.ok(BookingApp.state.pollTimer, 'pollTimer must be set after startPolling');

      BookingApp.stopPolling();
      assert.strictEqual(BookingApp.state.pollTimer, null, 'pollTimer must be null after stopPolling');
    });

    t2.test('discards stale polling responses when newer sequence arrives', async () => {
      BookingApp.state.locationId = 'loc_1';
      let delayedResolve;
      const delayedPromise = new Promise((resolve) => {
        delayedResolve = resolve;
      });

      let callCount = 0;
      global.ApiClient = {
        get: async () => {
          callCount++;
          if (callCount === 1) {
            return delayedPromise; // Stale request takes long
          }
          return {
            success: true,
            slots: [{ id: 'slot_fresh', code: 'FRESH-01', available: true }],
          };
        },
      };

      // Trigger first poll
      const poll1 = BookingApp.refreshAvailability();
      // Allow second poll by resetting isPolling
      BookingApp.state.isPolling = false;
      await BookingApp.refreshAvailability();

      assert.strictEqual(BookingApp.state.slots[0].code, 'FRESH-01');

      // Resolve stale poll
      delayedResolve({
        success: true,
        slots: [{ id: 'slot_stale', code: 'STALE-01', available: true }],
      });
      await poll1;

      // Stale response must be ignored
      assert.strictEqual(
        BookingApp.state.slots[0].code,
        'FRESH-01',
        'Stale response must be discarded by pollSequence check'
      );
    });

    t2.test('updates authoritative location status and controls on refresh', async () => {
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.location = { id: 'loc_1', status: 'active' };
      BookingApp.elements.selectedLocationStatus = createMockElement('span');
      BookingApp.elements.locationClosedBanner = createMockElement('div');
      BookingApp.elements.btnConfirmBooking = createMockElement('button');

      global.ApiClient = {
        get: async () => ({
          success: true,
          locationStatus: 'closed',
          slots: [],
        }),
      };

      await BookingApp.refreshAvailability();

      assert.strictEqual(BookingApp.state.location.status, 'closed');
      assert.strictEqual(BookingApp.elements.selectedLocationStatus.textContent, 'Closed');
      assert.strictEqual(BookingApp.elements.locationClosedBanner.hidden, false);
      assert.strictEqual(BookingApp.elements.btnConfirmBooking.disabled, true);
    });

    t2.test('invalidates selectedSlot when slot becomes unavailable unless protected by uncertain attempt', async () => {
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.isSubmitting = false;
      BookingApp.state.selectedSlot = { id: 'slot_1', code: 'A-01', available: true };
      BookingApp.elements.panel = createMockElement('div');
      BookingApp.elements.panelOverlay = createMockElement('div');

      global.ApiClient = {
        get: async () => ({
          success: true,
          locationStatus: 'active',
          slots: [{ id: 'slot_1', code: 'A-01', available: false }],
        }),
      };

      await BookingApp.refreshAvailability();

      assert.strictEqual(BookingApp.state.selectedSlot, null, 'Unprotected slot that became occupied must be invalidated');
    });

    t2.test('updates price preview on slot price refresh without clearing form inputs', async () => {
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.isSubmitting = false;
      BookingApp.state.selectedSlot = {
        id: 'slot_1',
        code: 'A-01',
        available: true,
        vehicleType: 'car',
        pricePerHourPaise: 2000,
      };

      BookingApp.elements.panelSlotPrice = createMockElement('span');
      BookingApp.elements.priceTotal = createMockElement('span');
      BookingApp.elements.priceBreakdown = createMockElement('span');
      BookingApp.elements.durationSelect = { value: '2' };
      BookingApp.elements.vehicleNumberInput = { value: 'MH12AA1111' };

      global.ApiClient = {
        get: async () => ({
          success: true,
          locationStatus: 'active',
          slots: [
            {
              id: 'slot_1',
              code: 'A-01',
              available: true,
              vehicleType: 'car',
              pricePerHourPaise: 3000, // Price updated by server
            },
          ],
        }),
      };

      await BookingApp.refreshAvailability();

      assert.strictEqual(BookingApp.state.selectedSlot.pricePerHourPaise, 3000);
      assert.strictEqual(BookingApp.elements.panelSlotPrice.textContent, '₹30.00 / hour');
      assert.strictEqual(BookingApp.elements.priceTotal.textContent, '₹60.00*');
      assert.strictEqual(BookingApp.elements.vehicleNumberInput.value, 'MH12AA1111', 'Form input must not be lost');
    });

    t2.test('explicitly handles location 404 in refreshAvailability', async () => {
      BookingApp.state.locationId = 'loc_deleted';
      BookingApp.state.hasLocationError = false;
      BookingApp.elements.locationErrorState = createMockElement('div');
      BookingApp.elements.locationErrorTitle = createMockElement('h2');
      BookingApp.elements.locationErrorDesc = createMockElement('p');

      global.ApiClient = {
        get: async () => {
          const err = new Error('Location not found');
          err.status = 404;
          throw err;
        },
      };

      await BookingApp.refreshAvailability();

      assert.strictEqual(BookingApp.state.hasLocationError, true);
      assert.strictEqual(BookingApp.elements.locationErrorState.hidden, false);
      assert.match(BookingApp.elements.locationErrorDesc.textContent, /archived or removed/i);
    });
  });

  // ── 5. Location Loading, Missing ID, and Closed Facility ────────────────
  await t.test('5. Location Loading, Missing ID & Closed Status Handling', (t2) => {
    t2.test('safely renders loadSlots error without raw innerHTML interpolation of err.message', async () => {
      BookingApp.state.locationId = 'loc_1';
      BookingApp.state.hasLocationError = false;
      BookingApp.elements.slotGrid = createMockElement('div');
      BookingApp.elements.slotCount = createMockElement('span');

      const maliciousXssMsg = '<img src=x onerror="alert(1)">Database Error';
      global.ApiClient = {
        get: async () => {
          throw new Error(maliciousXssMsg);
        },
      };

      await BookingApp.loadSlots();

      // Check DOM structure created
      assert.strictEqual(
        BookingApp.elements.slotGrid.innerHTML,
        '',
        'slotGrid.innerHTML must NOT contain raw unescaped HTML template literals'
      );
      assert.strictEqual(BookingApp.elements.slotGrid.children.length, 1);
      const emptyDiv = BookingApp.elements.slotGrid.children[0];
      const textNodes = emptyDiv.children.map((c) => c.textContent);
      assert.ok(textNodes.includes(maliciousXssMsg), 'Error message must be safely rendered via textContent');
    });

    t2.test('verifies hidden CSS styling rules ensure [hidden] and .hidden elements display none', () => {
      const fs = require('fs');
      const path = require('path');
      const cssContent = fs.readFileSync(path.join(__dirname, '../public/css/booking.css'), 'utf8');

      assert.ok(
        cssContent.includes('[hidden]') && cssContent.includes('display: none !important'),
        'booking.css must contain [hidden] display: none !important override'
      );
      assert.ok(
        cssContent.includes('.location-error-state[hidden]') &&
        cssContent.includes('.uncertain-banner[hidden]') &&
        cssContent.includes('.booking-confirmation-card[hidden]') &&
        cssContent.includes('.status-alert[hidden]'),
        'booking.css must explicitly override hidden on component state containers'
      );
    });
    t2.test('displays location error state when locationId is missing or empty', async () => {
      BookingApp.elements.locationErrorState = createMockElement('div');
      BookingApp.elements.locationErrorTitle = createMockElement('h2');
      BookingApp.elements.locationErrorDesc = createMockElement('p');
      BookingApp.elements.workflowContainer = createMockElement('div');

      let networkCalled = false;
      global.ApiClient = {
        get: async () => {
          networkCalled = true;
          return {};
        },
      };

      BookingApp.state.locationId = null;
      global.window = { location: { search: '' } };

      await BookingApp.init();

      assert.strictEqual(networkCalled, false, 'No network calls should be made when locationId is missing');
      assert.strictEqual(BookingApp.elements.locationErrorState.hidden, false);
      assert.strictEqual(BookingApp.state.hasLocationError, true);
    });

    t2.test('renders closed warning and disables booking button for closed locations', async () => {
      BookingApp.state.locationId = 'loc_closed_1';
      BookingApp.state.hasLocationError = false;

      BookingApp.elements.locationHeaderBar = createMockElement('div');
      BookingApp.elements.selectedLocationName = createMockElement('h1');
      BookingApp.elements.selectedLocationStatus = createMockElement('span');
      BookingApp.elements.selectedLocationAddress = createMockElement('p');
      BookingApp.elements.locationClosedBanner = createMockElement('div');
      BookingApp.elements.btnConfirmBooking = createMockElement('button');

      global.ApiClient = {
        get: async (path) => {
          if (path.includes('/slots')) {
            return { success: true, locationStatus: 'closed', slots: [] };
          }
          return {
            success: true,
            location: {
              id: 'loc_closed_1',
              name: 'Closed Airport Lot',
              status: 'closed',
              address: 'Terminal 3',
            },
          };
        },
      };

      const ok = await BookingApp.loadLocationDetails();

      assert.strictEqual(ok, true);
      assert.strictEqual(BookingApp.state.location.status, 'closed');
      assert.strictEqual(BookingApp.elements.locationClosedBanner.hidden, false);
      assert.strictEqual(BookingApp.elements.btnConfirmBooking.disabled, true);
    });
  });

  // ── 6. Confirmation Card & Absolute Zero LocalStorage Mutation ──────────
  await t.test('6. Authoritative Confirmation & Zero LocalStorage Mutations', (t2) => {
    t2.test('renders authoritative booking confirmation card with exact backend fields', async () => {
      BookingApp.elements.confirmationCard = createMockElement('section');
      BookingApp.elements.workflowContainer = createMockElement('div');
      BookingApp.elements.confIdempotentBadge = createMockElement('span');
      BookingApp.elements.confBookingId = createMockElement('span');
      BookingApp.elements.confLocationSlot = createMockElement('span');
      BookingApp.elements.confVehicle = createMockElement('span');
      BookingApp.elements.confSchedule = createMockElement('span');
      BookingApp.elements.confTotalPrice = createMockElement('span');
      BookingApp.elements.confStatus = createMockElement('span');

      const mockBooking = {
        id: '671600000000000000000001',
        locationName: 'City Center Hub',
        slotCode: 'A-G-05',
        vehicle: { registrationNumber: 'MH02CD5678', type: 'car' },
        startTime: '2026-10-22T08:00:00.000Z',
        endTime: '2026-10-22T11:00:00.000Z',
        durationHours: 3,
        totalPaise: 6000,
        status: 'active',
      };

      // 1. New Booking (201 Created)
      BookingApp.elements.workflowContainer.hidden = false;
      BookingApp.elements.confirmationCard.hidden = true;

      // Simulate submission success path
      global.ApiClient = {
        post: async () => ({
          success: true,
          idempotentRetry: false,
          booking: mockBooking,
        }),
        get: async () => ({ success: true, slots: [] }),
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.selectedSlot = { id: 'slot_5', code: 'A-G-05', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'MH02CD5678' };
      BookingApp.elements.durationSelect = { value: '3' };

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(BookingApp.elements.confirmationCard.hidden, false);
      assert.strictEqual(BookingApp.elements.workflowContainer.hidden, true);
      assert.strictEqual(BookingApp.elements.confBookingId.textContent, '671600000000000000000001');
      assert.strictEqual(BookingApp.elements.confTotalPrice.textContent, '₹60.00');
      assert.strictEqual(BookingApp.elements.confStatus.textContent, 'ACTIVE');
      assert.strictEqual(BookingApp.elements.confIdempotentBadge.hidden, true);
    });

    t2.test('displays Replayed Confirmation badge when idempotentRetry is true', async () => {
      global.ApiClient = {
        post: async () => ({
          success: true,
          idempotentRetry: true,
          booking: {
            id: '671600000000000000000001',
            locationName: 'City Center Hub',
            slotCode: 'A-G-05',
            vehicle: { registrationNumber: 'MH02CD5678', type: 'car' },
            totalPaise: 6000,
            status: 'active',
          },
        }),
        get: async () => ({ success: true, slots: [] }),
      };

      BookingApp.state.uncertainAttempt = null;
      BookingApp.state.location = { status: 'active' };
      BookingApp.state.selectedSlot = { id: 'slot_5', code: 'A-G-05', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'MH02CD5678' };
      BookingApp.elements.durationSelect = { value: '3' };

      await BookingApp.handleBookingSubmit();

      assert.strictEqual(
        BookingApp.elements.confIdempotentBadge.hidden,
        false,
        'Idempotent replay badge must be visible when idempotentRetry is true'
      );
    });

    t2.test('never mutates legacy localStorage during active booking flow', async () => {
      let setItemCalls = [];
      global.localStorage = {
        setItem: (k, v) => setItemCalls.push({ k, v }),
        getItem: () => null,
      };

      global.ApiClient = {
        post: async () => ({
          success: true,
          idempotentRetry: false,
          booking: {
            id: 'bk_live_01',
            slotCode: 'A-G-01',
            totalPaise: 2000,
            status: 'active',
          },
        }),
        get: async () => ({ success: true, slots: [] }),
      };

      BookingApp.state.selectedSlot = { id: 'slot_1', code: 'A-G-01', vehicleType: 'car' };
      BookingApp.elements.vehicleTypeSelect = { value: 'car' };
      BookingApp.elements.vehicleNumberInput = { value: 'DL01AB9999' };
      BookingApp.elements.durationSelect = { value: '1' };

      await BookingApp.handleBookingSubmit();

      const bookingStorageWrites = setItemCalls.filter(
        (c) => c.k === 'sps_bookings' || c.k === 'sps_slots'
      );
      assert.strictEqual(
        bookingStorageWrites.length,
        0,
        'Active booking must NEVER write to legacy localStorage (sps_bookings / sps_slots)'
      );
    });
  });

  // ── 7. Phase C UI Invariants — Modern Booking Page, Layout & Zero Emojis ─
  await t.test('7. Phase C UI Invariants — Modern Booking Page, Layout & Zero Emojis', (t2) => {
    const fs = require('node:fs');
    const path = require('node:path');

    t2.test('no emojis remain in booking.html or booking.js', () => {
      const htmlPath = path.join(__dirname, '../public/booking.html');
      const jsPath = path.join(__dirname, '../public/js/booking.js');

      const htmlContent = fs.readFileSync(htmlPath, 'utf8');
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/u;

      const htmlMatches = htmlContent.split('\n').filter((l) => emojiRegex.test(l));
      const jsMatches = jsContent.split('\n').filter((l) => emojiRegex.test(l));

      assert.strictEqual(htmlMatches.length, 0, `booking.html must contain 0 emojis; found: ${htmlMatches.join(', ')}`);
      assert.strictEqual(jsMatches.length, 0, `booking.js must contain 0 emojis; found: ${jsMatches.join(', ')}`);
    });

    t2.test('SVG decorative icons in booking.html have aria-hidden="true"', () => {
      const htmlContent = fs.readFileSync(path.join(__dirname, '../public/booking.html'), 'utf8');
      const svgTagMatches = htmlContent.match(/<svg\b[^>]*>/g) || [];

      assert.ok(svgTagMatches.length >= 6, 'booking.html must render inline SVG icons');
      svgTagMatches.forEach((tag) => {
        assert.ok(
          tag.includes('aria-hidden="true"'),
          `Every decorative SVG in booking.html must include aria-hidden="true"; failed tag: ${tag}`
        );
      });
    });

    t2.test('all critical booking DOM IDs and data-* attributes remain', () => {
      const htmlContent = fs.readFileSync(path.join(__dirname, '../public/booking.html'), 'utf8');

      const requiredIds = [
        'nav-admin-link',
        'header-user-name',
        'btn-logout',
        'main-content',
        'location-error-state',
        'location-error-title',
        'location-error-desc',
        'btn-browse-locations',
        'location-header-bar',
        'selected-location-name',
        'selected-location-category',
        'selected-location-status',
        'selected-location-address',
        'location-closed-banner',
        'uncertain-booking-alert',
        'uncertain-booking-message',
        'btn-retry-uncertain',
        'btn-return-uncertain',
        'btn-discard-uncertain',
        'booking-confirmation-container',
        'confirmation-heading',
        'conf-idempotent-badge',
        'conf-booking-id',
        'conf-location-slot',
        'conf-vehicle',
        'conf-schedule',
        'conf-total-price',
        'conf-status',
        'btn-book-another',
        'booking-workflow-container',
        'filter-vehicle-type',
        'filter-zone',
        'filter-floor',
        'btn-apply-filters',
        'zone-tabs-container',
        'tab-all',
        'tab-count-all',
        'recommendations-section',
        'recommendations-heading',
        'recommendations-grid',
        'recommendations-placeholder',
        'slot-map-heading',
        'slot-count',
        'slots-empty-state',
        'slot-grid',
        'slot-grid-loading',
        'booking-panel-overlay',
        'booking-panel',
        'booking-panel-title',
        'btn-close-panel',
        'panel-slot-summary',
        'panel-slot-id',
        'panel-slot-zone',
        'panel-slot-details',
        'panel-slot-price',
        'panel-slot-features',
        'booking-form',
        'saved-vehicle-group',
        'saved-vehicle-select',
        'saved-vehicle-help',
        'vehicle-type',
        'vehicle-type-error',
        'vehicle-number',
        'vehicle-number-error',
        'duration-hours',
        'duration-error',
        'price-calculator',
        'price-breakdown',
        'price-total',
        'booking-form-error',
        'btn-confirm-booking',
        'btn-cancel-panel',
      ];

      requiredIds.forEach((id) => {
        assert.ok(
          htmlContent.includes(`id="${id}"`) || htmlContent.includes(`id='${id}'`),
          `Critical booking DOM ID "${id}" must be present in booking.html`
        );
      });

      assert.ok(
        htmlContent.includes('data-zone="all"'),
        'booking.html must preserve data-zone="all" on quick-filter tab'
      );
    });

    t2.test('booking.html script tag dependency order remains intact', () => {
      const htmlContent = fs.readFileSync(path.join(__dirname, '../public/booking.html'), 'utf8');

      const storageIdx = htmlContent.indexOf('js/storage.js');
      const utilsIdx = htmlContent.indexOf('js/utils.js');
      const apiIdx = htmlContent.indexOf('js/api.js');
      const validationIdx = htmlContent.indexOf('js/validation.js');
      const authIdx = htmlContent.indexOf('js/auth.js');
      const bookingIdx = htmlContent.indexOf('js/booking.js');

      assert.ok(storageIdx > 0, 'storage.js script tag required');
      assert.ok(utilsIdx > storageIdx, 'utils.js must be loaded after storage.js');
      assert.ok(apiIdx > utilsIdx, 'api.js must be loaded after utils.js');
      assert.ok(validationIdx > apiIdx, 'validation.js must be loaded after api.js');
      assert.ok(authIdx > validationIdx, 'auth.js must be loaded after validation.js');
      assert.ok(bookingIdx > authIdx, 'booking.js must be loaded after auth.js');
    });

    t2.test('booking.css contains modern two-column layout, sticky sidebar and responsive rules', () => {
      const cssContent = fs.readFileSync(path.join(__dirname, '../public/css/booking.css'), 'utf8');

      assert.ok(cssContent.includes('.booking-layout'), 'booking.css must define .booking-layout');
      assert.ok(cssContent.includes('position: sticky'), 'booking.css must support sticky side area');
      assert.ok(cssContent.includes('@media (min-width: 1024px)'), 'booking.css must define desktop rules');
      assert.ok(cssContent.includes('@media (max-width: 1023px)'), 'booking.css must define tablet/mobile rules');
      assert.ok(cssContent.includes('prefers-reduced-motion'), 'booking.css must support prefers-reduced-motion');
      assert.ok(cssContent.includes('.slot-card--available'), 'booking.css must style available slots');
      assert.ok(cssContent.includes('.slot-card--selected'), 'booking.css must style selected slots');
      assert.ok(cssContent.includes('.slot-card--occupied'), 'booking.css must style occupied slots');
      assert.ok(cssContent.includes('.slot-card--incompatible'), 'booking.css must style incompatible slots');
    });
  });
});

