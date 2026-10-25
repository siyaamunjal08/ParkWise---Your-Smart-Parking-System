// public/js/booking.js — Stage 9 Location-Specific Booking Frontend Controller
/* ============================================================
   Smart Parking System — Location-Specific Booking Integration

   PURPOSE:
   Provides live, location-scoped parking slot discovery, rule-based
   recommendations, immediate booking submission with UUIDv4 idempotency,
   authoritative server-driven confirmation, and 15s availability polling.

   DEPENDS ON (loaded before this file):
     - js/storage.js    → SessionStore
     - js/utils.js      → disableButton, enableButton, showToast, redirectTo
     - js/api.js        → ApiClient, ApiError
     - js/validation.js → validateVehicleNumber
     - js/auth.js       → requireAuth, logoutUser, getSafeReturnUrl

   SECURITY & IDEMPOTENCY:
     - Pure backend integration via ApiClient; no local storage fallback
     - Canonical UUIDv4 requestId generated per distinct attempt
     - Retries of uncertain outcomes reuse identical requestId and payload
     - Displayed price is strictly labeled an estimate computed with integer paise;
       authoritative price is finalized and confirmed exclusively by the backend
   ============================================================ */

'use strict';

/**
 * Polling interval for live slot availability (15 seconds)
 */
const POLL_INTERVAL_MS = 15000;

/**
 * UUID v4 validator regex
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generate a cryptographically robust UUID v4 string.
 * @returns {string}
 */
function generateUUIDv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Fallback for standard environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Calculate estimated booking total strictly using integer paise.
 *
 * @param {number} pricePerHourPaise
 * @param {number} durationHours
 * @returns {number} Total in integer paise
 */
function calculateEstimatedPaise(pricePerHourPaise, durationHours) {
  const price = Number(pricePerHourPaise);
  const hours = Number(durationHours);
  if (!Number.isSafeInteger(price) || price < 0) return 0;
  if (!Number.isSafeInteger(hours) || hours <= 0) return 0;
  return price * hours;
}

/**
 * Format integer paise into Indian Rupee display (e.g. 2000 -> "₹20.00").
 *
 * @param {number} paise
 * @returns {string}
 */
function formatPaiseToRupees(paise) {
  const p = Number(paise);
  if (!Number.isFinite(p) || p < 0) return '₹0.00';
  return `₹${(p / 100).toFixed(2)}`;
}

/**
 * Check vehicle compatibility between slot and requested vehicle type.
 *
 * @param {string} slotType
 * @param {string} vehicleType
 * @returns {boolean}
 */
function isSlotCompatible(slotType, vehicleType) {
  if (!slotType || !vehicleType || vehicleType === 'all') return true;
  return slotType.toLowerCase() === vehicleType.toLowerCase();
}

/**
 * Main Booking Application Module
 */
