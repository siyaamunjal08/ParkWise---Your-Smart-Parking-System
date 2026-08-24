/* ============================================================
   js/booking.js
   Smart Parking System — Booking Page Controller

   PURPOSE:
   Owns all DOM interaction for booking.html.
   Seeds slot data, renders the parking map, handles filters,
   zone tabs, AI recommendations, the booking panel drawer,
   live price calculation, and booking form submission.

   DEPENDS ON (loaded before this file):
     - js/storage.js    → SlotStore, BookingStore, SessionStore
     - js/utils.js      → getElement, setText, showToast,
                          disableButton, enableButton,
                          formatCurrency, formatTime,
                          calculateCost, calculateEndTime,
                          calculateRecommendationScore,
                          getVehicleTypeLabel, getZoneLabel,
                          capitalise, formatVehicleNumber, redirectTo
     - js/validation.js → validateBookingForm
     - js/auth.js       → requireAuth, logoutUser, getSession

   FLOW:
     1. requireAuth()         — redirect if not logged in
     2. seedSlotsIfNeeded()   — fetch parking.json, seed localStorage
     3. populateUserInfo()    — fill header user name
     4. updateZoneCounts()    — fill tab count badges
     5. renderSlotGrid()      — render all slot cards
     6. (on vehicleType change) renderRecommendations()
     7. Panel open → fillPanelSummary() → updatePriceCalculator()
     8. Form submit → validate → BookingStore.create()
                   → SlotStore.occupy() → redirect dashboard

   DOES NOT:
     - Contain business logic or validation rules
     - Use inline event handlers (never onclick="..." in HTML)
     - Set inline CSS (classList only)

   MERN MIGRATION:
   Replace SlotStore / BookingStore calls with Axios requests.
   GET /api/slots  →  renderSlotGrid
   POST /api/bookings  →  form submit handler
   This file becomes a React BookingPage component.
   ============================================================ */

'use strict';

// ── Step 1: Auth Guard ────────────────────────────────────────
requireAuth();


// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

/** Currently selected slot object (null if none selected). */
let selectedSlot = null;

/** Active filter values applied to the slot grid. */
const activeFilters = {
  vehicleType: 'all',
  zone:        'all',
  floor:       'all',
};


// ══════════════════════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════════════════════

const filterVehicleTypeEl      = getElement('filter-vehicle-type');
const filterZoneEl             = getElement('filter-zone');
const filterFloorEl            = getElement('filter-floor');
const btnApplyFilters          = getElement('btn-apply-filters');

const tabAll                   = getElement('tab-all');
const tabA                     = getElement('tab-a');
const tabB                     = getElement('tab-b');
const tabC                     = getElement('tab-c');
const zoneTabs                 = [tabAll, tabA, tabB, tabC].filter(Boolean);

const slotGridEl               = getElement('slot-grid');
const slotCountEl              = getElement('slot-count');

const recommendationsGridEl    = getElement('recommendations-grid');
const recommendationsHolder    = getElement('recommendations-placeholder');

const panelOverlay             = getElement('booking-panel-overlay');
const bookingPanel             = getElement('booking-panel');
const btnClosePanel            = getElement('btn-close-panel');
const btnCancelPanel           = getElement('btn-cancel-panel');

const panelSlotIdEl            = getElement('panel-slot-id');
const panelSlotZoneEl          = getElement('panel-slot-zone');
const panelSlotDetailsEl       = getElement('panel-slot-details');
const panelSlotPriceEl         = getElement('panel-slot-price');
const panelSlotFeaturesEl      = getElement('panel-slot-features');

const bookingFormEl            = getElement('booking-form');
const vehicleTypeSelectEl      = getElement('vehicle-type');
const vehicleNumberInputEl     = getElement('vehicle-number');
const durationSelectEl         = getElement('duration-hours');

const priceTotalEl             = getElement('price-total');
const priceBreakdownEl         = getElement('price-breakdown');

const btnConfirm               = getElement('btn-confirm-booking');

