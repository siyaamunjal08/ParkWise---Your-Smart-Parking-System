/* ============================================================
   js/history.js
   Smart Parking System — Booking History Page Controller

   PURPOSE:
   Owns all DOM interaction for history.html.
   Loads the current user's complete booking history, supports
   real-time search, status tab filtering, multi-option sort,
   paginated load-more, and active booking cancellation.
   Also auto-completes expired active bookings on page load.

   DEPENDS ON (loaded before this file):
     - js/storage.js    → BookingStore, SlotStore, SessionStore
     - js/utils.js      → getElement, setText, showElement,
                          hideElement, showToast,
                          formatCurrency, formatDateTime,
                          formatTime, formatDuration,
                          calculateEndTime, isBookingExpired,
                          getStatusClass, getVehicleTypeLabel,
                          getZoneLabel, capitalise
     - js/validation.js → (loaded for completeness, unused here)
     - js/auth.js       → requireAuth, logoutUser, getSession

   FLOW:
     1. requireAuth()            — redirect if no session
     2. autoCompleteExpired()    — mark timed-out actives as done
     3. populateUserInfo()       — fill header user name
     4. loadStats()              — fill 4 summary stat values + tab counts
     5. renderHistoryList()      — build cards based on current state
     6. Event listeners          — search (debounced), sort, tabs, cancel,
                                   load-more, logout

   PAGINATION:
     PAGE_SIZE cards shown at a time. Load More adds PAGE_SIZE more.
     Filters/sort/search always reset to page 1.

   DOES NOT:
     - Use inline CSS or inline event handlers
     - Modify previously created files
     - Contain validation logic (handled in validation.js)

   MERN MIGRATION:
   Replace BookingStore.findByUser() with GET /api/bookings?userId=.
   Replace BookingStore.cancel() with PUT /api/bookings/:id/cancel.
   Replace BookingStore.complete() with PUT /api/bookings/:id/complete.
   This file becomes a React HistoryPage component.
   ============================================================ */

'use strict';

// ── Step 1: Auth Guard ────────────────────────────────────────
requireAuth();


// ══════════════════════════════════════════════════════════════
// CONSTANTS & STATE
// ══════════════════════════════════════════════════════════════

/** Number of booking cards shown per page. */
// const PAGE_SIZE = 8;

/** Mutable page state — reset on any filter/sort/search change. */
const state = {
  activeStatus: 'all',
  searchQuery: '',
  sortOrder: 'newest'
};


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Escape a string for safe innerHTML insertion.
 * @param {string} str
 * @returns {string}
 */
const escapeHTML = (str) => {
  const div       = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
};

/**
 * Show a field error element with a message.
 * @param {HTMLElement} el
 * @param {string}      message
 */
const showHistoryError = (el, message) => {
  if (!el) return;
  el.textContent = message;
  el.removeAttribute('hidden');
};

/**
 * Simple debounce — returns a function that delays calling `fn`
 * by `delayMs` ms each time it is called.
 * @param {Function} fn
 * @param {number}   delayMs
 * @returns {Function}
 */
const debounce = (fn, delayMs) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
};


// ══════════════════════════════════════════════════════════════
// STEP 2: AUTO-COMPLETE EXPIRED BOOKINGS
// ══════════════════════════════════════════════════════════════

/**
 * Scan all active bookings for the current user.
 * Any booking whose calculated end-time has passed is automatically
 * marked 'completed' and its slot is released back to 'available'.
 *
 * This simulates the server-side cron job that would run in MERN.
 * MERN MIGRATION: Remove this function entirely — the server handles it.
 */
const autoCompleteExpired = () => {
  const userId         = SessionStore.getUserId();
  const activeBookings = BookingStore.findActiveByUser(userId);

  activeBookings.forEach(booking => {
    if (!isBookingExpired(booking)) return;

    BookingStore.complete(booking._id);
    SlotStore.release(booking.slotId);
  });
};


