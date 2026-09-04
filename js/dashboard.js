// Dashboard Module - Siya

/* ============================================================
   js/dashboard.js
   Smart Parking System — Dashboard Page Controller

   PURPOSE:
   Owns all DOM interaction for dashboard.html.
   Seeds slot data, loads user info, renders stats, renders
   active booking cards, and handles cancel + logout.

   DEPENDS ON (loaded before this file via dashboard.html):
     - js/storage.js    → SlotStore, BookingStore, SessionStore
     - js/utils.js      → getElement, setText, showToast,
                          formatCurrency, formatTime, formatDateTime,
                          formatDuration, calculateEndTime,
                          isBookingExpired, getStatusClass,
                          getVehicleTypeLabel, getZoneLabel,
                          capitalise, redirectTo
     - js/validation.js → (loaded for completeness, unused here)
     - js/auth.js       → requireAuth, logoutUser, getSession

   FLOW:
     1. requireAuth()       — redirect to login if no session
     2. seedSlotsIfNeeded() — fetch parking.json, seed localStorage
     3. populateUserInfo()  — fill header name + welcome banner
     4. loadStats()         — calculate and display 4 stat cards
     5. renderActiveBookings() — build booking cards or empty state
     6. Event listeners     — logout button, cancel buttons



   ============================================================ */

'use strict';

// ── Step 1: Auth Guard ────────────────────────────────────────
requireAuth();


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Escape a string for safe insertion into innerHTML.
 * Prevents XSS from tampered localStorage values.
 * @param {string} str
 * @returns {string}
 */
const escapeHTML = (str) => {
  const div       = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
};

/**
 * Get the first name from a full name string.
 * "Arpit Jain" → "Arpit"
 * @param {string} fullName
 * @returns {string}
 */
const getFirstName = (fullName) => {
  return fullName ? fullName.trim().split(' ')[0] : 'there';
};


// ══════════════════════════════════════════════════════════════
// STEP 2: SEED SLOTS FROM parking.json
// ══════════════════════════════════════════════════════════════

/**
 * Fetch parking.json and seed the SlotStore if it is empty.
 * Seeding is idempotent: SlotStore.seed() skips if already seeded.
 * @returns {Promise<void>}
 */
