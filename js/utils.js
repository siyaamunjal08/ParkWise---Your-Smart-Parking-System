// Storage Module - Arpit

/* ============================================================
   js/utils.js
   Smart Parking System — Shared Utility Functions

   PURPOSE:
   Reusable helper functions shared across all page scripts.
   Organised into six groups:
     1. DOM        — element access, show/hide, form data
     2. Format     — currency, date, time, duration display
     3. Calculate  — cost, end-time, score
     4. Navigate   — redirect, query params
     5. String     — capitalise, vehicle number normalisation
     6. Toast      — in-page notification messages

   RULES:
   - No inline CSS (classList only, never element.style)
   - No inline JS (never called from HTML attributes)
   - Pure ES6 — const, arrow functions, template literals
   - Every function is independently reusable

   ============================================================ */

'use strict';


// ══════════════════════════════════════════════════════════════
// 1. DOM UTILITIES
// ══════════════════════════════════════════════════════════════

/**
 * Get a DOM element by its ID.
 * Returns null (and logs a warning) if not found.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
const getElement = (id) => {
  const el = document.getElementById(id);
  if (!el) console.warn(`[Utils] Element #${id} not found.`);
  return el;
};

/**
 * Show a hidden element by removing the `hidden` attribute.
 * @param {string} id
 */
const showElement = (id) => {
  const el = getElement(id);
  if (el) el.removeAttribute('hidden');
};

/**
 * Hide an element by setting the `hidden` attribute.
 * @param {string} id
 */
const hideElement = (id) => {
  const el = getElement(id);
  if (el) el.setAttribute('hidden', '');
};

/**
 * Set the text content of an element.
 * @param {string} id
 * @param {string} text
 */
const setText = (id, text) => {
  const el = getElement(id);
  if (el) el.textContent = text;
};

/**
 * Set the inner HTML of an element.
 * Use only for trusted, sanitised content — never raw user input.
 * @param {string} id
 * @param {string} html
 */
const setHTML = (id, html) => {
  const el = getElement(id);
  if (el) el.innerHTML = html;
};

/**
 * Show an error message inside a designated error element.
 * The element must already exist in the HTML with the given id.
 * Uses `role="alert"` + `aria-live` — no extra ARIA needed here.
 * @param {string} elementId - id of the error container div
 * @param {string} message
 */
const showError = (elementId, message) => {
  const el = getElement(elementId);
  if (!el) return;
  el.textContent = message;
  el.removeAttribute('hidden');
  el.classList.add('is-visible');
};

/**
 * Clear and hide an error element.
 * @param {string} elementId
 */
const clearError = (elementId) => {
  const el = getElement(elementId);
  if (!el) return;
  el.textContent = '';
  el.setAttribute('hidden', '');
  el.classList.remove('is-visible');
};

/**
 * Clear all error elements on the page at once.
 * Targets any element with the class `form-error`.
 */
const clearAllErrors = () => {
  document.querySelectorAll('.form-error').forEach((el) => {
    el.textContent = '';
    el.setAttribute('hidden', '');
    el.classList.remove('is-visible');
  });
};

/**
 * Extract all named input/select/textarea values from a form.
 * Returns a plain object keyed by input `name` attributes.
 * @param {string} formId
 * @returns {Object}
 */
const getFormData = (formId) => {
  const form = getElement(formId);
  if (!form) return {};
  const data   = {};
  const fields = form.querySelectorAll('input, select, textarea');
  fields.forEach((field) => {
    if (!field.name) return;
    data[field.name] = field.type === 'checkbox'
      ? field.checked
      : field.value.trim();
  });
  return data;
};

/**
 * Disable a submit button and replace its text with a loading label.
 * @param {HTMLButtonElement} btn
 * @param {string} [loadingText='Please wait…']
 */
const disableButton = (btn, loadingText = 'Please wait…') => {
  if (!btn) return;
  btn.disabled          = true;
  btn.dataset.origText  = btn.textContent;
  btn.textContent       = loadingText;
};

/**
 * Re-enable a previously disabled button and restore its label.
 * @param {HTMLButtonElement} btn
 */
const enableButton = (btn) => {
  if (!btn) return;
  btn.disabled    = false;
  btn.textContent = btn.dataset.origText ?? btn.textContent;
};

/**
 * Scroll the page to the top of a given element smoothly.
 * @param {string} id
 */