// ══════════════════════════════════════════════════════════════
// STEP 3: USER INFO
// ══════════════════════════════════════════════════════════════

const populateUserInfo = () => {
  const session = getSession();
  if (!session) return;
  const firstName = session.name.trim().split(' ')[0];
  setText('header-user-name', `Hi, ${firstName}`);
};


// ══════════════════════════════════════════════════════════════
// STEP 4: STATS & TAB COUNTS
// ══════════════════════════════════════════════════════════════

/**
 * Calculate booking counts by status and update:
 *   - The 4 summary stat cards
 *   - The 4 status tab count badges
 */
const loadStats = () => {
  const userId   = SessionStore.getUserId();
  const bookings = BookingStore.findByUser(userId);

  const counts = {
    total:     bookings.length,
    active:    bookings.filter(b => b.status === 'active').length,
    completed: bookings.filter(b => b.status === 'completed').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
  };

  // Summary stat cards
  setText('stat-total',     counts.total);
  setText('stat-active',    counts.active);
  setText('stat-completed', counts.completed);
  setText('stat-cancelled', counts.cancelled);

  // Tab count badges
  setText('tab-count-all',       counts.total);
  setText('tab-count-active',    counts.active);
  setText('tab-count-completed', counts.completed);
  setText('tab-count-cancelled', counts.cancelled);
};


// ══════════════════════════════════════════════════════════════
// FILTERING, SORTING, SEARCHING
// ══════════════════════════════════════════════════════════════

/**
 * Return the user's bookings after applying status filter,
 * search query, and sort order from current state.
 * @returns {Array} processed booking list
 */
const getProcessedBookings = () => {
  const userId = SessionStore.getUserId();
  let bookings = BookingStore.findByUser(userId);

  // Status filter
  if (state.activeStatus !== 'all') {
    bookings = bookings.filter(b => b.status === state.activeStatus);
  }

  // Search filter
  const q = state.searchQuery.trim().toLowerCase();

  if (q) {
    bookings = bookings.filter(b => {
      return (
        b.slotId.toLowerCase().includes(q) ||
        b.vehicleNumber.toLowerCase().includes(q) ||
        b.zone.toLowerCase().includes(q) ||
        b.vehicleType.toLowerCase().includes(q)
      );
    });
  }

  // Sort
  switch (state.sortOrder) {
    case 'oldest':
      bookings.sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
      break;

    case 'cost-high':
      bookings.sort((a, b) => b.totalCost - a.totalCost);
      break;

    case 'cost-low':
      bookings.sort((a, b) => a.totalCost - b.totalCost);
      break;

    case 'duration-high':
      bookings.sort((a, b) => b.durationHours - a.durationHours);
      break;

    case 'newest':
    default:
      bookings.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      break;
  }

  return bookings;
};


// ══════════════════════════════════════════════════════════════
// HISTORY CARD BUILDER
// ══════════════════════════════════════════════════════════════

/**
 * Determine the vehicle type emoji icon.
 * @param {'car'|'bike'|'ev'} type
 * @returns {string}
 */
const getVehicleIcon = (type) => {
  const icons = { car: '🚗', bike: '🏍️', ev: '⚡' };
  return icons[type] ?? '🚘';
};

/**
 * Build a single .history-card <article> element from a booking document.
 * All user-sourced strings are escaped through escapeHTML.
 * @param {Object} booking
 * @returns {HTMLElement}
 */