const seedSlotsIfNeeded = async () => {
  if (SlotStore.getAll().length > 0) return; // already seeded

  try {
    const response = await fetch('data/parking.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    SlotStore.seed(data.slots);
  } catch (err) {
    console.error('[Dashboard] Failed to seed slots:', err);
    showToast('Could not load parking data. Some stats may be unavailable.', 'warning');
  }
};


// ══════════════════════════════════════════════════════════════
// STEP 3: POPULATE USER INFO
// ══════════════════════════════════════════════════════════════

/**
 * Fill the header greeting and welcome banner with the
 * current user's name and login time from the session.
 */
const populateUserInfo = () => {
  const session = getSession();
  if (!session) return;

  const firstName = getFirstName(session.name);

  setText('header-user-name', `Hi, ${firstName}`);
  setText('welcome-name',     firstName);
  setText('welcome-meta',     `Last login: ${formatDateTime(session.loginAt)}`);
};


// ══════════════════════════════════════════════════════════════
// STEP 4: LOAD STATS
// ══════════════════════════════════════════════════════════════

/**
 * Calculate and display the 4 stat card values:
 *   - Total bookings (all time)
 *   - Active bookings (status === "active")
 *   - Available parking slots
 *   - Total money spent (excluding cancelled bookings)
 */
const loadStats = () => {
  const userId = SessionStore.getUserId();

  const allBookings    = BookingStore.findByUser(userId);
  const activeBookings = BookingStore.findActiveByUser(userId);
  const availableSlots = SlotStore.getAvailable();

  // Sum cost of all non-cancelled bookings
  const totalSpent = allBookings
    .filter(b => b.status !== 'cancelled')
    .reduce((sum, b) => sum + (b.totalCost ?? 0), 0);

  setText('stat-total-bookings',  allBookings.length);
  setText('stat-active-bookings', activeBookings.length);
  setText('stat-available-slots', availableSlots.length);
  setText('stat-total-spent',     formatCurrency(totalSpent));
  setText('active-bookings-count', activeBookings.length);
};


// ══════════════════════════════════════════════════════════════
// STEP 5: RENDER ACTIVE BOOKINGS
// ══════════════════════════════════════════════════════════════

/**
 * Build an <article> DOM element for a single active booking.
 * All user-supplied strings are escaped before insertion.
 * @param {Object} booking - booking document from BookingStore
 * @returns {HTMLElement}
 */
const createBookingCard = (booking) => {
  const endTime     = calculateEndTime(booking.startTime, booking.durationHours);
  const expired     = isBookingExpired(booking);
  const statusClass = getStatusClass(booking.status);

  const article = document.createElement('article');
  article.classList.add('booking-card');
  article.dataset.status = escapeHTML(booking.status);
  article.dataset.id     = escapeHTML(booking._id);

  // Build meta items safely
  const metaItems = [
    `<span>${escapeHTML(getVehicleTypeLabel(booking.vehicleType))}: <strong>${escapeHTML(booking.vehicleNumber)}</strong></span>`,
    `<span>${escapeHTML(getZoneLabel(booking.zone))}</span>`,
    `<span>Duration: ${escapeHTML(formatDuration(booking.durationHours))}</span>`,
    `<span>From: ${escapeHTML(formatTime(booking.startTime))}</span>`,
    `<span>Until: ${escapeHTML(formatTime(endTime))}</span>`,
  ].join('');

  article.innerHTML = `
    <div class="booking-card__info">
      <p class="booking-card__slot">Slot ${escapeHTML(booking.slotId)}</p>
      <div class="booking-card__meta">${metaItems}</div>
      <p class="booking-card__cost">${escapeHTML(formatCurrency(booking.totalCost))}</p>
    </div>
    <div class="booking-card__actions">
      <span class="status-badge ${escapeHTML(statusClass)}">
        ${escapeHTML(capitalise(booking.status))}
      </span>
      <button
        type="button"
        class="btn-cancel"
        data-booking-id="${escapeHTML(booking._id)}"
        ${expired ? 'disabled aria-disabled="true" title="This booking period has expired."' : ''}
        aria-label="Cancel booking for slot ${escapeHTML(booking.slotId)}"
      >
        Cancel
      </button>
    </div>
  `;

  return article;
};

/**
 * Render all active bookings for the current user into
 * #active-bookings-list. Shows the empty state if there are none.
 */
const renderActiveBookings = () => {
  const userId         = SessionStore.getUserId();
  const activeBookings = BookingStore.findActiveByUser(userId);
  const listEl         = getElement('active-bookings-list');
  const emptyMsg       = getElement('no-bookings-msg');

  if (activeBookings.length === 0) {
    // Ensure the empty state is visible
    if (emptyMsg) emptyMsg.removeAttribute('hidden');
    return;
  }

  // Remove the empty state placeholder
  if (emptyMsg) emptyMsg.setAttribute('hidden', '');

  // Clear any previous render before re-rendering
  const existingCards = listEl.querySelectorAll('.booking-card');
  existingCards.forEach(card => card.remove());

  // Render each active booking
  activeBookings.forEach(booking => {
    listEl.appendChild(createBookingCard(booking));
  });
};


// ══════════════════════════════════════════════════════════════
// CANCEL BOOKING
// ══════════════════════════════════════════════════════════════

/**
 * Handle cancellation of a booking.
 * Cancels the booking record and releases the slot back to available.
 * Re-renders stats and the bookings list after success.
 * @param {string}           bookingId
 * @param {HTMLButtonElement} btn       - the cancel button (to disable during op)
 */
const handleCancelBooking = (bookingId, btn) => {
  const confirmed = window.confirm(
    'Are you sure you want to cancel this booking?\nThis cannot be undone.'
  );
  if (!confirmed) return;

  // Disable button immediately to prevent double-click
  btn.disabled = true;

  // 1. Fetch the booking to get the slotId before cancelling
  const booking = BookingStore.findById(bookingId);
  if (!booking || booking.status !== 'active') {
    showToast('This booking is no longer active.', 'error');
    btn.disabled = false;
    return;
  }

  // 2. Cancel the booking record
  const cancelled = BookingStore.cancel(bookingId);
  if (!cancelled) {
    showToast('Could not cancel the booking. Please try again.', 'error');
    btn.disabled = false;
    return;
  }

  // 3. Release the parking slot back to available
  SlotStore.release(booking.slotId);

  // 4. Refresh UI
  loadStats();
  renderActiveBookings();

  showToast(`Booking for Slot ${booking.slotId} has been cancelled.`, 'success');
};


// ══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

// Logout button
getElement('btn-logout').addEventListener('click', logoutUser);

// Cancel buttons — event delegation on the bookings list container.
// This handles cancel buttons on cards that are created dynamically.
getElement('active-bookings-list').addEventListener('click', (event) => {
  const cancelBtn = event.target.closest('.btn-cancel');
  if (!cancelBtn || cancelBtn.disabled) return;

  const bookingId = cancelBtn.dataset.bookingId;
  if (!bookingId) return;

  handleCancelBooking(bookingId, cancelBtn);
});


// ══════════════════════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════════════════════

/**
 * Bootstrap the dashboard:
 *   1. Seed slots from parking.json (async, waits for fetch)
 *   2. Populate user info (sync)
 *   3. Load stat cards (sync)
 *   4. Render booking cards (sync)
 */
const initDashboard = async () => {
  await seedSlotsIfNeeded();
  populateUserInfo();
  loadStats();
  renderActiveBookings();
};

initDashboard();