const vehicleTypeErrorEl       = getElement('vehicle-type-error');
const vehicleNumberErrorEl     = getElement('vehicle-number-error');
const durationErrorEl          = getElement('duration-error');


// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Escape a string for safe insertion into innerHTML.
 * Guards against XSS from tampered localStorage values.
 * @param {string} str
 * @returns {string}
 */
const escapeHTML = (str) => {
  const div       = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
};

/**
 * Return the emoji icon for a vehicle type.
 * @param {'car'|'bike'|'ev'} type
 * @returns {string}
 */
const getTypeIcon = (type) => {
  const icons = { car: '🚗', bike: '🏍️', ev: '⚡' };
  return icons[type] ?? '🅿️';
};

// ── Field-level error display ─────────────────────────────────

const showFieldError = (errorEl, inputEl, message) => {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.removeAttribute('hidden');
  inputEl?.setAttribute('aria-invalid', 'true');
};

const clearFieldError = (errorEl, inputEl) => {
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.setAttribute('hidden', '');
  inputEl?.removeAttribute('aria-invalid');
};

const clearAllFormErrors = () => {
  clearFieldError(vehicleTypeErrorEl,   vehicleTypeSelectEl);
  clearFieldError(vehicleNumberErrorEl, vehicleNumberInputEl);
  clearFieldError(durationErrorEl,      durationSelectEl);
};


// ══════════════════════════════════════════════════════════════
// STEP 2: SEED SLOTS
// ══════════════════════════════════════════════════════════════

/**
 * Fetch parking.json and seed SlotStore if empty.
 * Mirrors MERN pattern of GET /api/slots on first load.
 * @returns {Promise<void>}
 */