const createHistoryCard = (booking) => {
  const endTime     = calculateEndTime(booking.startTime, booking.durationHours);
  const statusClass = getStatusClass(booking.status);
  const isActive    = booking.status === 'active';
  const isCancelled = booking.status === 'cancelled';
  const expired     = isActive && isBookingExpired(booking);

  const article = document.createElement('article');
  article.classList.add('history-card');
  article.dataset.status = booking.status;
  article.dataset.id     = booking._id;

  // ── Header ────────────────────────────────────────────────
  const headerHTML = `
    <div class="history-card__header">
      <span class="history-card__slot-id">Slot ${escapeHTML(booking.slotId)}</span>
      <span class="status-badge ${escapeHTML(statusClass)}">
        ${escapeHTML(capitalise(booking.status))}
      </span>
      <p class="history-card__date">
        ${escapeHTML(formatDateTime(booking.createdAt))}
      </p>
    </div>
  `;

  // ── Meta items ────────────────────────────────────────────
  const metaItems = [
    `<span class="history-card__meta-item">
      <span aria-hidden="true">${escapeHTML(getVehicleIcon(booking.vehicleType))}</span>
      <strong>${escapeHTML(getVehicleTypeLabel(booking.vehicleType))}</strong>
    </span>`,
    `<span class="history-card__meta-item">
      🔢 ${escapeHTML(booking.vehicleNumber)}
    </span>`,
    `<span class="history-card__meta-item">
      📍 ${escapeHTML(getZoneLabel(booking.zone))}
    </span>`,
    `<span class="history-card__meta-item">
      ⏱ ${escapeHTML(formatDuration(booking.durationHours))}
    </span>`,
    `<span class="history-card__meta-item">
      From: ${escapeHTML(formatTime(booking.startTime))}
    </span>`,
    `<span class="history-card__meta-item">
      Until: ${escapeHTML(formatTime(endTime))}
    </span>`,
  ].join('');

  // ── Footer — cost + cancel (active only) ──────────────────
  const cancelBtn = isActive
    ? `<button
         type="button"
         class="btn-cancel"
         data-booking-id="${escapeHTML(booking._id)}"
         ${expired ? 'disabled aria-disabled="true" title="Booking period has expired."' : ''}
         aria-label="Cancel booking for slot ${escapeHTML(booking.slotId)}"
       >
         Cancel
       </button>`
    : '';

  const footerHTML = `
    <div class="history-card__footer">
      <p class="history-card__cost"
         ${isCancelled ? 'aria-label="Refunded — booking was cancelled"' : ''}>
        ${escapeHTML(formatCurrency(booking.totalCost))}
      </p>
      ${cancelBtn}
    </div>
  `;

  article.innerHTML = `
    ${headerHTML}
    <div class="history-card__meta">${metaItems}</div>
    ${footerHTML}
  `;

  return article;
};


// ══════════════════════════════════════════════════════════════
// STEP 5: RENDER HISTORY LIST
// ══════════════════════════════════════════════════════════════

/**
 * Render the history list — applies all filters, sorts, paginates,
 * then injects cards into #history-list.
 * Updates the results count line and Load More button visibility.
 */
const renderHistoryList = () => {
  const historyListEl  = getElement('history-list');
  const emptyStateEl   = getElement('history-empty-state');
  // const paginationEl   = getElement('history-pagination');
  const resultsCountEl = getElement('results-count');

  if (!historyListEl) return;

  const allFiltered  = getProcessedBookings();
  const totalCount   = allFiltered.length;
  const visibleSlice = allFiltered;

  // ── Results count line ────────────────────────────────────
  if (resultsCountEl) {
    if (totalCount === 0) {
      resultsCountEl.textContent = '';
    } else {
      resultsCountEl.textContent =
  `${totalCount} booking${totalCount !== 1 ? 's' : ''} found`;
    }
  }

  // ── Empty state ───────────────────────────────────────────
  // Remove previously rendered cards (but keep the empty state element)
  const existingCards = historyListEl.querySelectorAll('.history-card');
  existingCards.forEach(c => c.remove());

  if (totalCount === 0) {
    emptyStateEl?.removeAttribute('hidden');
    // paginationEl?.setAttribute('hidden', '');
    return;
  }

  emptyStateEl?.setAttribute('hidden', '');

  // ── Render visible cards ──────────────────────────────────
  visibleSlice.forEach(booking => {
    historyListEl.appendChild(createHistoryCard(booking));
  });

  // ── Load More visibility ──────────────────────────────────
//   if (totalCount > state.visibleCount) {
//     paginationEl?.removeAttribute('hidden');
//   } else {
//     paginationEl?.setAttribute('hidden', '');
//   }
};