const BookingApp = (() => {
  // Application State
  const state = {
    locationId: null,
    location: null,
    slots: [],
    selectedSlot: null,
    recommendations: [],
    uncertainAttempt: null, // { payload, requestId, timestamp }
    activeFilters: {
      vehicleType: 'all',
      zone: 'all',
      floor: 'all',
    },
    isSubmitting: false,
    isPolling: false,
    pollTimer: null,
    pollSequence: 0,
    slotRequestSeq: 0,
    hasLocationError: false,
    savedVehicles: [],
  };

  const UNCERTAIN_STORAGE_PREFIX = 'parkwise_uncertain_booking_';

  /**
   * Helper to get current authenticated user ID from session.
   */
  function getCurrentUserId() {
    try {
      const session = typeof SessionStore !== 'undefined' ? SessionStore.get() : null;
      return session?.userId || session?.user?.id || session?.user?._id || null;
    } catch {
      return null;
    }
  }

  /**
   * Persist unresolved attempt into user-scoped sessionStorage.
   * Throws if storage fails or user is unauthenticated.
   * @param {Object} attempt
   * @returns {Object}
   */
  function saveUncertainAttempt(attempt) {
    if (!attempt || !attempt.payload || !attempt.requestId) {
      throw new Error('Invalid attempt record: missing payload or requestId.');
    }
    const userId = attempt.userId || getCurrentUserId();
    if (!userId) {
      throw new Error('Authentication session required to secure booking recovery state.');
    }
    if (typeof sessionStorage === 'undefined') {
      throw new Error('Session storage is unavailable. Cannot guarantee booking recovery.');
    }
    const record = {
      payload: attempt.payload,
      requestId: attempt.requestId,
      userId,
      locationId: attempt.payload.locationId || attempt.locationId,
      timestamp: attempt.timestamp || Date.now(),
      status: attempt.status || 'in_flight',
    };
    const key = `${UNCERTAIN_STORAGE_PREFIX}${userId}`;
    sessionStorage.setItem(key, JSON.stringify(record));
    state.uncertainAttempt = record;
    return record;
  }

  /**
   * Remove unresolved attempt from user-scoped sessionStorage.
   */
  function clearUncertainAttempt() {
    state.uncertainAttempt = null;
    const userId = getCurrentUserId();
    if (userId && typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem(`${UNCERTAIN_STORAGE_PREFIX}${userId}`);
      } catch {}
    }
  }

  /**
   * Restore unresolved attempt from user-scoped sessionStorage regardless of current location.
   */
  function restoreUncertainAttempt() {
    const userId = getCurrentUserId();
    if (!userId || typeof sessionStorage === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(`${UNCERTAIN_STORAGE_PREFIX}${userId}`);
      if (!raw) return;
      const attempt = JSON.parse(raw);
      if (!attempt || !attempt.payload || !attempt.requestId) return;

      const p = attempt.payload;
      if (!p.locationId || !p.slotId || !p.vehicleNumber || !p.vehicleType || !p.durationHours) {
        return;
      }

      // Check ownership
      if (attempt.userId && attempt.userId !== userId) {
        return;
      }

      // Treat any restored in-flight or uncertain attempt as unresolved
      attempt.status = 'unresolved';
      state.uncertainAttempt = attempt;

      const isCurrentLoc = p.locationId === state.locationId;
      const msg = isCurrentLoc
        ? 'Unresolved booking attempt detected from your session. You can safely retry with the original request identifier or reconcile status.'
        : `Unresolved booking attempt in flight for location "${p.locationId}". New bookings are blocked until this attempt is resolved.`;

      showUncertainAlert(msg);
    } catch {}
  }

  // Cached DOM Elements
  const elements = {};

  /**
   * Safe textContent setter
   */
  function setText(el, val) {
    if (el) el.textContent = val !== null && val !== undefined ? String(val) : '';
  }

  /**
   * Initialize DOM references
   */
  function cacheElements() {
    const getEl = (id) => (typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(id) : null);

    elements.headerUserName = elements.headerUserName || getEl('header-user-name');
    elements.btnLogout = elements.btnLogout || getEl('btn-logout');

    // Location state elements
    elements.locationErrorState = elements.locationErrorState || getEl('location-error-state');
    elements.locationErrorTitle = elements.locationErrorTitle || getEl('location-error-title');
    elements.locationErrorDesc = elements.locationErrorDesc || getEl('location-error-desc');
    elements.locationHeaderBar = elements.locationHeaderBar || getEl('location-header-bar');
    elements.selectedLocationName = elements.selectedLocationName || getEl('selected-location-name');
    elements.selectedLocationCategory = elements.selectedLocationCategory || getEl('selected-location-category');
    elements.selectedLocationStatus = elements.selectedLocationStatus || getEl('selected-location-status');
    elements.selectedLocationAddress = elements.selectedLocationAddress || getEl('selected-location-address');
    elements.locationClosedBanner = elements.locationClosedBanner || getEl('location-closed-banner');

    // Workflow & Alerts
    elements.workflowContainer = elements.workflowContainer || getEl('booking-workflow-container');
    elements.uncertainAlert = elements.uncertainAlert || getEl('uncertain-booking-alert');
    elements.uncertainMessage = elements.uncertainMessage || getEl('uncertain-booking-message');
    elements.btnRetryUncertain = elements.btnRetryUncertain || getEl('btn-retry-uncertain');
    elements.btnReturnUncertain = elements.btnReturnUncertain || getEl('btn-return-uncertain');
    elements.btnDiscardUncertain = elements.btnDiscardUncertain || getEl('btn-discard-uncertain');

    // Confirmation Card
    elements.confirmationCard = elements.confirmationCard || getEl('booking-confirmation-container');
    elements.confIdempotentBadge = elements.confIdempotentBadge || getEl('conf-idempotent-badge');
    elements.confBookingId = elements.confBookingId || getEl('conf-booking-id');
    elements.confLocationSlot = elements.confLocationSlot || getEl('conf-location-slot');
    elements.confVehicle = elements.confVehicle || getEl('conf-vehicle');
    elements.confSchedule = elements.confSchedule || getEl('conf-schedule');
    elements.confTotalPrice = elements.confTotalPrice || getEl('conf-total-price');
    elements.confStatus = elements.confStatus || getEl('conf-status');
    elements.btnBookAnother = elements.btnBookAnother || getEl('btn-book-another');

    // Filters & Zone Tabs
    elements.filterVehicleType = elements.filterVehicleType || getEl('filter-vehicle-type');
    elements.filterZone = elements.filterZone || getEl('filter-zone');
    elements.filterFloor = elements.filterFloor || getEl('filter-floor');
    elements.btnApplyFilters = elements.btnApplyFilters || getEl('btn-apply-filters');
    elements.zoneTabsContainer = elements.zoneTabsContainer || getEl('zone-tabs-container');

    // Recommendations
    elements.recommendationsSection = elements.recommendationsSection || getEl('recommendations-section');
    elements.recommendationsGrid = elements.recommendationsGrid || getEl('recommendations-grid');
    elements.recommendationsPlaceholder = elements.recommendationsPlaceholder || getEl('recommendations-placeholder');

    // Slot Grid
    elements.slotCount = elements.slotCount || getEl('slot-count');
    elements.slotGrid = elements.slotGrid || getEl('slot-grid');
    elements.slotGridLoading = elements.slotGridLoading || getEl('slot-grid-loading');
    elements.slotsEmptyState = elements.slotsEmptyState || getEl('slots-empty-state');

    // Booking Panel Drawer
    elements.panel = elements.panel || getEl('booking-panel');
    elements.panelOverlay = elements.panelOverlay || getEl('booking-panel-overlay');
    elements.btnClosePanel = elements.btnClosePanel || getEl('btn-close-panel');
    elements.btnCancelPanel = elements.btnCancelPanel || getEl('btn-cancel-panel');

    // Panel Slot Summary
    elements.panelSlotId = elements.panelSlotId || getEl('panel-slot-id');
    elements.panelSlotZone = elements.panelSlotZone || getEl('panel-slot-zone');
    elements.panelSlotDetails = elements.panelSlotDetails || getEl('panel-slot-details');
    elements.panelSlotPrice = elements.panelSlotPrice || getEl('panel-slot-price');
    elements.panelSlotFeatures = elements.panelSlotFeatures || getEl('panel-slot-features');

    // Panel Form
    elements.bookingForm = elements.bookingForm || getEl('booking-form');
    elements.savedVehicleGroup = elements.savedVehicleGroup || getEl('saved-vehicle-group');
    elements.savedVehicleSelect = elements.savedVehicleSelect || getEl('saved-vehicle-select');
    elements.vehicleTypeSelect = elements.vehicleTypeSelect || getEl('vehicle-type');
    elements.vehicleNumberInput = elements.vehicleNumberInput || getEl('vehicle-number');
    elements.durationSelect = elements.durationSelect || getEl('duration-hours');
    elements.priceBreakdown = elements.priceBreakdown || getEl('price-breakdown');
    elements.priceTotal = elements.priceTotal || getEl('price-total');
    elements.btnConfirmBooking = elements.btnConfirmBooking || getEl('btn-confirm-booking');

    // Error messages
    elements.vehicleTypeError = elements.vehicleTypeError || getEl('vehicle-type-error');
    elements.vehicleNumberError = elements.vehicleNumberError || getEl('vehicle-number-error');
    elements.durationError = elements.durationError || getEl('duration-error');
    elements.bookingFormError = elements.bookingFormError || getEl('booking-form-error');
  }

  /**
   * Display Location-Level Error / Missing ID state
   */
  function showLocationError(title, description) {
    state.hasLocationError = true;
    stopPolling();

    if (elements.locationErrorState) {
      elements.locationErrorState.hidden = false;
      setText(elements.locationErrorTitle, title);
      setText(elements.locationErrorDesc, description);
    }
    if (elements.locationHeaderBar) elements.locationHeaderBar.hidden = true;
    if (elements.workflowContainer) elements.workflowContainer.hidden = true;
    if (elements.confirmationCard) elements.confirmationCard.hidden = true;
  }

  /**
   * Load Location Details from GET /api/locations/:locationId
   */
  async function loadLocationDetails() {
    try {
      const res = await ApiClient.get(`/api/locations/${encodeURIComponent(state.locationId)}`);
      if (!res || !res.success || !res.location) {
        throw new Error('Location not found or no longer available.');
      }

      state.location = res.location;

      // Render Location Header Bar
      if (elements.locationHeaderBar) elements.locationHeaderBar.hidden = false;
      setText(elements.selectedLocationName, state.location.name || 'Unnamed Facility');

      if (elements.selectedLocationCategory) {
        if (state.location.category) {
          setText(elements.selectedLocationCategory, state.location.category);
          elements.selectedLocationCategory.hidden = false;
        } else {
          elements.selectedLocationCategory.hidden = true;
        }
      }

      if (elements.selectedLocationStatus) {
        const isClosed = state.location.status === 'closed';
        elements.selectedLocationStatus.className = `status-badge ${isClosed ? 'status-badge--closed' : 'status-badge--active'}`;
        setText(elements.selectedLocationStatus, isClosed ? 'Closed' : 'Active');
      }

      const addressParts = [
        state.location.address,
        state.location.area,
        state.location.city,
      ].filter(Boolean);
      setText(elements.selectedLocationAddress, addressParts.join(' • '));

      // Handle Closed Location
      if (state.location.status === 'closed') {
        if (elements.locationClosedBanner) elements.locationClosedBanner.hidden = false;
        if (elements.btnConfirmBooking) elements.btnConfirmBooking.disabled = true;
      } else {
        if (elements.locationClosedBanner) elements.locationClosedBanner.hidden = true;
      }

      return true;
    } catch (err) {
      showLocationError(
        'Parking Facility Unavailable',
        err.status === 404
          ? 'The requested parking facility could not be found. It may have been archived or removed.'
          : err.message || 'Unable to load facility details. Please check your connection and try again.'
      );
      return false;
    }
  }

  /**
   * Load Location-Scoped Slots from GET /api/locations/:locationId/slots
   */
  async function loadSlots() {
    if (state.hasLocationError) return;
    state.slotRequestSeq = (state.slotRequestSeq || 0) + 1;
    state.pollSequence = state.slotRequestSeq;
    const thisSeq = state.slotRequestSeq;

    try {
      if (elements.slotGridLoading) elements.slotGridLoading.hidden = false;
      const res = await ApiClient.get(`/api/locations/${encodeURIComponent(state.locationId)}/slots`);

      // Race condition check: ignore stale response
      if (thisSeq !== state.slotRequestSeq) return;

      if (!res || !res.success || !Array.isArray(res.slots)) {
        throw new Error('Invalid slot response from server.');
      }

      // Update authoritative location status from response
      if (res.locationStatus) {
        if (state.location) state.location.status = res.locationStatus;
        const isClosed = res.locationStatus === 'closed';
        if (elements.selectedLocationStatus) {
          elements.selectedLocationStatus.className = `status-badge ${isClosed ? 'status-badge--closed' : 'status-badge--active'}`;
          setText(elements.selectedLocationStatus, isClosed ? 'Closed' : 'Active');
        }
        if (elements.locationClosedBanner) {
          elements.locationClosedBanner.hidden = !isClosed;
        }
        if (isClosed && elements.btnConfirmBooking) {
          elements.btnConfirmBooking.disabled = true;
        } else if (!isClosed && elements.btnConfirmBooking && !state.isSubmitting) {
          elements.btnConfirmBooking.disabled = false;
        }
      }

      state.slots = res.slots;
      populateDynamicFilterOptions();
      renderZoneTabs();
      renderSlotGrid();
    } catch (err) {
      if (thisSeq !== state.slotRequestSeq) return;
      if (err && err.status === 404) {
        showLocationError(
          'Parking Facility Unavailable',
          'The requested parking facility could not be found. It may have been archived or removed.'
        );
        return;
      }
      if (elements.slotCount) setText(elements.slotCount, 'Error loading slots');
      if (elements.slotGrid) {
        elements.slotGrid.innerHTML = '';
        const doc = typeof document !== 'undefined' ? document : (typeof global !== 'undefined' ? global.document : null);
        if (doc && typeof doc.createElement === 'function') {
          const emptyDiv = doc.createElement('div');
          emptyDiv.className = 'empty-state';

          const iconP = doc.createElement('p');
          iconP.className = 'empty-state__icon';
          iconP.setAttribute('aria-hidden', 'true');
          iconP.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
          emptyDiv.appendChild(iconP);

          const titleP = doc.createElement('p');
          titleP.className = 'empty-state__title';
          titleP.textContent = 'Unable to Load Slots';
          emptyDiv.appendChild(titleP);

          const msgP = doc.createElement('p');
          msgP.textContent = err.message || 'Please refresh the page to try again.';
          emptyDiv.appendChild(msgP);

          elements.slotGrid.appendChild(emptyDiv);
        }
      }
    } finally {
      if (thisSeq === state.slotRequestSeq && elements.slotGridLoading) {
        elements.slotGridLoading.hidden = true;
      }
    }
  }

  /**
   * Populate Zone and Floor filter options based on actual location slot inventory
   */
  function populateDynamicFilterOptions() {
    if (!elements.filterZone) return;

    const currentZoneVal = elements.filterZone.value;
    const currentFloorVal = elements.filterFloor ? elements.filterFloor.value : 'all';

    // Extract unique zones and floors from live slots
    const zones = new Set();
    const floors = new Set();
    state.slots.forEach((s) => {
      if (s.zone) zones.add(s.zone);
      if (s.floor) floors.add(s.floor);
    });

    // Rebuild Zone Dropdown
    elements.filterZone.innerHTML = '<option value="all">All Zones</option>';
    Array.from(zones).sort().forEach((z) => {
      const opt = document.createElement('option');
      opt.value = z;
      opt.textContent = `Zone ${z}`;
      elements.filterZone.appendChild(opt);
    });
    if (zones.has(currentZoneVal)) {
      elements.filterZone.value = currentZoneVal;
    }

    // Rebuild Floor Dropdown
    if (elements.filterFloor) {
      elements.filterFloor.innerHTML = '<option value="all">All Floors</option>';
      Array.from(floors).sort().forEach((f) => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = `Floor ${f}`;
        elements.filterFloor.appendChild(opt);
      });
      if (floors.has(currentFloorVal)) {
        elements.filterFloor.value = currentFloorVal;
      }
    }
  }

  /**
   * Render dynamic zone filter tabs with counts
   */
  function renderZoneTabs() {
    if (!elements.zoneTabsContainer) return;

    // Calculate available count per zone
    const counts = { all: 0 };
    const allZones = new Set();

    state.slots.forEach((s) => {
      if (s.zone) allZones.add(s.zone);
      if (s.available) {
        counts.all += 1;
        counts[s.zone] = (counts[s.zone] || 0) + 1;
      }
    });

    const sortedZones = Array.from(allZones).sort();
    const existingButtons = elements.zoneTabsContainer.children;

    // Avoid rebuilding unaffected controls every poll:
    // If buttons are already built and zones match, update counts and active state in-place
    if (existingButtons && existingButtons.length === sortedZones.length + 1) {
      let matching = true;
      for (let i = 0; i < existingButtons.length; i++) {
        const btn = existingButtons[i];
        const zoneAttr = btn.getAttribute ? btn.getAttribute('data-zone') : null;
        if (!zoneAttr || (zoneAttr !== 'all' && !allZones.has(zoneAttr))) {
          matching = false;
          break;
        }
      }
      if (matching) {
        for (let i = 0; i < existingButtons.length; i++) {
          const btn = existingButtons[i];
          const zoneAttr = btn.getAttribute ? btn.getAttribute('data-zone') : null;
          const isActive = state.activeFilters.zone === zoneAttr;
          if (btn.classList) {
            if (isActive) btn.classList.add('is-active');
            else btn.classList.remove('is-active');
          }
          if (btn.setAttribute) {
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          }
          const countSpan = btn.querySelector ? btn.querySelector('.zone-tab-count') : null;
          if (countSpan) {
            countSpan.textContent = String(counts[zoneAttr] || 0);
          }
        }
        return;
      }
    }

    elements.zoneTabsContainer.innerHTML = '';

    // "All" tab
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `zone-tab zone-tab--all ${state.activeFilters.zone === 'all' ? 'is-active' : ''}`;
    allBtn.setAttribute('aria-pressed', state.activeFilters.zone === 'all' ? 'true' : 'false');
    allBtn.setAttribute('data-zone', 'all');
    allBtn.innerHTML = `All <span class="zone-tab-count">${counts.all}</span>`;
    allBtn.onclick = () => selectZoneFilter('all');
    elements.zoneTabsContainer.appendChild(allBtn);

    // Individual Zone tabs
    sortedZones.forEach((z) => {
      const zBtn = document.createElement('button');
      zBtn.type = 'button';
      const isActive = state.activeFilters.zone === z;
      zBtn.className = `zone-tab zone-tab--${z.toLowerCase()} ${isActive ? 'is-active' : ''}`;
      zBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      zBtn.setAttribute('data-zone', z);
      zBtn.innerHTML = `Zone ${z} <span class="zone-tab-count">${counts[z] || 0}</span>`;
      zBtn.onclick = () => selectZoneFilter(z);
      elements.zoneTabsContainer.appendChild(zBtn);
    });
  }

  /**
   * Filter slots by current criteria
   */
  function getFilteredSlots() {
    return state.slots.filter((s) => {
      if (state.activeFilters.zone !== 'all' && s.zone !== state.activeFilters.zone) {
        return false;
      }
      if (state.activeFilters.floor !== 'all' && s.floor !== state.activeFilters.floor) {
        return false;
      }
      return true;
    });
  }

  /**
   * Render the Slot Grid
   */
  function renderSlotGrid() {
    if (!elements.slotGrid) return;

    // Capture focused slot element to restore focus after rendering
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const focusedSlotId = activeEl && activeEl.getAttribute ? activeEl.getAttribute('data-slot-id') : null;

    const filtered = getFilteredSlots();
    const availableCount = filtered.filter((s) => s.available).length;

    // Update available count indicator
    if (elements.slotCount) {
      setText(
        elements.slotCount,
        `${availableCount} available of ${filtered.length} slot${filtered.length === 1 ? '' : 's'}`
      );
    }

    elements.slotGrid.innerHTML = '';

    if (filtered.length === 0) {
      if (elements.slotsEmptyState) elements.slotsEmptyState.hidden = false;
      return;
    }
    if (elements.slotsEmptyState) elements.slotsEmptyState.hidden = true;

    filtered.forEach((slot) => {
      const isSelected = state.selectedSlot && state.selectedSlot.id === slot.id;
      const isCompatible = isSlotCompatible(slot.vehicleType, state.activeFilters.vehicleType);
      const isSelectable = slot.available && isCompatible && (!state.location || state.location.status !== 'closed');

      const card = document.createElement('div');
      card.className = 'slot-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('data-slot-id', slot.id);
      card.setAttribute('data-zone', slot.zone || '');

      if (isSelected) {
        card.classList.add('slot-card--selected');
      } else if (!slot.available) {
        card.classList.add('slot-card--occupied');
      } else if (!isCompatible) {
        card.classList.add('slot-card--incompatible');
      } else {
        card.classList.add('slot-card--available');
      }

      // Accessibility & Tabindex
      if (isSelectable) {
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Slot ${slot.code}, Zone ${slot.zone}, ₹${(slot.pricePerHourPaise / 100).toFixed(2)} per hour. Available.`);
      } else {
        card.setAttribute('tabindex', '-1');
        card.setAttribute('aria-disabled', 'true');
        const reason = !slot.available ? 'Occupied' : 'Incompatible with selected vehicle type';
        card.setAttribute('aria-label', `Slot ${slot.code}, Zone ${slot.zone}. ${reason}.`);
      }

      // Slot Card Content
      const codeP = document.createElement('p');
      codeP.className = 'slot-card__code';
      codeP.textContent = slot.code;
      card.appendChild(codeP);

      const typeP = document.createElement('p');
      typeP.className = 'slot-card__type';
      typeP.textContent = slot.vehicleType ? slot.vehicleType.toUpperCase() : 'CAR';
      card.appendChild(typeP);

      const priceP = document.createElement('p');
      priceP.className = 'slot-card__price';
      priceP.textContent = `₹${(slot.pricePerHourPaise / 100).toFixed(0)}/h`;
      card.appendChild(priceP);

      // Status pill / label
      const statusPill = document.createElement('span');
      statusPill.className = 'slot-card__status';
      if (isSelected) {
        statusPill.textContent = 'Selected';
      } else if (!slot.available) {
        statusPill.textContent = 'Occupied';
      } else if (!isCompatible) {
        statusPill.textContent = 'Incompatible';
      } else {
        statusPill.textContent = 'Available';
      }
      card.appendChild(statusPill);

      // Event handlers
      if (isSelectable) {
        card.onclick = () => selectSlot(slot);
        card.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectSlot(slot);
          }
        };
      } else {
        card.onclick = () => {
          if (!slot.available) {
            if (typeof showToast === 'function') {
              showToast(`Slot ${slot.code} is currently occupied.`, 'error');
            }
          } else if (!isCompatible) {
            if (typeof showToast === 'function') {
              showToast(`Slot ${slot.code} is reserved for ${slot.vehicleType} vehicles.`, 'warning');
            }
          }
        };
      }

      elements.slotGrid.appendChild(card);
    });

    // Restore focus if previously focused slot card still exists
    if (focusedSlotId && elements.slotGrid && elements.slotGrid.querySelector) {
      const elToFocus = elements.slotGrid.querySelector(`[data-slot-id="${focusedSlotId}"]`);
      if (elToFocus && typeof elToFocus.focus === 'function') {
        elToFocus.focus();
      }
    }
  }

  /**
   * Fetch and render Rule-Based Recommendations for the active location
   */
  async function loadRecommendations(vehicleType) {
    if (!elements.recommendationsGrid || state.hasLocationError) return;

    if (!vehicleType || vehicleType === 'all') {
      elements.recommendationsGrid.innerHTML = `
        <div class="empty-state" id="recommendations-placeholder">
          <p class="empty-state__icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg></p>
          <p class="empty-state__title">Select a vehicle type</p>
          <p>Recommendations will appear based on vehicle compatibility, entrance distance, and hourly pricing.</p>
        </div>
      `;
      return;
    }

    try {
      const endpoint = `/api/locations/${encodeURIComponent(state.locationId)}/recommendations?vehicleType=${encodeURIComponent(vehicleType)}`;
      const res = await ApiClient.get(endpoint);

      if (!res || !res.success || !Array.isArray(res.recommendations)) {
        throw new Error('Recommendations could not be retrieved.');
      }

      state.recommendations = res.recommendations;
      elements.recommendationsGrid.innerHTML = '';

      if (state.recommendations.length === 0) {
        elements.recommendationsGrid.innerHTML = `
          <div class="empty-state">
            <p class="empty-state__icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></p>
            <p class="empty-state__title">No Recommendations Available</p>
            <p>No available slots match your vehicle type at this facility right now.</p>
          </div>
        `;
        return;
      }

      state.recommendations.forEach((rec) => {
        const card = document.createElement('article');
        card.className = 'rec-card';
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Select recommended slot ${rec.code}`);

        const headerDiv = document.createElement('div');
        headerDiv.className = 'rec-card__header';

        const codeH = document.createElement('h3');
        codeH.className = 'rec-card__code';
        codeH.textContent = rec.code;
        headerDiv.appendChild(codeH);

        const badge = document.createElement('span');
        badge.className = 'category-badge';
        badge.textContent = `Zone ${rec.zone}`;
        headerDiv.appendChild(badge);
        card.appendChild(headerDiv);

        const reasonP = document.createElement('p');
        reasonP.className = 'rec-card__reason';
        reasonP.textContent = rec.reason || `${formatPaiseToRupees(rec.pricePerHourPaise)}/hr`;
        card.appendChild(reasonP);

        const priceP = document.createElement('p');
        priceP.className = 'rec-card__price';
        priceP.textContent = `${formatPaiseToRupees(rec.pricePerHourPaise)} / hour`;
        card.appendChild(priceP);

        card.onclick = () => {
          // Find matching slot in full state or use rec
          const fullSlot = state.slots.find((s) => s.id === rec.id) || rec;
          selectSlot(fullSlot);
        };
        card.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const fullSlot = state.slots.find((s) => s.id === rec.id) || rec;
            selectSlot(fullSlot);
          }
        };

        elements.recommendationsGrid.appendChild(card);
      });
    } catch {
      // Graceful fallback for recommendation endpoint errors
      elements.recommendationsGrid.innerHTML = `
        <div class="empty-state">
          <p class="empty-state__icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></p>
          <p class="empty-state__title">Recommendations Unavailable</p>
          <p>Browse the parking map below to choose an available slot.</p>
        </div>
      `;
    }
  }

  /**
   * Helper to retrieve currently selected saved vehicle object from state.
   * Returns null if manual entry is active or no match is found.
   *
   * @returns {object|null}
   */
  function getSelectedSavedVehicle() {
    if (!elements.savedVehicleSelect) return null;
    const selectedId = elements.savedVehicleSelect.value;
    if (!selectedId) return null;
    if (!Array.isArray(state.savedVehicles)) return null;
    return state.savedVehicles.find((v) => v.id === selectedId || v._id === selectedId) || null;
  }

  /**
   * Slot Selection
   */
  function selectSlot(slot) {
    if (!slot) return;
    if (state.location && state.location.status === 'closed') {
      if (typeof showToast === 'function') {
        showToast('This parking facility is currently closed. Bookings are unavailable.', 'error');
      }
      return;
    }

    // Preserve saved-vehicle identity across slot changes (Stage 11B)
    const savedVehicle = getSelectedSavedVehicle();
    if (savedVehicle) {
      const vehicleType = (savedVehicle.type || 'car').toLowerCase();
      if (!isSlotCompatible(slot.vehicleType, vehicleType)) {
        const vehicleTypeDisplay = vehicleType.toUpperCase();
        const slotTypeDisplay = (slot.vehicleType || 'unknown').toUpperCase();
        if (typeof showToast === 'function') {
          showToast(
            `Slot ${slot.code} (${slotTypeDisplay}) is incompatible with your selected ${vehicleTypeDisplay} vehicle (${savedVehicle.registrationNumber}).`,
            'warning'
          );
        }
        return;
      }
    }

    state.selectedSlot = slot;
    renderSlotGrid();
    openBookingPanel();
  }

  /**
   * Bounded timeout for fetching saved vehicles before falling back to manual entry (Stage 11B)
   */
  const SAVED_VEHICLES_TIMEOUT_MS = 5000;

  /**
   * Fetch authenticated user's saved vehicles for booking autofill (Stage 11B)
   */
  async function loadSavedVehicles() {
    let timeoutId = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Saved vehicles request timed out'));
        }, SAVED_VEHICLES_TIMEOUT_MS);
      });

      const res = await Promise.race([
        ApiClient.get('/api/vehicles/me'),
        timeoutPromise,
      ]);

      if (res && res.success && Array.isArray(res.vehicles)) {
        state.savedVehicles = res.vehicles;
        renderSavedVehicleOptions(state.savedVehicles);
      } else {
        state.savedVehicles = [];
        renderSavedVehicleOptions([]);
      }
    } catch {
      // If saved vehicles fail to load, manual booking must still work
      state.savedVehicles = [];
      renderSavedVehicleOptions([]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      // Late response guard: if unresolved attempt is active, keep selector locked!
      if (state.uncertainAttempt && elements.savedVehicleSelect) {
        elements.savedVehicleSelect.disabled = true;
      }
    }
  }

  /**
   * Render options for saved vehicle select element
   */
  function renderSavedVehicleOptions(vehicles) {
    if (!elements.savedVehicleSelect) return;

    const previousSelectedId = elements.savedVehicleSelect.value;

    elements.savedVehicleSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- Manual Entry / Choose a vehicle --';
    elements.savedVehicleSelect.appendChild(defaultOpt);

    if (Array.isArray(vehicles)) {
      vehicles.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id || v._id;
        const typeLabel = (v.type || 'car').toUpperCase();
        opt.textContent = v.label
          ? `${v.label} (${v.registrationNumber}) — ${typeLabel}`
          : `${v.registrationNumber} — ${typeLabel}`;
        elements.savedVehicleSelect.appendChild(opt);
      });
    }

    if (previousSelectedId && Array.isArray(vehicles) && vehicles.some((v) => (v.id || v._id) === previousSelectedId)) {
      elements.savedVehicleSelect.value = previousSelectedId;
    } else if (!previousSelectedId) {
      elements.savedVehicleSelect.value = '';
    }

    // Late response guard: if unresolved attempt is active, keep selector locked!
    if (state.uncertainAttempt) {
      elements.savedVehicleSelect.disabled = true;
    }
  }

  /**
   * Handle Selection of a Saved Vehicle (Stage 11B Autofill)
   */
  function handleSavedVehicleSelect() {
    if (!elements.savedVehicleSelect) return;

    // Critical: Do not allow modifying locked unresolved recovery attempt
    if (state.uncertainAttempt) {
      return;
    }

    const selectedId = elements.savedVehicleSelect.value;
    if (!selectedId) {
      // Manual entry selected or reset — do not wipe manual inputs
      return;
    }

    const vehicle = state.savedVehicles.find((v) => v.id === selectedId);
    if (!vehicle) return;

    // Explicit autofill
    if (elements.vehicleNumberInput) {
      elements.vehicleNumberInput.value = vehicle.registrationNumber;
      if (elements.vehicleNumberError) {
        elements.vehicleNumberError.hidden = true;
        elements.vehicleNumberError.textContent = '';
      }
    }

    const newType = (vehicle.type || 'car').toLowerCase();
    if (elements.vehicleTypeSelect) {
      elements.vehicleTypeSelect.value = newType;
      if (elements.vehicleTypeError) {
        elements.vehicleTypeError.hidden = true;
        elements.vehicleTypeError.textContent = '';
      }
    }

    // Check slot compatibility:
    // If changing vehicle type makes the selected slot incompatible,
    // clear the incompatible selection and refresh relevant availability
    // and recommendations using existing logic.
    if (state.selectedSlot) {
      const compatible = isSlotCompatible(state.selectedSlot.vehicleType, newType);
      if (!compatible) {
        const slotCode = state.selectedSlot.code;
        if (typeof showToast === 'function') {
          showToast(`Slot ${slotCode} is incompatible with ${newType.toUpperCase()} vehicles. Selection cleared.`, 'warning');
        }
        state.selectedSlot = null;
        closeBookingPanel();
        renderSlotGrid();
        loadRecommendations(newType);
        refreshAvailability();
      } else {
        updatePriceEstimate();
      }
    }
  }

  /**
   * Open the Booking Panel Drawer
   */
  function openBookingPanel() {
    if (!elements.panel || !state.selectedSlot) return;

    // Reset form errors
    clearFormErrors();

    // Populate panel slot summary
    setText(elements.panelSlotId, `Slot ${state.selectedSlot.code}`);
    setText(elements.panelSlotZone, `Zone ${state.selectedSlot.zone} • Floor ${state.selectedSlot.floor || 'G'}`);
    setText(elements.panelSlotPrice, `${formatPaiseToRupees(state.selectedSlot.pricePerHourPaise)} / hour`);

    if (elements.panelSlotDetails) {
      elements.panelSlotDetails.innerHTML = '';
      const typeSpan = document.createElement('span');
      typeSpan.className = 'facility-tag';
      typeSpan.textContent = `Type: ${(state.selectedSlot.vehicleType || 'Car').toUpperCase()}`;
      elements.panelSlotDetails.appendChild(typeSpan);

      if (state.selectedSlot.distanceFromEntry !== undefined) {
        const distSpan = document.createElement('span');
        distSpan.className = 'facility-tag';
        distSpan.textContent = `${state.selectedSlot.distanceFromEntry}m from entry`;
        elements.panelSlotDetails.appendChild(distSpan);
      }
    }

    if (elements.panelSlotFeatures) {
      elements.panelSlotFeatures.innerHTML = '';
      if (Array.isArray(state.selectedSlot.features) && state.selectedSlot.features.length > 0) {
        state.selectedSlot.features.forEach((f) => {
          const featSpan = document.createElement('span');
          featSpan.className = 'facility-tag';
          featSpan.textContent = f;
          elements.panelSlotFeatures.appendChild(featSpan);
        });
      }
    }

    // Default vehicle type to slot's compatible type ONLY when no saved vehicle is selected
    const selectedSavedVehicle = getSelectedSavedVehicle();
    if (selectedSavedVehicle) {
      if (elements.vehicleTypeSelect && selectedSavedVehicle.type) {
        elements.vehicleTypeSelect.value = (selectedSavedVehicle.type || 'car').toLowerCase();
      }
      if (elements.vehicleNumberInput && selectedSavedVehicle.registrationNumber) {
        elements.vehicleNumberInput.value = selectedSavedVehicle.registrationNumber;
      }
    } else if (elements.vehicleTypeSelect && state.selectedSlot.vehicleType) {
      elements.vehicleTypeSelect.value = state.selectedSlot.vehicleType;
    }

    updatePriceEstimate();

    // Show drawer
    elements.panel.classList.add('booking-panel--open');
    elements.panel.setAttribute('aria-hidden', 'false');
    if (elements.panelOverlay) {
      elements.panelOverlay.classList.add('booking-panel-overlay--visible');
      elements.panelOverlay.setAttribute('aria-hidden', 'false');
    }

    if (elements.vehicleNumberInput) {
      elements.vehicleNumberInput.focus();
    }
  }

  /**
   * Close the Booking Panel Drawer
   */
  function closeBookingPanel() {
    if (!elements.panel) return;
    elements.panel.classList.remove('booking-panel--open');
    elements.panel.setAttribute('aria-hidden', 'true');
    if (elements.panelOverlay) {
      elements.panelOverlay.classList.remove('booking-panel-overlay--visible');
      elements.panelOverlay.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Update Price Calculator strictly in integer paise
   */
  function updatePriceEstimate() {
    if (!elements.priceTotal || !elements.priceBreakdown) return;

    if (!state.selectedSlot || !elements.durationSelect || !elements.durationSelect.value) {
      setText(elements.priceTotal, '₹0.00');
      setText(elements.priceBreakdown, 'Select duration to calculate estimate');
      return;
    }

    const hours = parseInt(elements.durationSelect.value, 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
      setText(elements.priceTotal, '₹0.00');
      setText(elements.priceBreakdown, 'Duration must be between 1 and 24 hours');
      return;
    }

    const pricePerHourPaise = state.selectedSlot.pricePerHourPaise || 0;
    const totalPaise = calculateEstimatedPaise(pricePerHourPaise, hours);

    setText(elements.priceBreakdown, `${formatPaiseToRupees(pricePerHourPaise)}/hr × ${hours} hr(s) (Estimated)`);
    setText(elements.priceTotal, `${formatPaiseToRupees(totalPaise)}*`);
  }

  /**
   * Clear Form Field Errors
   */
  function clearFormErrors() {
    if (elements.vehicleTypeError) {
      elements.vehicleTypeError.hidden = true;
      elements.vehicleTypeError.textContent = '';
    }
    if (elements.vehicleNumberError) {
      elements.vehicleNumberError.hidden = true;
      elements.vehicleNumberError.textContent = '';
    }
    if (elements.durationError) {
      elements.durationError.hidden = true;
      elements.durationError.textContent = '';
    }
    if (elements.bookingFormError) {
      elements.bookingFormError.hidden = true;
      elements.bookingFormError.textContent = '';
    }
  }

  /**
   * Handle Booking Form Submission
   */
  async function handleBookingSubmit(e) {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }

    if (state.isSubmitting) return;
    clearFormErrors();

    // Block new submissions while an attempt is in-flight or uncertain
    if (state.uncertainAttempt) {
      const attemptLoc = state.uncertainAttempt.payload?.locationId || state.uncertainAttempt.locationId;
      const msg = attemptLoc && attemptLoc !== state.locationId
        ? `You have an unresolved booking attempt at location "${attemptLoc}". New bookings are blocked until it is resolved.`
        : 'You have an unresolved booking attempt in flight. Please retry or reconcile your original attempt before submitting a new booking.';
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') {
        showToast(msg, 'warning');
      }
      return;
    }

    // Block normal new submissions when facility is closed
    if (state.location && state.location.status === 'closed') {
      const msg = 'This parking facility is currently closed. Bookings are unavailable.';
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') {
        showToast(msg, 'error');
      }
      return;
    }

    if (!state.selectedSlot) {
      if (typeof showToast === 'function') {
        showToast('Please select a parking slot first.', 'error');
      }
      return;
    }

    const vehicleType = elements.vehicleTypeSelect ? elements.vehicleTypeSelect.value.trim() : '';
    const vehicleNumberRaw = elements.vehicleNumberInput ? elements.vehicleNumberInput.value.trim() : '';
    const durationHours = elements.durationSelect ? parseInt(elements.durationSelect.value, 10) : 0;

    // Field-level Validation
    let hasValidationError = false;
    if (!vehicleType) {
      if (elements.vehicleTypeError) {
        elements.vehicleTypeError.textContent = 'Please select a vehicle type.';
        elements.vehicleTypeError.hidden = false;
      }
      hasValidationError = true;
    } else if (!isSlotCompatible(state.selectedSlot.vehicleType, vehicleType)) {
      if (elements.vehicleTypeError) {
        elements.vehicleTypeError.textContent = `This slot accepts ${state.selectedSlot.vehicleType} vehicles only.`;
        elements.vehicleTypeError.hidden = false;
      }
      hasValidationError = true;
    }

    if (!vehicleNumberRaw) {
      if (elements.vehicleNumberError) {
        elements.vehicleNumberError.textContent = 'Please enter a vehicle registration number.';
        elements.vehicleNumberError.hidden = false;
      }
      hasValidationError = true;
    }

    if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24) {
      if (elements.durationError) {
        elements.durationError.textContent = 'Duration must be between 1 and 24 hours.';
        elements.durationError.hidden = false;
      }
      hasValidationError = true;
    }

    if (hasValidationError) return;

    // Normalize vehicle number to uppercase single space
    const vehicleNumber = vehicleNumberRaw.replace(/\s+/g, ' ').toUpperCase();

    // Fresh UUID v4 for new distinct attempt
    const requestId = generateUUIDv4();

    // Strictly constructed payload without forbidden server-derived fields
    const payload = {
      locationId: state.locationId,
      slotId: state.selectedSlot.id,
      vehicleNumber,
      vehicleType,
      durationHours,
      requestId,
    };

    const userId = getCurrentUserId();
    if (!userId) {
      const msg = 'User session expired or not authenticated. Please log in before booking.';
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') showToast(msg, 'error');
      return;
    }

    const attempt = {
      payload,
      requestId,
      userId,
      locationId: payload.locationId,
      timestamp: Date.now(),
      status: 'in_flight',
    };

    // 1. Persist the exact user-bound payload and requestId BEFORE sending the first POST
    try {
      saveUncertainAttempt(attempt);
    } catch (storageErr) {
      const msg = `Session storage failure: ${storageErr.message || 'Unable to secure recovery state'}. Booking submission cancelled to prevent unrecoverable state.`;
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') showToast(msg, 'error');
      return; // Do NOT dispatch unprotected booking
    }

    state.isSubmitting = true;
    if (elements.btnConfirmBooking) {
      if (typeof disableButton === 'function') {
        disableButton(elements.btnConfirmBooking, 'Securing Slot…');
      } else {
        elements.btnConfirmBooking.disabled = true;
      }
    }

    try {
      const response = await ApiClient.post('/api/bookings', payload);

      // Validate authoritative success
      if (!response || !response.success || !response.booking || !response.booking.id) {
        throw new Error('Server returned an unexpected or malformed booking response structure.');
      }

      // Successfully processed on server -> clear recovery
      clearUncertainAttempt();
      hideUncertainAlert();

      // Close drawer panel
      closeBookingPanel();

      // Render Authoritative Confirmation Card
      renderConfirmation(response.booking, response.idempotentRetry);

      // Refresh slot grid to reflect occupation
      loadSlots();

      if (typeof showToast === 'function') {
        const msg = response.idempotentRetry
          ? `Booking confirmed! Replayed existing reservation (${response.booking.id}).`
          : `Slot ${response.booking.slotCode} successfully booked!`;
        showToast(msg, 'success');
      }
    } catch (err) {
      handleSubmissionError(err, payload, requestId);
    } finally {
      state.isSubmitting = false;
      if (elements.btnConfirmBooking) {
        if (typeof enableButton === 'function') {
          enableButton(elements.btnConfirmBooking);
        } else {
          elements.btnConfirmBooking.disabled = false;
        }
      }
    }
  }

  /**
   * Dedicated Retry Path for Uncertain Booking Attempts
   * Submits the original immutable payload and requestId directly,
   * independent of current form fields, selection, or availability state.
   */
  async function handleRetryUncertain() {
    if (!state.uncertainAttempt) return;
    if (state.isSubmitting) return;

    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
      const msg = 'Authentication session expired. Please log in again to recover your booking.';
      if (typeof showToast === 'function') showToast(msg, 'warning');
      if (typeof requireAuth === 'function') {
        const returnLoc = state.uncertainAttempt?.payload?.locationId || state.locationId;
        requireAuth(`booking.html?locationId=${encodeURIComponent(returnLoc)}`);
      }
      return;
    }

    const { payload, requestId, userId } = state.uncertainAttempt;
    if (!payload || !requestId) {
      if (typeof showToast === 'function') showToast('Corrupted recovery attempt. Cannot retry.', 'error');
      return;
    }

    // Ownership check: must match current logged in user
    if (userId && userId !== currentUserId) {
      const msg = 'Unauthorized: This booking attempt belongs to a different user account.';
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') showToast(msg, 'error');
      return;
    }

    // Validate payload fields
    if (
      !payload.locationId ||
      !payload.slotId ||
      !payload.vehicleNumber ||
      !payload.vehicleType ||
      !payload.durationHours ||
      payload.requestId !== requestId
    ) {
      const msg = 'Invalid recovery payload data.';
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = msg;
        elements.bookingFormError.hidden = false;
      }
      if (typeof showToast === 'function') showToast(msg, 'error');
      return;
    }

    state.isSubmitting = true;
    if (elements.btnRetryUncertain) {
      if (typeof disableButton === 'function') {
        disableButton(elements.btnRetryUncertain, 'Retrying Original Attempt…');
      } else {
        elements.btnRetryUncertain.disabled = true;
      }
    }

    try {
      const response = await ApiClient.post('/api/bookings', payload);

      if (!response || !response.success || !response.booking || !response.booking.id) {
        throw new Error('Server returned an unexpected or malformed booking response structure.');
      }

      // Successfully processed / replayed on server
      clearUncertainAttempt();
      hideUncertainAlert();

      closeBookingPanel();
      renderConfirmation(response.booking, response.idempotentRetry);
      if (state.locationId === payload.locationId) {
        loadSlots();
      }

      if (typeof showToast === 'function') {
        const msg = response.idempotentRetry
          ? `Booking confirmed! Replayed existing reservation (${response.booking.id}).`
          : `Slot ${response.booking.slotCode} successfully booked!`;
        showToast(msg, 'success');
      }
    } catch (err) {
      handleSubmissionError(err, payload, requestId);
    } finally {
      state.isSubmitting = false;
      if (elements.btnRetryUncertain) {
        if (typeof enableButton === 'function') {
          enableButton(elements.btnRetryUncertain);
        } else {
          elements.btnRetryUncertain.disabled = false;
        }
      }
    }
  }

  /**
   * Handle Booking Submission Errors
   */
  function handleSubmissionError(err, payload, requestId) {
    if (err.status === 401) {
      // Session expired -> redirect to login with safe return target
      // Do NOT clear recovery attempt! Keep recovery intact through login expiry and same-user re-login.
      if (typeof requireAuth === 'function') {
        requireAuth(`booking.html?locationId=${encodeURIComponent(state.locationId)}`);
      }
      return;
    }

    if (err.status === 409) {
      if (err.code === 'SLOT_UNAVAILABLE' || err.code === 'SLOT_NOT_ENABLED') {
        clearUncertainAttempt();
        hideUncertainAlert();
        const msg = 'This parking slot was just taken by another user. Please choose another slot.';
        if (elements.bookingFormError) {
          elements.bookingFormError.textContent = msg;
          elements.bookingFormError.hidden = false;
        }
        if (typeof showToast === 'function') showToast(msg, 'error');
        state.selectedSlot = null;
        closeBookingPanel();
        loadSlots();
        return;
      }

      if (err.code === 'REQUEST_ID_REUSED') {
        const msg = 'Request ID Conflict: This request identifier was already submitted with different details. Reconciliation required; this attempt cannot be submitted as a new booking.';
        if (elements.bookingFormError) {
          elements.bookingFormError.textContent = msg;
          elements.bookingFormError.hidden = false;
        }
        if (typeof showToast === 'function') showToast(msg, 'error');
        showUncertainAlert(msg);
        return;
      }

      if (err.code === 'LOCATION_NOT_ACTIVE') {
        clearUncertainAttempt();
        hideUncertainAlert();
        const msg = 'This facility is currently closed and not accepting bookings.';
        if (elements.bookingFormError) {
          elements.bookingFormError.textContent = msg;
          elements.bookingFormError.hidden = false;
        }
        if (elements.locationClosedBanner) elements.locationClosedBanner.hidden = false;
        return;
      }

      if (err.code === 'VEHICLE_TYPE_MISMATCH') {
        clearUncertainAttempt();
        hideUncertainAlert();
        const msg = err.message || 'Vehicle type mismatch for this slot.';
        if (elements.bookingFormError) {
          elements.bookingFormError.textContent = msg;
          elements.bookingFormError.hidden = false;
        }
        return;
      }
    }

    if (err.status === 400) {
      clearUncertainAttempt();
      hideUncertainAlert();
      if (elements.bookingFormError) {
        elements.bookingFormError.textContent = err.message || 'Validation failed. Please check the booking form.';
        elements.bookingFormError.hidden = false;
      }
      return;
    }

    if (err.status === 404 && err.code === 'LOCATION_NOT_FOUND') {
      clearUncertainAttempt();
      hideUncertainAlert();
      showLocationError('Facility Not Found', 'The requested parking facility no longer exists.');
      return;
    }

    // Network Failure / Timeout / 5xx Server Error / Malformed Response -> Outcome is UNCERTAIN
    // Do NOT claim the booking failed; its outcome remains unknown.
    const attempt = {
      payload,
      requestId,
      userId: getCurrentUserId(),
      locationId: payload.locationId,
      timestamp: Date.now(),
      status: 'uncertain',
    };
    try {
      saveUncertainAttempt(attempt);
    } catch {}
    showUncertainAlert(
      err.message || 'Connection interrupted. Your booking may have already succeeded on the server.'
    );
  }

  /**
   * Show Uncertain Booking Banner
   */
  function showUncertainAlert(message) {
    if (!elements.uncertainAlert) return;
    elements.uncertainAlert.hidden = false;
    if (elements.savedVehicleSelect) {
      elements.savedVehicleSelect.disabled = true;
    }
    const attempt = state.uncertainAttempt;
    const reqId = attempt?.requestId || '—';
    const locId = attempt?.payload?.locationId || attempt?.locationId;

    if (elements.uncertainMessage) {
      if (locId && state.locationId && locId !== state.locationId) {
        elements.uncertainMessage.textContent = `You have an unresolved booking attempt in flight for location "${locId}" (Request ID: ${reqId}). New bookings are blocked until this attempt is resolved. You can retry the original booking now or return to that facility.`;
      } else {
        elements.uncertainMessage.textContent = `${message} Your attempt has been saved with request identifier ${reqId}. You can safely retry with the original request ID or reconcile status.`;
      }
    }

    if (elements.btnReturnUncertain) {
      if (locId && state.locationId && locId !== state.locationId) {
        elements.btnReturnUncertain.href = `booking.html?locationId=${encodeURIComponent(locId)}`;
        elements.btnReturnUncertain.textContent = `Return to Facility (${locId})`;
        elements.btnReturnUncertain.hidden = false;
      } else {
        elements.btnReturnUncertain.hidden = true;
      }
    }
  }

  /**
   * Hide Uncertain Booking Banner
   */
  function hideUncertainAlert() {
    if (elements.uncertainAlert) {
      elements.uncertainAlert.hidden = true;
    }
    if (elements.btnReturnUncertain) {
      elements.btnReturnUncertain.hidden = true;
    }
    if (elements.savedVehicleSelect) {
      elements.savedVehicleSelect.disabled = false;
    }
  }

  /**
   * Render Authoritative Confirmation Card from Backend Response
   */
  function renderConfirmation(booking, isIdempotentRetry) {
    if (!elements.confirmationCard) return;

    elements.confirmationCard.hidden = false;
    if (elements.workflowContainer) elements.workflowContainer.hidden = true;

    if (elements.confIdempotentBadge) {
      elements.confIdempotentBadge.hidden = !isIdempotentRetry;
    }

    setText(elements.confBookingId, booking.id || '—');
    setText(
      elements.confLocationSlot,
      `${booking.locationName || state.location?.name || 'Facility'} • Slot ${booking.slotCode || '—'}`
    );

    const vehicleReg = booking.vehicle?.registrationNumber || '—';
    const vehicleType = booking.vehicle?.type ? booking.vehicle.type.toUpperCase() : 'CAR';
    setText(elements.confVehicle, `${vehicleReg} (${vehicleType})`);

    const startStr = booking.startTime ? new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Immediate';
    const endStr = booking.endTime ? new Date(booking.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    setText(elements.confSchedule, `${booking.durationHours || 1} hr (${startStr} – ${endStr})`);

    setText(elements.confTotalPrice, formatPaiseToRupees(booking.totalPaise));
    setText(elements.confStatus, (booking.status || 'active').toUpperCase());

    // Scroll confirmation into view
    elements.confirmationCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * 15-Second Polling Refresh Loop
   */
  async function refreshAvailability() {
    if (state.isPolling || state.hasLocationError || !state.locationId) return;
    state.isPolling = true;
    state.slotRequestSeq = (state.slotRequestSeq || 0) + 1;
    state.pollSequence = state.slotRequestSeq;
    const thisSeq = state.slotRequestSeq;

    try {
      const res = await ApiClient.get(`/api/locations/${encodeURIComponent(state.locationId)}/slots`);

      // Race condition check: ignore stale response
      if (thisSeq !== state.slotRequestSeq) return;

      if (!res || !res.success || !Array.isArray(res.slots)) return;

      // Update authoritative location status from refresh response
      if (res.locationStatus) {
        if (state.location) state.location.status = res.locationStatus;
        const isClosed = res.locationStatus === 'closed';
        if (elements.selectedLocationStatus) {
          elements.selectedLocationStatus.className = `status-badge ${isClosed ? 'status-badge--closed' : 'status-badge--active'}`;
          setText(elements.selectedLocationStatus, isClosed ? 'Closed' : 'Active');
        }
        if (elements.locationClosedBanner) {
          elements.locationClosedBanner.hidden = !isClosed;
        }
        if (isClosed && elements.btnConfirmBooking) {
          elements.btnConfirmBooking.disabled = true;
        } else if (!isClosed && elements.btnConfirmBooking && !state.isSubmitting) {
          elements.btnConfirmBooking.disabled = false;
        }
      }

      state.slots = res.slots;
      renderZoneTabs();
      renderSlotGrid();

      // Check selected slot validity unless protected by in-flight or uncertain attempt
      const isProtected = state.isSubmitting || !!state.uncertainAttempt;
      if (state.selectedSlot) {
        const updated = state.slots.find((s) => s.id === state.selectedSlot.id);
        const isCompatible = updated && isSlotCompatible(updated.vehicleType, state.activeFilters.vehicleType);

        if (!updated || !updated.available || !isCompatible) {
          if (!isProtected) {
            const reason = !updated
              ? 'is no longer available'
              : !updated.available
              ? 'was just booked by another user'
              : 'is incompatible with your vehicle filter';
            if (typeof showToast === 'function') {
              showToast(`Slot ${state.selectedSlot.code} ${reason}.`, 'warning');
            }
            state.selectedSlot = null;
            closeBookingPanel();
            renderSlotGrid();
          }
        } else {
          // Update price preview from refreshed slot data without losing form inputs
          state.selectedSlot = updated;
          setText(elements.panelSlotPrice, `${formatPaiseToRupees(updated.pricePerHourPaise)} / hour`);
          updatePriceEstimate();
        }
      }
    } catch (err) {
      if (thisSeq !== state.slotRequestSeq) return;
      if (err && err.status === 404) {
        // Handle location 404 explicitly
        showLocationError(
          'Parking Facility Unavailable',
          'The requested parking facility could not be found. It may have been archived or removed.'
        );
      }
    } finally {
      state.isPolling = false;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        refreshAvailability();
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /**
   * Filter Event Handlers
   */
  function selectZoneFilter(zone) {
    state.activeFilters.zone = zone;
    if (elements.filterZone) elements.filterZone.value = zone;
    renderZoneTabs();
    renderSlotGrid();
  }

  function handleFilterApply() {
    if (elements.filterVehicleType) {
      state.activeFilters.vehicleType = elements.filterVehicleType.value;
      loadRecommendations(state.activeFilters.vehicleType);
    }
    if (elements.filterZone) {
      state.activeFilters.zone = elements.filterZone.value;
    }
    if (elements.filterFloor) {
      state.activeFilters.floor = elements.filterFloor.value;
    }
    renderZoneTabs();
    renderSlotGrid();
  }

  /**
   * Reset booking view to allow another booking
   */
  function bookAnotherSlot() {
    state.selectedSlot = null;
    // Do NOT silently erase an unresolved attempt
    if (!state.uncertainAttempt) {
      hideUncertainAlert();
    }

    if (elements.confirmationCard) elements.confirmationCard.hidden = true;
    if (elements.workflowContainer) elements.workflowContainer.hidden = false;

    renderSlotGrid();
    loadSlots();
  }

  /**
   * Bind event listeners
   */
  function bindEvents() {
    if (elements.btnLogout) {
      elements.btnLogout.onclick = () => {
        if (typeof logoutUser === 'function') logoutUser();
      };
    }

    if (elements.btnApplyFilters) {
      elements.btnApplyFilters.onclick = handleFilterApply;
    }

    if (elements.filterVehicleType) {
      elements.filterVehicleType.onchange = () => {
        state.activeFilters.vehicleType = elements.filterVehicleType.value;
        loadRecommendations(state.activeFilters.vehicleType);
        renderSlotGrid();
      };
    }

    if (elements.filterZone) {
      elements.filterZone.onchange = () => {
        state.activeFilters.zone = elements.filterZone.value;
        renderZoneTabs();
        renderSlotGrid();
      };
    }

    if (elements.filterFloor) {
      elements.filterFloor.onchange = () => {
        state.activeFilters.floor = elements.filterFloor.value;
        renderSlotGrid();
      };
    }

    if (elements.btnClosePanel) elements.btnClosePanel.onclick = closeBookingPanel;
    if (elements.btnCancelPanel) elements.btnCancelPanel.onclick = closeBookingPanel;
    if (elements.panelOverlay) elements.panelOverlay.onclick = closeBookingPanel;

    if (elements.durationSelect) {
      elements.durationSelect.onchange = updatePriceEstimate;
    }

    if (elements.savedVehicleSelect) {
      elements.savedVehicleSelect.onchange = handleSavedVehicleSelect;
    }

    if (elements.vehicleTypeSelect) {
      elements.vehicleTypeSelect.onchange = () => {
        if (elements.savedVehicleSelect && elements.savedVehicleSelect.value) {
          const v = state.savedVehicles.find((x) => x.id === elements.savedVehicleSelect.value);
          if (v && v.type !== elements.vehicleTypeSelect.value) {
            elements.savedVehicleSelect.value = '';
          }
        }
        if (state.selectedSlot && !isSlotCompatible(state.selectedSlot.vehicleType, elements.vehicleTypeSelect.value)) {
          if (elements.vehicleTypeError) {
            elements.vehicleTypeError.textContent = `This slot accepts ${state.selectedSlot.vehicleType} vehicles only.`;
            elements.vehicleTypeError.hidden = false;
          }
        } else {
          if (elements.vehicleTypeError) elements.vehicleTypeError.hidden = true;
        }
      };
    }

    if (elements.vehicleNumberInput) {
      elements.vehicleNumberInput.oninput = () => {
        if (elements.savedVehicleSelect && elements.savedVehicleSelect.value) {
          const v = state.savedVehicles.find((x) => x.id === elements.savedVehicleSelect.value);
          if (v && v.registrationNumber !== elements.vehicleNumberInput.value.trim().toUpperCase()) {
            elements.savedVehicleSelect.value = '';
          }
        }
        if (elements.vehicleNumberError) elements.vehicleNumberError.hidden = true;
        if (elements.bookingFormError) elements.bookingFormError.hidden = true;
      };
    }

    if (elements.bookingForm) {
      elements.bookingForm.onsubmit = handleBookingSubmit;
    }

    if (elements.btnBookAnother) {
      elements.btnBookAnother.onclick = bookAnotherSlot;
    }

    // Dedicated Uncertain Attempt Retry path
    if (elements.btnRetryUncertain) {
      elements.btnRetryUncertain.onclick = handleRetryUncertain;
    }

    if (elements.btnDiscardUncertain) {
      elements.btnDiscardUncertain.onclick = () => {
        if (typeof showToast === 'function') {
          showToast('Cannot discard unresolved attempt. Please retry to reconcile status with the server.', 'warning');
        }
      };
    }

    // Visibility change listener for 15s polling
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          refreshAvailability();
        }
      });
    }

    // Polling cleanup on unload
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', stopPolling);
    }
  }

  /**
   * Boot the Booking Page
   */
  async function init() {
    cacheElements();
    bindEvents();

    // 1. Extract and validate locationId from URL query
    if (typeof window !== 'undefined' && window.location) {
      const sp = new URLSearchParams(window.location.search);
      state.locationId = sp.get('locationId');
    }

    if (!state.locationId || !state.locationId.trim()) {
      showLocationError(
        'No Location Selected',
        'Please select a parking facility from our discovery map to book a slot.'
      );
      return;
    }
    state.locationId = state.locationId.trim();

    // 2. Verified authentication guard (preserves return destination on 401)
    const user = typeof requireAuth === 'function'
      ? await requireAuth(`booking.html?locationId=${encodeURIComponent(state.locationId)}`)
      : null;

    if (!user) return; // requireAuth redirects or renders retry banner

    if (elements.headerUserName && user.name) {
      setText(elements.headerUserName, user.name);
    }

    // Restore any unresolved attempt from user-scoped session state
    restoreUncertainAttempt();

    // Load saved vehicles for autofill independently (failure or delay must not block page or manual booking)
    loadSavedVehicles().catch(() => {});

    // 3. Load location details
    const locOk = await loadLocationDetails();
    if (!locOk) return;

    // 4. Load location slots
    await loadSlots();

    // 5. Start availability polling
    startPolling();
  }

  return {
    init,
    state,
    elements,
    calculateEstimatedPaise,
    formatPaiseToRupees,
    isSlotCompatible,
    generateUUIDv4,
    loadLocationDetails,
    loadSlots,
    loadRecommendations,
    selectSlot,
    handleBookingSubmit,
    handleRetryUncertain,
    saveUncertainAttempt,
    clearUncertainAttempt,
    restoreUncertainAttempt,
    refreshAvailability,
    startPolling,
    stopPolling,
    loadSavedVehicles,
    renderSavedVehicleOptions,
    handleSavedVehicleSelect,
    getSelectedSavedVehicle,
    SAVED_VEHICLES_TIMEOUT_MS,
  };
})();

// Auto-boot in browser
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', BookingApp.init);
  } else {
    BookingApp.init();
  }
}

// Export for Node/CommonJS test runners
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BookingApp,
    calculateEstimatedPaise,
    formatPaiseToRupees,
    isSlotCompatible,
    generateUUIDv4,
    POLL_INTERVAL_MS,
    UUID_V4_RE,
  };
}