const seedSlotsIfNeeded = async () => {
  if (SlotStore.getAll().length > 0) return;
  try {
    const response = await fetch('data/parking.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    SlotStore.seed(data.slots);
  } catch (err) {
    console.error('[Booking] Failed to seed slots:', err);
    showToast('Could not load parking data. Please refresh.', 'error');
  }
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
// STEP 4: ZONE TAB COUNTS
// ══════════════════════════════════════════════════════════════

/**
 * Update the available-slot count badge on every zone tab.
 */
const updateZoneCounts = () => {
  setText('tab-count-all', SlotStore.countAvailable());
  setText('tab-count-a',   SlotStore.countAvailable({ zone: 'A' }));
  setText('tab-count-b',   SlotStore.countAvailable({ zone: 'B' }));
  setText('tab-count-c',   SlotStore.countAvailable({ zone: 'C' }));
};


// ══════════════════════════════════════════════════════════════
// STEP 5: SLOT GRID (PARKING MAP)
// ══════════════════════════════════════════════════════════════

/**
 * Apply activeFilters to the full slot list and return matches.
 * @returns {Array}
 */
const getFilteredSlots = () => {
  let slots = SlotStore.getAll();

  if (activeFilters.vehicleType !== 'all') {
    slots = slots.filter(s => s.type === activeFilters.vehicleType);
  }
  if (activeFilters.zone !== 'all') {
    slots = slots.filter(s => s.zone === activeFilters.zone);
  }
  if (activeFilters.floor !== 'all') {
    slots = slots.filter(s => s.floor === activeFilters.floor);
  }

  return slots;
};

/**
 * Build and inject a single slot card DOM element.
 * @param {Object} slot
 * @returns {HTMLElement}
 */
const createSlotCard = (slot) => {
  const isSelected  = selectedSlot && selectedSlot._id === slot._id;
  const isAvailable = slot.status === 'available';

  const card = document.createElement('div');
  card.classList.add('slot-card', `slot-card--${slot.status}`);
  if (isSelected) card.classList.add('slot-card--selected');

  card.dataset.id     = slot._id;
  card.dataset.zone   = slot.zone;
  card.dataset.status = slot.status;
  card.dataset.type   = slot.type;

  card.setAttribute('role', 'listitem');
  card.setAttribute(
    'aria-label',
    `Slot ${slot.id}, Zone ${slot.zone}, ${capitalise(slot.status)}, ₹${slot.pricePerHour} per hour`
  );

  if (isAvailable) {
    card.setAttribute('tabindex',     '0');
    card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  } else {
    card.setAttribute('tabindex',     '-1');
    card.setAttribute('aria-disabled', 'true');
  }

  card.innerHTML = `
    <span class="slot-card__icon" aria-hidden="true">${escapeHTML(getTypeIcon(slot.type))}</span>
    <span class="slot-card__id">${escapeHTML(slot.id)}</span>
    <span class="slot-card__price">₹${escapeHTML(String(slot.pricePerHour))}/hr</span>
    <span class="slot-card__zone-strip" aria-hidden="true"></span>
  `;

  return card;
};

/**
 * Render the full slot grid based on active filters.
 * Preserves the selected slot highlight if it is in the result set.
 */
const renderSlotGrid = () => {
  const slots          = getFilteredSlots();
  const availableCount = slots.filter(s => s.status === 'available').length;

  setText('slot-count', `${availableCount} available of ${slots.length}`);

  slotGridEl.innerHTML = '';

  if (slots.length === 0) {
    const empty = document.createElement('div');
    empty.classList.add('empty-state');
    empty.innerHTML = `
      <p class="empty-state__icon" aria-hidden="true">🔍</p>
      <p class="empty-state__title">No slots match your filters</p>
      <p>Try adjusting the filters or selecting a different zone.</p>
    `;
    slotGridEl.appendChild(empty);
    return;
  }

  slots.forEach(slot => slotGridEl.appendChild(createSlotCard(slot)));
};


// ══════════════════════════════════════════════════════════════
// AI RECOMMENDATIONS
// ══════════════════════════════════════════════════════════════

const RANK_CLASSES = [
  'recommendation-card__rank--1',
  'recommendation-card__rank--2',
  'recommendation-card__rank--3',
];
const RANK_LABELS = ['1st', '2nd', '3rd'];

/**
 * Build a single recommendation card element.
 * @param {Object} slot
 * @param {number} score
 * @param {number} rank  - 0-indexed rank
 * @returns {HTMLElement}
 */
const createRecommendationCard = (slot, score, rank) => {
  const scoreClass = score >= 70 ? 'score-badge--high' : 'score-badge--mid';

  const features = (slot.features ?? [])
    .map(f => `<span class="feature-tag">${escapeHTML(capitalise(f.replace(/-/g, ' ')))}</span>`)
    .join('');

  const card = document.createElement('article');
  card.classList.add('recommendation-card');
  card.dataset.slotId = slot._id;

  card.innerHTML = `
    <div class="recommendation-card__rank ${escapeHTML(RANK_CLASSES[rank])}"
         aria-label="Ranked ${escapeHTML(RANK_LABELS[rank])}">
      ${rank + 1}
    </div>
    <div class="recommendation-card__header">
      <span class="recommendation-card__slot-id">Slot ${escapeHTML(slot.id)}</span>
      <span class="score-badge ${escapeHTML(scoreClass)}" aria-label="AI score ${escapeHTML(String(score))} out of 100">
        Score: ${escapeHTML(String(score))}
      </span>
    </div>
    <div class="recommendation-card__meta">
      <span>${escapeHTML(getZoneLabel(slot.zone))}</span>
      <span>${escapeHTML(getVehicleTypeLabel(slot.type))}</span>
      <span>${escapeHTML(String(slot.distanceFromEntry))}m from entry</span>
    </div>
    <p class="recommendation-card__price">₹${escapeHTML(String(slot.pricePerHour))}/hr</p>
    <div class="recommendation-card__features">${features}</div>
    <button
      type="button"
      class="btn-select-slot"
      data-slot-id="${escapeHTML(slot._id)}"
      aria-label="Select slot ${escapeHTML(slot.id)}, ranked ${escapeHTML(RANK_LABELS[rank])}"
    >
      Select This Slot
    </button>
  `;

  return card;
};

/**
 * Score available slots for the selected vehicle type,
 * sort by score, and render the top 3 as recommendation cards.
 */
const renderRecommendations = () => {
  const vehicleType = activeFilters.vehicleType;

  // Remove all previous dynamic content except the placeholder
  Array.from(recommendationsGridEl.children).forEach(child => {
    if (child.id !== 'recommendations-placeholder') child.remove();
  });

  if (vehicleType === 'all') {
    recommendationsHolder?.removeAttribute('hidden');
    return;
  }

  recommendationsHolder?.setAttribute('hidden', '');

  const availableSlots = SlotStore.getAvailable();

  if (availableSlots.length === 0) {
    const empty = document.createElement('div');
    empty.classList.add('empty-state');
    empty.innerHTML = `
      <p class="empty-state__icon" aria-hidden="true">😔</p>
      <p class="empty-state__title">No available slots</p>
      <p>All slots are currently occupied. Please check back soon.</p>
    `;
    recommendationsGridEl.appendChild(empty);
    return;
  }

  // Score and sort
  const top3 = availableSlots
    .map(slot => ({ slot, score: calculateRecommendationScore(slot, vehicleType) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  top3.forEach(({ slot, score }, index) => {
    recommendationsGridEl.appendChild(createRecommendationCard(slot, score, index));
  });
};


// ══════════════════════════════════════════════════════════════
// BOOKING PANEL — OPEN / CLOSE
// ══════════════════════════════════════════════════════════════

/** Element that had focus before the panel opened (for restore on close). */
let previouslyFocused = null;

const openPanel = () => {
  previouslyFocused = document.activeElement;

  bookingPanel.classList.add('booking-panel--open');
  panelOverlay.classList.add('booking-panel-overlay--open');
  bookingPanel.setAttribute('aria-hidden', 'false');
  panelOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden'; // prevent background scroll

  // Move focus into the panel (a11y — modal dialog pattern)
  requestAnimationFrame(() => btnClosePanel?.focus());
};

const closePanel = () => {
  bookingPanel.classList.remove('booking-panel--open');
  panelOverlay.classList.remove('booking-panel-overlay--open');
  bookingPanel.setAttribute('aria-hidden', 'true');
  panelOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  // Deselect the slot visually
  if (selectedSlot) {
    const prevCard = slotGridEl.querySelector(`[data-id="${CSS.escape(selectedSlot._id)}"]`);
    if (prevCard) {
      prevCard.classList.remove('slot-card--selected');
      prevCard.setAttribute('aria-selected', 'false');
    }
    selectedSlot = null;
  }

  // Reset form + errors + price display
  bookingFormEl?.reset();
  clearAllFormErrors();
  setText('price-total',     '₹0');
  setText('price-breakdown', 'Select duration to calculate');

  // Restore focus to trigger element (a11y)
  previouslyFocused?.focus();
};


// ══════════════════════════════════════════════════════════════
// PANEL SLOT SUMMARY
// ══════════════════════════════════════════════════════════════

/**
 * Populate the panel with the selected slot's details.
 * @param {Object} slot
 */
const fillPanelSummary = (slot) => {
  setText('panel-slot-id',   `Slot ${slot.id}`);
  setText('panel-slot-zone', getZoneLabel(slot.zone));
  setText('panel-slot-price', `₹${slot.pricePerHour} / hour`);

  panelSlotDetailsEl.innerHTML = [
    `<span>Floor ${escapeHTML(slot.floor)}</span>`,
    `<span>${escapeHTML(String(slot.distanceFromEntry))}m from entry</span>`,
    `<span>${escapeHTML(getVehicleTypeLabel(slot.type))}</span>`,
  ].join('');

  panelSlotFeaturesEl.innerHTML = (slot.features ?? [])
    .map(f => `<span class="feature-tag">${escapeHTML(capitalise(f.replace(/-/g, ' ')))}</span>`)
    .join('');
};


// ══════════════════════════════════════════════════════════════
// SLOT SELECTION
// ══════════════════════════════════════════════════════════════

/**
 * Select a slot by ID — highlights its card, fills the panel,
 * and opens the booking drawer.
 * Only available slots can be selected.
 * @param {string} slotId - the slot's _id value
 */
const selectSlot = (slotId) => {
  const slot = SlotStore.findById(slotId);
  if (!slot || slot.status !== 'available') return;

  // Remove highlight from previously selected card
  if (selectedSlot) {
    const prev = slotGridEl.querySelector(`[data-id="${CSS.escape(selectedSlot._id)}"]`);
    if (prev) {
      prev.classList.remove('slot-card--selected');
      prev.setAttribute('aria-selected', 'false');
    }
  }

  selectedSlot = slot;

  // Highlight the new card
  const card = slotGridEl.querySelector(`[data-id="${CSS.escape(slotId)}"]`);
  if (card) {
    card.classList.add('slot-card--selected');
    card.setAttribute('aria-selected', 'true');
  }

  fillPanelSummary(slot);
  updatePriceCalculator();
  openPanel();
};


// ══════════════════════════════════════════════════════════════
// LIVE PRICE CALCULATOR
// ══════════════════════════════════════════════════════════════

/**
 * Recalculate and display the estimated cost whenever duration changes.
 * Updates both the total and the breakdown line.
 */
const updatePriceCalculator = () => {
  if (!selectedSlot) return;

  const duration = Number(durationSelectEl?.value);

  if (!duration || isNaN(duration)) {
    setText('price-total',     '₹0');
    setText('price-breakdown', 'Select duration to calculate');
    return;
  }

  const total   = calculateCost(selectedSlot.pricePerHour, duration);
  const endTime = calculateEndTime(new Date().toISOString(), duration);

  setText('price-total', formatCurrency(total));
  setText(
    'price-breakdown',
    `₹${selectedSlot.pricePerHour}/hr × ${duration} hr  |  Until ${formatTime(endTime)}`
  );
};


// ══════════════════════════════════════════════════════════════
// ZONE TABS
// ══════════════════════════════════════════════════════════════

/**
 * Activate a zone tab button — update aria-pressed, filter state,
 * sync the zone dropdown, and re-render the slot grid.
 * @param {HTMLButtonElement} tab
 */
const activateZoneTab = (tab) => {
  zoneTabs.forEach(t => t?.setAttribute('aria-pressed', t === tab ? 'true' : 'false'));

  activeFilters.zone = tab.dataset.zone ?? 'all';

  // Sync the zone dropdown to the active tab
  if (filterZoneEl) filterZoneEl.value = activeFilters.zone;

  renderSlotGrid();
};

zoneTabs.forEach(tab => tab?.addEventListener('click', () => activateZoneTab(tab)));


// ══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

// ── Filter bar: vehicle type change → immediate re-render ──
filterVehicleTypeEl?.addEventListener('change', () => {
  activeFilters.vehicleType = filterVehicleTypeEl.value;
  renderRecommendations();
  renderSlotGrid();
});

// ── Filter bar: Apply button ───────────────────────────────
btnApplyFilters?.addEventListener('click', () => {
  activeFilters.vehicleType = filterVehicleTypeEl?.value ?? 'all';
  activeFilters.zone        = filterZoneEl?.value        ?? 'all';
  activeFilters.floor       = filterFloorEl?.value       ?? 'all';

  // Sync zone tabs to the dropdown value
  const matchTab = zoneTabs.find(t => t?.dataset.zone === activeFilters.zone) ?? tabAll;
  zoneTabs.forEach(t => t?.setAttribute('aria-pressed', t === matchTab ? 'true' : 'false'));

  renderSlotGrid();
  renderRecommendations();
});

// ── Slot grid: click ──────────────────────────────────────
slotGridEl?.addEventListener('click', (event) => {
  const card = event.target.closest('.slot-card');
  if (!card || card.dataset.status !== 'available') return;
  selectSlot(card.dataset.id);
});

// ── Slot grid: keyboard (Enter / Space) ───────────────────
slotGridEl?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.slot-card');
  if (!card || card.dataset.status !== 'available') return;
  event.preventDefault();
  selectSlot(card.dataset.id);
});

// ── Recommendations: "Select This Slot" click ─────────────
recommendationsGridEl?.addEventListener('click', (event) => {
  const btn = event.target.closest('.btn-select-slot');
  if (!btn) return;
  const slotId = btn.dataset.slotId;
  if (slotId) selectSlot(slotId);
});

// ── Panel: duration change → update price ─────────────────
durationSelectEl?.addEventListener('change', updatePriceCalculator);

// ── Panel: close / cancel ──────────────────────────────────
btnClosePanel?.addEventListener('click',  closePanel);
btnCancelPanel?.addEventListener('click', closePanel);
panelOverlay?.addEventListener('click',   closePanel);

// ── Panel: Escape key to close ────────────────────────────
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    bookingPanel?.classList.contains('booking-panel--open')
  ) {
    closePanel();
  }
});