// ══════════════════════════════════════════════════════════════
// CANCEL BOOKING
// ══════════════════════════════════════════════════════════════

/**
 * Handle cancellation of an active booking from the history list.
 * Cancels the record, releases the slot, refreshes stats and list.
 * @param {string}           bookingId
 * @param {HTMLButtonElement} btn
 */
const handleCancelBooking = (bookingId, btn) => {
  const confirmed = window.confirm(
    'Are you sure you want to cancel this booking?\nThis cannot be undone.'
  );
  if (!confirmed) return;

  btn.disabled = true;

  const booking = BookingStore.findById(bookingId);
  if (!booking || booking.status !== 'active') {
    showToast('This booking is no longer active.', 'error');
    btn.disabled = false;
    return;
  }

  const cancelled = BookingStore.cancel(bookingId);
  if (!cancelled) {
    showToast('Could not cancel the booking. Please try again.', 'error');
    btn.disabled = false;
    return;
  }

  SlotStore.release(booking.slotId);

  // Full refresh: stats + list
  loadStats();
  renderHistoryList();

  showToast(`Booking for Slot ${booking.slotId} cancelled.`, 'success');
};


// ══════════════════════════════════════════════════════════════
// STATUS TABS
// ══════════════════════════════════════════════════════════════

const allTabs = ['tab-all', 'tab-active', 'tab-completed', 'tab-cancelled']
  .map(id => getElement(id))
  .filter(Boolean);

/**
 * Activate a status tab — update aria-pressed on all tabs,
 * update state, reset pagination, and re-render the list.
 * @param {HTMLButtonElement} tab
 */
const activateStatusTab = (tab) => {
  allTabs.forEach(t => t.setAttribute('aria-pressed', t === tab ? 'true' : 'false'));

  state.activeStatus = tab.dataset.status ?? 'all';
  // state.visibleCount = PAGE_SIZE;

  renderHistoryList();
};

allTabs.forEach(tab => tab.addEventListener('click', () => activateStatusTab(tab)));


// ══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

// ── Search (debounced 300ms) ──────────────────────────────
const searchInputEl = getElement('search-input');
searchInputEl?.addEventListener('input', debounce((event) => {
  state.searchQuery  = event.target.value;
  // state.visibleCount = PAGE_SIZE;
  renderHistoryList();
}, 300));

// ── Sort dropdown ─────────────────────────────────────────
const sortSelectEl = getElement('sort-select');
sortSelectEl?.addEventListener('change', (event) => {
  state.sortOrder    = event.target.value;

  // state.visibleCount = PAGE_SIZE;
  renderHistoryList();
});

// ── Cancel button — event delegation on the list ──────────
getElement('history-list')?.addEventListener('click', (event) => {
  const cancelBtn = event.target.closest('.btn-cancel');
  if (!cancelBtn || cancelBtn.disabled) return;
  const bookingId = cancelBtn.dataset.bookingId;
  if (bookingId) handleCancelBooking(bookingId, cancelBtn);
});

// // ── Load More ─────────────────────────────────────────────
// getElement('btn-load-more')?.addEventListener('click', () => {
//   // state.visibleCount += PAGE_SIZE;
//   renderHistoryList();
// });

// ── Logout ────────────────────────────────────────────────
getElement('btn-logout')?.addEventListener('click', logoutUser);


// ══════════════════════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════════════════════

/**
 * Bootstrap the history page:
 *   1. Auto-complete any expired active bookings (client-side cron)
 *   2. Populate header user name
 *   3. Load + display summary stats and tab counts
 *   4. Render the initial full history list (newest first, all statuses)
 */
const initHistoryPage = () => {
  autoCompleteExpired();
  populateUserInfo();
  loadStats();
  renderHistoryList();
};

initHistoryPage();