const scrollToElement = (id) => {
  const el = getElement(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};


// ══════════════════════════════════════════════════════════════
// 2. FORMAT UTILITIES
// ══════════════════════════════════════════════════════════════

/**
 * Format a number as Indian Rupees.
 * e.g. 1500 → "₹1,500.00"
 * @param {number} amount
 * @returns {string}
 */
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style:    'currency',
    currency: 'INR',
  }).format(amount);
};

/**
 * Format an ISO date string as a readable date.
 * e.g. "2026-08-08T10:30:00.000Z" → "08 Aug 2026"
 * @param {string} isoString
 * @returns {string}
 */
const formatDate = (isoString) => {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
  });
};

/**
 * Format an ISO date string as a 12-hour clock time.
 * e.g. "2026-08-08T10:30:00.000Z" → "10:30 AM"
 * @param {string} isoString
 * @returns {string}
 */
const formatTime = (isoString) => {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString('en-IN', {
    hour:   '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

/**
 * Format an ISO date string as a combined date and time.
 * e.g. "08 Aug 2026, 10:30 AM"
 * @param {string} isoString
 * @returns {string}
 */
const formatDateTime = (isoString) => {
  if (!isoString) return '—';
  return `${formatDate(isoString)}, ${formatTime(isoString)}`;
};

/**
 * Format a duration in hours into a human-readable string.
 * e.g. 1.5 → "1 hr 30 min"  |  3 → "3 hr"  |  0.5 → "30 min"
 * @param {number} hours
 * @returns {string}
 */
const formatDuration = (hours) => {
  if (!hours || hours <= 0) return '—';
  const h   = Math.floor(hours);
  const min = Math.round((hours - h) * 60);

  if (h === 0)   return `${min} min`;
  if (min === 0) return `${h} hr`;
  return `${h} hr ${min} min`;
};

/**
 * Format a vehicle number to uppercase with consistent spacing.
 * e.g. "mh12ab1234" → "MH12AB1234"
 * @param {string} vehicleNumber
 * @returns {string}
 */
const formatVehicleNumber = (vehicleNumber) => {
  return vehicleNumber.trim().toUpperCase().replace(/\s+/g, '');
};


// ══════════════════════════════════════════════════════════════
// 3. CALCULATION UTILITIES
// ══════════════════════════════════════════════════════════════

/**
 * Calculate the total parking cost.
 * @param {number} pricePerHour - slot's price per hour (INR)
 * @param {number} durationHours - booking duration in hours
 * @returns {number} total cost rounded to 2 decimal places
 */
const calculateCost = (pricePerHour, durationHours) => {
  const cost = pricePerHour * durationHours;
  return Math.round(cost * 100) / 100;
};

/**
 * Calculate the booking end time from a start time and duration.
 * @param {string} startIso - ISO string of when parking begins
 * @param {number} durationHours - duration in hours
 * @returns {string} ISO string of the end time
 */
const calculateEndTime = (startIso, durationHours) => {
  const start = new Date(startIso);
  const end   = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return end.toISOString();
};

/**
 * Calculate the AI recommendation score for a slot.
 * Higher score = better match for the user's vehicle type and preferences.
 *
 * Scoring breakdown (max 100):
 *   Type match   → 40 pts  (vehicle type matches slot type)
 *   Proximity    → 30 pts  (closer to entry = more points)
 *   Price        → 20 pts  (lower price = more points)
 *   Features     → 10 pts  (bonus for covered / ev-charging)
 *
 * @param {Object} slot        - slot document from SlotStore
 * @param {string} vehicleType - "car" | "bike" | "ev"
 * @returns {number} score 0–100
 */
const calculateRecommendationScore = (slot, vehicleType) => {
  let score = 0;

  // Type match (40 pts)
  if (slot.type === vehicleType) score += 40;
  else if (vehicleType === 'ev' && slot.type === 'car') score += 15;

  // Proximity — normalise distanceFromEntry (max assumed 200m) (30 pts)
  const maxDistance   = 200;
  const proximityPts  = Math.max(0, 30 - (slot.distanceFromEntry / maxDistance) * 30);
  score += Math.round(proximityPts);

  // Price — lower price earns more points (20 pts)
  const maxPrice  = 100;
  const pricePts  = Math.max(0, 20 - (slot.pricePerHour / maxPrice) * 20);
  score += Math.round(pricePts);

  // Features bonus (10 pts)
  const features = slot.features ?? [];
  if (features.includes('covered'))    score += 5;
  if (features.includes('ev-charging') || slot.type === 'ev') score += 5;

  return Math.min(100, score);
};

/**
 * Check whether a booking's active period has expired.
 * @param {Object} booking - booking document from BookingStore
 * @returns {boolean}
 */
const isBookingExpired = (booking) => {
  const endTime = calculateEndTime(booking.startTime, booking.durationHours);
  return new Date() > new Date(endTime);
};


// ══════════════════════════════════════════════════════════════
// 4. NAVIGATION UTILITIES
// ══════════════════════════════════════════════════════════════

/**
 * Redirect the browser to another page.
 * @param {string} path - relative path e.g. "login.html"
 */
const redirectTo = (path) => {
  window.location.href = path;
};

/**
 * Read a single query-string parameter from the current URL.
 * e.g. URL "?slotId=A-01" → getQueryParam('slotId') → "A-01"
 * @param {string} key
 * @returns {string|null}
 */
const getQueryParam = (key) => {
  const params = new URLSearchParams(window.location.search);
  return params.get(key);
};


// ══════════════════════════════════════════════════════════════
// 5. STRING / LABEL UTILITIES
// ══════════════════════════════════════════════════════════════

/**
 * Capitalise the first letter of a string.
 * e.g. "active" → "Active"
 * @param {string} str
 * @returns {string}
 */
const capitalise = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/**
 * Return the CSS modifier class for a booking or slot status.
 * Used to colour status badges without inline styles.
 * @param {string} status - "active" | "completed" | "cancelled" | "available" | "occupied" | "reserved"
 * @returns {string} CSS class name
 */
const getStatusClass = (status) => {
  const map = {
    active:    'status--active',
    available: 'status--available',
    occupied:  'status--occupied',
    reserved:  'status--reserved',
    completed: 'status--completed',
    cancelled: 'status--cancelled',
  };
  return map[status] ?? 'status--unknown';
};

/**
 * Return a human-readable label for a vehicle type.
 * @param {string} type - "car" | "bike" | "ev"
 * @returns {string}
 */
const getVehicleTypeLabel = (type) => {
  const map = {
    car:  'Car',
    bike: 'Bike / 2-Wheeler',
    ev:   'Electric Vehicle (EV)',
  };
  return map[type] ?? capitalise(type);
};

/**
 * Return the display name for a zone ID.
 * @param {string} zone - "A" | "B" | "C"
 * @returns {string}
 */
const getZoneLabel = (zone) => {
  const map = {
    A: 'Zone A — Premium',
    B: 'Zone B — Standard',
    C: 'Zone C — Economy',
  };
  return map[zone] ?? `Zone ${zone}`;
};

/**
 * Return the brand colour for a zone (matches parking.json).
 * @param {string} zone - "A" | "B" | "C"
 * @returns {string} hex colour
 */
const getZoneColor = (zone) => {
  const map = {
    A: '#6366f1',
    B: '#06b6d4',
    C: '#10b981',
  };
  return map[zone] ?? '#94a3b8';
};


// ══════════════════════════════════════════════════════════════
// 6. TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

/**
 * Ensure a toast container exists in the DOM.
 * Creates one and appends it to <body> if absent.
 * Styled by .toast-container in each page's CSS file.
 * @returns {HTMLElement}
 */
const getToastContainer = () => {
  let container = document.getElementById('toast-container');
  if (!container) {
    container       = document.createElement('div');
    container.id    = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
  }
  return container;
};

/**
 * Display a temporary toast notification.
 * Auto-dismisses after `duration` milliseconds.
 * Styled by .toast and .toast--{type} in the page's CSS file.
 *
 * @param {string} message          - text to display
 * @param {'success'|'error'|'info'|'warning'} [type='info']
 * @param {number} [duration=3500]  - ms before auto-dismiss
 */
const showToast = (message, type = 'info', duration = 3500) => {
  const container = getToastContainer();

  const toast = document.createElement('div');
  toast.classList.add('toast', `toast--${type}`);
  toast.setAttribute('role', 'status');
  toast.textContent = message;

  container.appendChild(toast);

  // Trigger enter animation via class (CSS handles the transition)
  requestAnimationFrame(() => {
    toast.classList.add('toast--visible');
  });

  // Auto-remove after duration
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    toast.classList.add('toast--hiding');

    // Remove from DOM after the CSS exit transition finishes (300ms)
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
};