// ── Logout ────────────────────────────────────────────────
getElement('btn-logout')?.addEventListener('click', logoutUser);

// ── Booking form submit ───────────────────────────────────
bookingFormEl?.addEventListener('submit', (event) => {
  event.preventDefault();
  clearAllFormErrors();

  if (!selectedSlot) {
    showToast('Please select a parking slot from the map first.', 'warning');
    return;
  }

  const formData = {
    slotId:        selectedSlot._id,
    vehicleType:   vehicleTypeSelectEl?.value   ?? '',
    vehicleNumber: vehicleNumberInputEl?.value  ?? '',
    durationHours: Number(durationSelectEl?.value ?? 0),
  };

  // ── Validate ─────────────────────────────────────────────
  const { valid, errors } = validateBookingForm(formData);

  if (!valid) {
    if (errors.vehicleType)   showFieldError(vehicleTypeErrorEl,   vehicleTypeSelectEl,  errors.vehicleType);
    if (errors.vehicleNumber) showFieldError(vehicleNumberErrorEl, vehicleNumberInputEl, errors.vehicleNumber);
    if (errors.durationHours) showFieldError(durationErrorEl,      durationSelectEl,     errors.durationHours);
    return;
  }

  // ── Disable button to prevent double-submit ───────────────
  disableButton(btnConfirm, 'Booking…');

  // ── Race-condition guard: re-fetch slot status ────────────
  const freshSlot = SlotStore.findById(selectedSlot._id);
  if (!freshSlot || freshSlot.status !== 'available') {
    showToast('This slot was just taken. Please choose another.', 'error');
    enableButton(btnConfirm);
    closePanel();
    renderSlotGrid();
    updateZoneCounts();
    return;
  }

  // ── Create booking record ─────────────────────────────────
  const startTime = new Date().toISOString();
  const totalCost = calculateCost(freshSlot.pricePerHour, formData.durationHours);
  const userId    = SessionStore.getUserId();

  BookingStore.create({
    userId,
    slotId:        freshSlot._id,
    zone:          freshSlot.zone,
    vehicleNumber: formatVehicleNumber(formData.vehicleNumber),
    vehicleType:   formData.vehicleType,
    startTime,
    durationHours: formData.durationHours,
    totalCost,
  });

  // ── Occupy the slot ───────────────────────────────────────
  SlotStore.occupy(freshSlot._id);

  // ── Refresh UI ────────────────────────────────────────────
  closePanel();
  updateZoneCounts();
  renderSlotGrid();
  renderRecommendations();

  showToast(
    `Slot ${freshSlot.id} booked for ${formData.durationHours} hr. Redirecting to dashboard…`,
    'success',
    2500
  );

  setTimeout(() => redirectTo('dashboard.html'), 2500);
});


// ══════════════════════════════════════════════════════════════
// INITIALISATION
// ══════════════════════════════════════════════════════════════

/**
 * Boot the booking page:
 *   1. Seed slots (async fetch)
 *   2. Fill header user name
 *   3. Update zone tab counts
 *   4. Render the full slot grid
 * Recommendations render only when the user picks a vehicle type.
 */
const initBookingPage = async () => {
  await seedSlotsIfNeeded();
  populateUserInfo();
  updateZoneCounts();
  renderSlotGrid();
};

initBookingPage();
