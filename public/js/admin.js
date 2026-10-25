// public/js/admin.js — Admin Management Console Controller
/* ============================================================
   Smart Parking System — Admin Management Console
   
   PURPOSE:
   Manages parking locations, separate slot inventories, and
   booking oversight.
   
   DEPENDS ON (loaded in admin.html):
     - vendor/leaflet/leaflet.js (optional/graceful degradation)
     - js/storage.js             → SessionStore
     - js/api.js                 → ApiClient, ApiError
     - js/utils.js               → getElement, setText, showToast,
                                   redirectTo, formatCurrency, formatDateTime
     - js/auth.js                → requireAdminAuth, verifySession, logoutUser
   ============================================================ */

'use strict';

// ── Constants & Whitelists ────────────────────────────────────

/** Allowed fields for creating or updating a location (Strict backend match) */
const ALLOWED_LOCATION_FIELDS = new Set([
  'name',
  'category',
  'address',
  'city',
  'area',
  'contactPhone',
  'latitude',
  'longitude',
  'facilities',
]);

/** Allowed categories for parking locations (matching ParkingLocation model strictly) */
const ALLOWED_CATEGORIES = new Set(['mall', 'hospital', 'office', 'other']);

/** Allowed vehicle types for slots (matching ParkingSlot model strictly, no truck) */
const ALLOWED_VEHICLE_TYPES = new Set(['car', 'bike', 'ev']);

/** Known standard facilities managed via checkboxes in the admin UI */
const KNOWN_FACILITY_VALUES = new Set([
  'cctv',
  'ev-charging',
  'covered',
  'valet',
  'disabled-access',
  'security-guard',
]);

/** Known standard slot features managed via checkboxes in the admin UI */
const KNOWN_SLOT_FEATURE_VALUES = new Set([
  'covered',
  'ev-charging',
  'disabled-accessible',
  'wide-space',
]);

/** Allowed fields for creating or updating a slot */
const ALLOWED_SLOT_FIELDS = new Set([
  'code',
  'zone',
  'floor',
  'vehicleType',
  'pricePerHourPaise',
  'distanceFromEntry',
  'features',
]);

// ── Pure Utility Functions (Exportable for Unit Tests) ─────────

/**
 * Validate latitude and longitude.
 * Explicitly allows (0, 0) as valid coordinates.
 * Rejects non-finite numbers and out-of-bounds coordinates.
 *
 * @param {any} lat
 * @param {any} lng
 * @returns {{ valid: boolean, lat?: number, lng?: number, error?: string }}
 */
function validateCoordinates(lat, lng) {
  if (lat === '' || lat === null || lat === undefined || lng === '' || lng === null || lng === undefined) {
    return { valid: true, lat: undefined, lng: undefined };
  }

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);

  if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
    return { valid: false, error: 'Latitude must be a valid number between -90 and 90.' };
  }

  if (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) {
    return { valid: false, error: 'Longitude must be a valid number between -180 and 180.' };
  }

  return { valid: true, lat: parsedLat, lng: parsedLng };
}

/**
 * Convert Rupee decimal string/number to integer paise.
 * Validates format to prevent casual floating-point rounding issues.
 * Accepts formats like "50", "45.50", "100.2".
 *
 * @param {string|number} rupeeVal
 * @returns {{ valid: boolean, paise?: number, error?: string }}
 */
function convertRupeesToPaise(rupeeVal) {
  if (rupeeVal === '' || rupeeVal === null || rupeeVal === undefined) {
    return { valid: true, paise: undefined };
  }

  const str = String(rupeeVal).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return { valid: false, error: 'Price must be a valid positive amount with up to 2 decimal places (e.g. 50 or 45.50).' };
  }

  const parsed = parseFloat(str);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { valid: false, error: 'Price cannot be negative.' };
  }

  const paise = Math.round(parsed * 100);
  return { valid: true, paise };
}

/**
 * Format integer paise into display rupees string (e.g. 5000 -> "₹50.00").
 *
 * @param {number} paise
 * @returns {string}
 */
function formatPaiseToRupees(paise) {
  if (!Number.isFinite(paise) || paise < 0) return '₹0.00';
  return `₹${(paise / 100).toFixed(2)}`;
}

/**
 * Merge user-selected checkbox items with existing custom/unrepresented items.
 * Preserves custom items stored in DB while allowing user to toggle managed items.
 *
 * @param {string[]} existingList
 * @param {string[]} checkedList
 * @param {Set<string>} knownSet
 * @returns {string[]}
 */
function mergePreservedItems(existingList, checkedList, knownSet) {
  const preserved = (Array.isArray(existingList) ? existingList : []).filter(
    (item) => typeof item === 'string' && item.trim() && !knownSet.has(item.trim().toLowerCase())
  );
  const checked = (Array.isArray(checkedList) ? checkedList : [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  return Array.from(new Set([...preserved, ...checked]));
}

/**
 * Construct strict Location payload containing only allowed fields.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function buildLocationPayload(raw) {
  const payload = {};
  if (raw.name !== undefined) payload.name = String(raw.name).trim();
  if (raw.category !== undefined) {
    const cat = String(raw.category).trim().toLowerCase();
    payload.category = ALLOWED_CATEGORIES.has(cat) ? cat : 'other';
  }
  if (raw.address !== undefined) payload.address = String(raw.address).trim();
  if (raw.city !== undefined) payload.city = String(raw.city).trim();
  if (raw.area !== undefined) payload.area = String(raw.area).trim();
  if (raw.contactPhone !== undefined) payload.contactPhone = String(raw.contactPhone).trim();

  if (raw.latitude !== undefined && raw.latitude !== null && raw.latitude !== '') {
    const lat = parseFloat(raw.latitude);
    if (Number.isFinite(lat)) payload.latitude = lat;
  }
  if (raw.longitude !== undefined && raw.longitude !== null && raw.longitude !== '') {
    const lng = parseFloat(raw.longitude);
    if (Number.isFinite(lng)) payload.longitude = lng;
  }

  if (Array.isArray(raw.facilities)) {
    payload.facilities = raw.facilities.map((f) => String(f).trim()).filter(Boolean);
  }

  // Strip any keys not in ALLOWED_LOCATION_FIELDS
  for (const k of Object.keys(payload)) {
    if (!ALLOWED_LOCATION_FIELDS.has(k)) {
      delete payload[k];
    }
  }

  return payload;
}

/**
 * Construct strict Slot payload containing only allowed fields.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function buildSlotPayload(raw) {
  const payload = {};
  if (raw.code !== undefined) payload.code = String(raw.code).trim().toUpperCase();
  if (raw.zone !== undefined) payload.zone = String(raw.zone).trim().toUpperCase();
  if (raw.floor !== undefined && raw.floor !== '') {
    const fl = parseInt(raw.floor, 10);
    if (Number.isInteger(fl)) payload.floor = fl;
  }
  if (raw.vehicleType !== undefined) {
    const vt = String(raw.vehicleType).trim().toLowerCase();
    payload.vehicleType = ALLOWED_VEHICLE_TYPES.has(vt) ? vt : 'car';
  }
  if (raw.pricePerHourPaise !== undefined && Number.isInteger(raw.pricePerHourPaise)) {
    payload.pricePerHourPaise = raw.pricePerHourPaise;
  }
  if (raw.distanceFromEntry !== undefined && raw.distanceFromEntry !== '') {
    const d = parseFloat(raw.distanceFromEntry);
    if (Number.isFinite(d)) payload.distanceFromEntry = d;
  }
  if (Array.isArray(raw.features)) {
    payload.features = raw.features.map((f) => String(f).trim()).filter(Boolean);
  }

  for (const k of Object.keys(payload)) {
    if (!ALLOWED_SLOT_FIELDS.has(k)) {
      delete payload[k];
    }
  }

  return payload;
}

// ── Admin Console Application Controller ──────────────────────

class AdminConsoleApp {
  constructor() {
    this.currentUser = null;
    this.activeTab = 'overview';

    // State for locations
    this.locations = [];
    this.locationsPage = 1;
    this.locationsLimit = 10;
    this.locationsTotal = 0;
    this.locationsStatusFilter = '';
    this.locationsRequestSeq = 0; // Guard against out-of-order responses

    // Global location picker state (decoupled from paginated/filtered locations table)
    this.pickerLocations = [];
    this.pickersRequestSeq = 0;

    // State for selected location & slots
    this.selectedLocationId = null;
    this.selectedLocation = null;
    this.slots = [];
    this.slotsRequestSeq = 0; // Guard against out-of-order responses

    // State for bookings
    this.bookings = [];
    this.bookingsPage = 1;
    this.bookingsLimit = 10;
    this.bookingsTotal = 0;
    this.bookingsLocationFilter = '';
    this.bookingsStatusFilter = '';
    this.bookingsRequestSeq = 0; // Guard against out-of-order responses

    // Map picker state
    this.leafletMap = null;
    this.mapMarker = null;
    this.isMapReady = false;

    // Track active editing models and modal focus
    this.editingLocation = null;
    this.editingSlot = null;
    this.activeModal = null;
    this.lastFocusedElement = null;

    // Re-entrancy guards against duplicate submissions
    this.isSubmittingLocation = false;
    this.isSubmittingSlot = false;
    this.isPerformingLifecycle = false;

    // Elements cache
    this.el = {};
  }

  /**
   * Bootstraps the admin console.
   * Enforces backend server authentication and role check before rendering.
   */
  async init() {
    this.cacheElements();
    this.bindEvents();

    if (this.el.initialLoading) this.el.initialLoading.classList.remove('hidden');

    try {
      // Require server-verified admin identity
      const authResult = await requireAdminAuth('admin.html');

      if (!authResult.authorized) {
        if (this.el.initialLoading) this.el.initialLoading.classList.add('hidden');
        if (authResult.denied) {
          // Standard user -> show access denied container
          if (this.el.accessDenied) this.el.accessDenied.classList.remove('hidden');
          if (this.el.consoleApp) this.el.consoleApp.classList.add('hidden');
        }
        return;
      }

      this.currentUser = authResult.user;
      if (this.el.adminBadge) {
        this.el.adminBadge.textContent = `${this.currentUser.name} (Admin)`;
      }

      // Hide loading & access denied; show admin console
      if (this.el.initialLoading) this.el.initialLoading.classList.add('hidden');
      if (this.el.accessDenied) this.el.accessDenied.classList.add('hidden');
      if (this.el.consoleApp) this.el.consoleApp.classList.remove('hidden');

      // Load initial overview metrics, picker dropdowns, and locations table
      await this.loadOverview();
      await this.loadAllLocationsForPickers();
      await this.loadLocations();
    } catch (err) {
      console.error('[AdminConsole] Initialization error:', err);
      if (this.el.initialLoading) this.el.initialLoading.classList.add('hidden');
      this.showGlobalAlert('Failed to initialize admin session. Please reload or log in again.', 'error');
    }
  }

  cacheElements() {
    this.el = {
      initialLoading: document.getElementById('admin-initial-loading'),
      accessDenied: document.getElementById('admin-access-denied'),
      consoleApp: document.getElementById('admin-console-app'),
      adminBadge: document.getElementById('admin-user-badge'),
      btnLogout: document.getElementById('btn-admin-logout'),
      btnRefreshAll: document.getElementById('btn-refresh-all'),

      // Global Alert
      globalAlert: document.getElementById('admin-global-alert'),
      globalAlertMessage: document.getElementById('admin-global-alert-message'),
      btnCloseGlobalAlert: document.getElementById('btn-close-global-alert'),

      // Tab Buttons
      tabBtnOverview: document.getElementById('tab-btn-overview'),
      tabBtnLocations: document.getElementById('tab-btn-locations'),
      tabBtnSlots: document.getElementById('tab-btn-slots'),
      tabBtnBookings: document.getElementById('tab-btn-bookings'),

      // Tab Panels
      panelOverview: document.getElementById('panel-overview'),
      panelLocations: document.getElementById('panel-locations'),
      panelSlots: document.getElementById('panel-slots'),
      panelBookings: document.getElementById('panel-bookings'),

      // Overview Metrics
      overviewLoading: document.getElementById('overview-loading'),
      metricLocTotal: document.getElementById('metric-loc-total'),
      metricLocDraft: document.getElementById('metric-loc-draft'),
      metricLocActive: document.getElementById('metric-loc-active'),
      metricLocClosed: document.getElementById('metric-loc-closed'),
      metricLocArchived: document.getElementById('metric-loc-archived'),
      metricSlotsTotal: document.getElementById('metric-slots-total'),
      metricSlotsEnabled: document.getElementById('metric-slots-enabled'),
      metricSlotsMaintenance: document.getElementById('metric-slots-maintenance'),
      metricSlotsArchived: document.getElementById('metric-slots-archived'),
      metricBookingsTotal: document.getElementById('metric-bookings-total'),
      metricBookingsActive: document.getElementById('metric-bookings-active'),
      metricBookingsCompleted: document.getElementById('metric-bookings-completed'),
      metricBookingsCancelled: document.getElementById('metric-bookings-cancelled'),
      metricUsersTotal: document.getElementById('metric-users-total'),

      // Locations Tab
      filterLocationStatus: document.getElementById('filter-location-status'),
      btnOpenAddLocation: document.getElementById('btn-open-add-location'),
      btnRefreshLocations: document.getElementById('btn-refresh-locations'),
      locationsLoading: document.getElementById('locations-loading'),
      locationsError: document.getElementById('locations-error'),
      locationsErrorMessage: document.getElementById('locations-error-message'),
      btnRetryLocations: document.getElementById('btn-retry-locations'),
      locationsEmpty: document.getElementById('locations-empty'),
      locationsTableWrapper: document.getElementById('locations-table-wrapper'),
      locationsTbody: document.getElementById('locations-tbody'),
      btnPrevLocations: document.getElementById('btn-prev-locations'),
      btnNextLocations: document.getElementById('btn-next-locations'),
      locationsPageInfo: document.getElementById('locations-page-info'),

      // Slots Tab
      slotsParentHeader: document.getElementById('slots-parent-header'),
      slotsParentName: document.getElementById('slots-parent-name'),
      slotsParentMeta: document.getElementById('slots-parent-meta'),
      selectSlotLocation: document.getElementById('select-slot-location'),
      btnOpenAddSlot: document.getElementById('btn-open-add-slot'),
      btnRefreshSlots: document.getElementById('btn-refresh-slots'),
      slotsNoSelection: document.getElementById('slots-no-selection'),
      slotsTableCard: document.getElementById('slots-table-card'),
      slotsLoading: document.getElementById('slots-loading'),
      slotsError: document.getElementById('slots-error'),
      slotsErrorMessage: document.getElementById('slots-error-message'),
      btnRetrySlots: document.getElementById('btn-retry-slots'),
      slotsEmpty: document.getElementById('slots-empty'),
      slotsTableWrapper: document.getElementById('slots-table-wrapper'),
      slotsTbody: document.getElementById('slots-tbody'),

      // Bookings Tab
      filterBookingLocation: document.getElementById('filter-booking-location'),
      filterBookingStatus: document.getElementById('filter-booking-status'),
      btnRefreshBookings: document.getElementById('btn-refresh-bookings'),
      bookingsLoading: document.getElementById('bookings-loading'),
      bookingsError: document.getElementById('bookings-error'),
      bookingsErrorMessage: document.getElementById('bookings-error-message'),
      btnRetryBookings: document.getElementById('btn-retry-bookings'),
      bookingsEmpty: document.getElementById('bookings-empty'),
      bookingsTableWrapper: document.getElementById('bookings-table-wrapper'),
      bookingsTbody: document.getElementById('bookings-tbody'),
      btnPrevBookings: document.getElementById('btn-prev-bookings'),
      btnNextBookings: document.getElementById('btn-next-bookings'),
      bookingsPageInfo: document.getElementById('bookings-page-info'),

      // Location Modal
      modalLocation: document.getElementById('modal-location'),
      modalLocationTitle: document.getElementById('modal-location-title'),
      btnCloseLocationModal: document.getElementById('btn-close-location-modal'),
      btnCancelLocation: document.getElementById('btn-cancel-location'),
      formLocation: document.getElementById('form-location'),
      locId: document.getElementById('loc-id'),
      locName: document.getElementById('loc-name'),
      locCategory: document.getElementById('loc-category'),
      locAddress: document.getElementById('loc-address'),
      locCity: document.getElementById('loc-city'),
      locArea: document.getElementById('loc-area'),
      locPhone: document.getElementById('loc-phone'),
      locLatitude: document.getElementById('loc-latitude'),
      locLongitude: document.getElementById('loc-longitude'),
      btnClearPin: document.getElementById('btn-clear-pin'),
      adminMapElement: document.getElementById('admin-map'),
      adminMapFallback: document.getElementById('admin-map-fallback'),
      btnSaveLocation: document.getElementById('btn-save-location'),
      locFormError: document.getElementById('loc-form-error'),
      locFormErrorText: document.getElementById('loc-form-error-text'),
      locFormErrorViolations: document.getElementById('loc-form-error-violations'),

      // Slot Modal
      modalSlot: document.getElementById('modal-slot'),
      modalSlotTitle: document.getElementById('modal-slot-title'),
      btnCloseSlotModal: document.getElementById('btn-close-slot-modal'),
      btnCancelSlot: document.getElementById('btn-cancel-slot'),
      formSlot: document.getElementById('form-slot'),
      slotId: document.getElementById('slot-id'),
      slotLocationId: document.getElementById('slot-location-id'),
      slotCode: document.getElementById('slot-code'),
      slotZone: document.getElementById('slot-zone'),
      slotFloor: document.getElementById('slot-floor'),
      slotVehicleType: document.getElementById('slot-vehicle-type'),
      slotPriceRupees: document.getElementById('slot-price-rupees'),
      slotDistance: document.getElementById('slot-distance'),
      groupSlotStatus: document.getElementById('group-slot-status'),
      slotServiceStatus: document.getElementById('slot-service-status'),
      slotStatusClaimedNote: document.getElementById('slot-status-claimed-note'),
      btnSaveSlot: document.getElementById('btn-save-slot'),
      slotFormError: document.getElementById('slot-form-error'),
      slotFormErrorText: document.getElementById('slot-form-error-text'),

      // Confirm Modal
      modalConfirm: document.getElementById('modal-confirm'),
      modalConfirmTitle: document.getElementById('modal-confirm-title'),
      btnCloseConfirmModal: document.getElementById('btn-close-confirm-modal'),
      btnConfirmCancel: document.getElementById('btn-confirm-cancel'),
      btnConfirmProceed: document.getElementById('btn-confirm-proceed'),
      confirmModalMessage: document.getElementById('confirm-modal-message'),
      confirmModalWarning: document.getElementById('confirm-modal-warning'),
    };
  }

  bindEvents() {
    // Logout
    if (this.el.btnLogout) {
      this.el.btnLogout.addEventListener('click', () => {
        SessionStore.clear();
        redirectTo('login.html');
      });
    }

    // Refresh All
    if (this.el.btnRefreshAll) {
      this.el.btnRefreshAll.addEventListener('click', () => this.refreshCurrentTab());
    }

    // Dismiss Alert
    if (this.el.btnCloseGlobalAlert) {
      this.el.btnCloseGlobalAlert.addEventListener('click', () => {
        if (this.el.globalAlert) this.el.globalAlert.classList.add('hidden');
      });
    }

    // Tab Navigation
    if (this.el.tabBtnOverview) this.el.tabBtnOverview.addEventListener('click', () => this.switchTab('overview'));
    if (this.el.tabBtnLocations) this.el.tabBtnLocations.addEventListener('click', () => this.switchTab('locations'));
    if (this.el.tabBtnSlots) this.el.tabBtnSlots.addEventListener('click', () => this.switchTab('slots'));
    if (this.el.tabBtnBookings) this.el.tabBtnBookings.addEventListener('click', () => this.switchTab('bookings'));

    // Overview Shortcuts
    const btnQuickAddLoc = document.getElementById('btn-quick-add-location');
    if (btnQuickAddLoc) {
      btnQuickAddLoc.addEventListener('click', () => {
        this.switchTab('locations');
        this.openAddLocationModal();
      });
    }
    const btnQuickManageSlots = document.getElementById('btn-quick-manage-slots');
    if (btnQuickManageSlots) {
      btnQuickManageSlots.addEventListener('click', () => this.switchTab('slots'));
    }
    const btnQuickViewBookings = document.getElementById('btn-quick-view-bookings');
    if (btnQuickViewBookings) {
      btnQuickViewBookings.addEventListener('click', () => this.switchTab('bookings'));
    }

    // Locations Tab Events
    if (this.el.filterLocationStatus) {
      this.el.filterLocationStatus.addEventListener('change', (e) => {
        this.locationsStatusFilter = e.target.value;
        this.locationsPage = 1;
        this.loadLocations();
      });
    }
    if (this.el.btnOpenAddLocation) {
      this.el.btnOpenAddLocation.addEventListener('click', () => this.openAddLocationModal());
    }
    if (this.el.btnRefreshLocations) {
      this.el.btnRefreshLocations.addEventListener('click', () => this.loadLocations());
    }
    if (this.el.btnRetryLocations) {
      this.el.btnRetryLocations.addEventListener('click', () => this.loadLocations());
    }
    if (this.el.btnPrevLocations) {
      this.el.btnPrevLocations.addEventListener('click', () => {
        if (this.locationsPage > 1) {
          this.locationsPage--;
          this.loadLocations();
        }
      });
    }
    if (this.el.btnNextLocations) {
      this.el.btnNextLocations.addEventListener('click', () => {
        const maxPages = Math.ceil(this.locationsTotal / this.locationsLimit) || 1;
        if (this.locationsPage < maxPages) {
          this.locationsPage++;
          this.loadLocations();
        }
      });
    }

    // Slots Tab Events
    if (this.el.selectSlotLocation) {
      this.el.selectSlotLocation.addEventListener('change', (e) => {
        const locId = e.target.value;
        if (locId) {
          this.selectLocationForSlots(locId);
        } else {
          this.selectedLocationId = null;
          this.selectedLocation = null;
          this.renderSelectedLocationHeader();
        }
      });
    }
    if (this.el.btnOpenAddSlot) {
      this.el.btnOpenAddSlot.addEventListener('click', () => this.openAddSlotModal());
    }
    if (this.el.btnRefreshSlots) {
      this.el.btnRefreshSlots.addEventListener('click', () => {
        if (this.selectedLocationId) this.loadSlotsForLocation(this.selectedLocationId);
      });
    }
    if (this.el.btnRetrySlots) {
      this.el.btnRetrySlots.addEventListener('click', () => {
        if (this.selectedLocationId) this.loadSlotsForLocation(this.selectedLocationId);
      });
    }

    // Bookings Tab Events
    if (this.el.filterBookingLocation) {
      this.el.filterBookingLocation.addEventListener('change', (e) => {
        this.bookingsLocationFilter = e.target.value;
        this.bookingsPage = 1;
        this.loadBookings();
      });
    }
    if (this.el.filterBookingStatus) {
      this.el.filterBookingStatus.addEventListener('change', (e) => {
        this.bookingsStatusFilter = e.target.value;
        this.bookingsPage = 1;
        this.loadBookings();
      });
    }
    if (this.el.btnRefreshBookings) {
      this.el.btnRefreshBookings.addEventListener('click', () => this.loadBookings());
    }
    if (this.el.btnRetryBookings) {
      this.el.btnRetryBookings.addEventListener('click', () => this.loadBookings());
    }
    if (this.el.btnPrevBookings) {
      this.el.btnPrevBookings.addEventListener('click', () => {
        if (this.bookingsPage > 1) {
          this.bookingsPage--;
          this.loadBookings();
        }
      });
    }
    if (this.el.btnNextBookings) {
      this.el.btnNextBookings.addEventListener('click', () => {
        const maxPages = Math.ceil(this.bookingsTotal / this.bookingsLimit) || 1;
        if (this.bookingsPage < maxPages) {
          this.bookingsPage++;
          this.loadBookings();
        }
      });
    }

    // Modals Close / Cancel
    if (this.el.btnCloseLocationModal) this.el.btnCloseLocationModal.addEventListener('click', () => this.closeLocationModal());
    if (this.el.btnCancelLocation) this.el.btnCancelLocation.addEventListener('click', () => this.closeLocationModal());
    if (this.el.btnCloseSlotModal) this.el.btnCloseSlotModal.addEventListener('click', () => this.closeSlotModal());
    if (this.el.btnCancelSlot) this.el.btnCancelSlot.addEventListener('click', () => this.closeSlotModal());
    if (this.el.btnCloseConfirmModal) this.el.btnCloseConfirmModal.addEventListener('click', () => this.closeConfirmModal());
    if (this.el.btnConfirmCancel) this.el.btnConfirmCancel.addEventListener('click', () => this.closeConfirmModal());

    // Modal Keyboard Handling (Focus Trap on Tab, Dismiss on Escape)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && this.activeModal && !this.activeModal.classList.contains('hidden')) {
        this.trapModalFocus(e, this.activeModal);
      } else if (e.key === 'Escape') {
        if (this.el.modalConfirm && !this.el.modalConfirm.classList.contains('hidden')) {
          this.closeConfirmModal();
        } else if (this.el.modalSlot && !this.el.modalSlot.classList.contains('hidden')) {
          this.closeSlotModal();
        } else if (this.el.modalLocation && !this.el.modalLocation.classList.contains('hidden')) {
          this.closeLocationModal();
        }
      }
    });

    // Form Submissions
    if (this.el.formLocation) {
      this.el.formLocation.addEventListener('submit', (e) => this.handleLocationSubmit(e));
    }
    if (this.el.formSlot) {
      this.el.formSlot.addEventListener('submit', (e) => this.handleSlotSubmit(e));
    }

    // Map manual inputs sync
    if (this.el.locLatitude) {
      this.el.locLatitude.addEventListener('input', () => this.syncManualCoordsToPin());
    }
    if (this.el.locLongitude) {
      this.el.locLongitude.addEventListener('input', () => this.syncManualCoordsToPin());
    }
    if (this.el.btnClearPin) {
      this.el.btnClearPin.addEventListener('click', () => this.clearMapPin());
    }
  }

  // ── Tab Switching ───────────────────────────────────────────

  switchTab(tabName) {
    this.activeTab = tabName;

    const tabs = [
      { id: 'overview', btn: this.el.tabBtnOverview, panel: this.el.panelOverview },
      { id: 'locations', btn: this.el.tabBtnLocations, panel: this.el.panelLocations },
      { id: 'slots', btn: this.el.tabBtnSlots, panel: this.el.panelSlots },
      { id: 'bookings', btn: this.el.tabBtnBookings, panel: this.el.panelBookings },
    ];

    for (const t of tabs) {
      if (t.id === tabName) {
        if (t.btn) {
          t.btn.classList.add('active');
          t.btn.setAttribute('aria-selected', 'true');
        }
        if (t.panel) t.panel.classList.remove('hidden');
      } else {
        if (t.btn) {
          t.btn.classList.remove('active');
          t.btn.setAttribute('aria-selected', 'false');
        }
        if (t.panel) t.panel.classList.add('hidden');
      }
    }

    // Trigger tab-specific refresh if needed
    if (tabName === 'overview') this.loadOverview();
    if (tabName === 'locations') this.loadLocations();
    if (tabName === 'slots' && this.selectedLocationId) this.loadSlotsForLocation(this.selectedLocationId);
    if (tabName === 'bookings') this.loadBookings();
  }

  async refreshCurrentTab() {
    if (this.activeTab === 'overview') await this.loadOverview();
    else if (this.activeTab === 'locations') await this.loadLocations();
    else if (this.activeTab === 'slots' && this.selectedLocationId) await this.loadSlotsForLocation(this.selectedLocationId);
    else if (this.activeTab === 'bookings') await this.loadBookings();
    this.showGlobalAlert('View refreshed.', 'success');
  }

  showGlobalAlert(msg, type = 'info') {
    if (!this.el.globalAlert || !this.el.globalAlertMessage) return;
    this.el.globalAlertMessage.textContent = msg;
    this.el.globalAlert.className = `admin-alert alert-${type}`;
    this.el.globalAlert.classList.remove('hidden');

    if (type === 'success') {
      setTimeout(() => {
        if (this.el.globalAlert) this.el.globalAlert.classList.add('hidden');
      }, 4000);
    }
  }

  // ── Overview Management ─────────────────────────────────────

  async loadOverview() {
    if (this.el.overviewLoading) this.el.overviewLoading.classList.remove('hidden');

    try {
      const data = await ApiClient.get('/api/admin/summary');
      if (data && data.success && data.summary) {
        const s = data.summary;
        // Locations
        setText('metric-loc-total', s.locations?.total ?? 0);
        setText('metric-loc-draft', s.locations?.draft ?? 0);
        setText('metric-loc-active', s.locations?.active ?? 0);
        setText('metric-loc-closed', s.locations?.closed ?? 0);
        setText('metric-loc-archived', s.locations?.archived ?? 0);

        // Slots
        setText('metric-slots-total', s.slots?.total ?? 0);
        setText('metric-slots-enabled', s.slots?.enabled ?? 0);
        setText('metric-slots-maintenance', s.slots?.maintenance ?? 0);
        setText('metric-slots-archived', s.slots?.archived ?? 0);

        // Bookings
        setText('metric-bookings-total', s.bookings?.total ?? 0);
        setText('metric-bookings-active', s.bookings?.active ?? 0);
        setText('metric-bookings-completed', s.bookings?.completed ?? 0);
        setText('metric-bookings-cancelled', s.bookings?.cancelled ?? 0);

        // Users
        setText('metric-users-total', s.users?.total ?? 0);
      }
    } catch (err) {
      console.error('[AdminConsole] Failed to load summary:', err);
      this.showGlobalAlert('Could not load system summary metrics.', 'error');
    } finally {
      if (this.el.overviewLoading) this.el.overviewLoading.classList.add('hidden');
    }
  }

  // ── Locations Management ────────────────────────────────────

  async loadLocations() {
    const seq = ++this.locationsRequestSeq;
    if (this.el.locationsLoading) this.el.locationsLoading.classList.remove('hidden');
    if (this.el.locationsError) this.el.locationsError.classList.add('hidden');
    if (this.el.locationsEmpty) this.el.locationsEmpty.classList.add('hidden');
    if (this.el.locationsTableWrapper) this.el.locationsTableWrapper.classList.add('hidden');

    try {
      let queryUrl = `/api/admin/locations?page=${this.locationsPage}&limit=${this.locationsLimit}`;
      if (this.locationsStatusFilter) {
        queryUrl += `&status=${encodeURIComponent(this.locationsStatusFilter)}`;
      }

      const res = await ApiClient.get(queryUrl);
      if (seq !== this.locationsRequestSeq) return;

      if (res && res.success) {
        this.locations = res.locations || [];
        this.locationsTotal = res.total || 0;

        this.renderLocationsTable();
        this.populateLocationDropdowns();
      } else {
        throw new Error(res?.message || 'Failed to retrieve locations.');
      }
    } catch (err) {
      if (seq !== this.locationsRequestSeq) return;
      console.error('[AdminConsole] Failed to load locations:', err);
      if (this.el.locationsErrorMessage) {
        this.el.locationsErrorMessage.textContent = err.message || 'Error loading locations.';
      }
      if (this.el.locationsError) this.el.locationsError.classList.remove('hidden');
    } finally {
      if (seq === this.locationsRequestSeq && this.el.locationsLoading) {
        this.el.locationsLoading.classList.add('hidden');
      }
    }
  }

  renderLocationsTable() {
    if (!this.el.locationsTbody) return;
    this.el.locationsTbody.innerHTML = '';

    if (this.locations.length === 0) {
      if (this.el.locationsEmpty) this.el.locationsEmpty.classList.remove('hidden');
      this.updateLocationsPagination(0, 1, 1);
      return;
    }

    if (this.el.locationsTableWrapper) this.el.locationsTableWrapper.classList.remove('hidden');

    for (const loc of this.locations) {
      const tr = document.createElement('tr');

      // Col 1: Name & Category
      const tdName = document.createElement('td');
      const nameStrong = document.createElement('strong');
      nameStrong.textContent = loc.name || 'Unnamed';
      tdName.appendChild(nameStrong);
      const catDiv = document.createElement('div');
      catDiv.className = 'field-help';
      catDiv.textContent = `Category: ${loc.category || 'other'}`;
      tdName.appendChild(catDiv);
      tr.appendChild(tdName);

      // Col 2: City & Area & Address
      const tdAddress = document.createElement('td');
      const citySpan = document.createElement('span');
      citySpan.textContent = [loc.city, loc.area].filter(Boolean).join(', ') || 'No city specified';
      tdAddress.appendChild(citySpan);
      if (loc.address) {
        const addrDiv = document.createElement('div');
        addrDiv.className = 'field-help';
        addrDiv.textContent = loc.address;
        tdAddress.appendChild(addrDiv);
      }
      tr.appendChild(tdAddress);

      // Col 3: Status Badge
      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge badge-${loc.status || 'draft'}`;
      badge.textContent = loc.status || 'draft';
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // Col 4: Slots Counts
      const tdSlots = document.createElement('td');
      tdSlots.textContent = `${loc.totalSlots ?? 0} total / ${loc.enabledSlots ?? 0} enabled / ${loc.availableSlots ?? 0} avail`;
      tr.appendChild(tdSlots);

      // Col 5: Coordinates
      const tdCoords = document.createElement('td');
      if (loc.latitude !== undefined && loc.longitude !== undefined && loc.latitude !== null && loc.longitude !== null) {
        tdCoords.textContent = `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
      } else {
        tdCoords.textContent = 'Not specified';
        tdCoords.className = 'field-help';
      }
      tr.appendChild(tdCoords);

      // Col 6: Actions
      const tdActions = document.createElement('td');
      tdActions.className = 'td-actions';

      // Edit Button
      if (loc.status !== 'archived') {
        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.className = 'btn btn-outline btn-xs';
        btnEdit.textContent = 'Edit';
        btnEdit.onclick = () => this.openEditLocationModal(loc);
        tdActions.appendChild(btnEdit);
      }

      // Manage Slots Button
      const btnSlots = document.createElement('button');
      btnSlots.type = 'button';
      btnSlots.className = 'btn btn-secondary btn-xs';
      btnSlots.textContent = 'Manage Slots';
      btnSlots.onclick = () => {
        this.selectLocationForSlots(loc.id || loc._id);
        this.switchTab('slots');
      };
      tdActions.appendChild(btnSlots);

      // Lifecycle Action Buttons
      if (loc.status === 'draft') {
        const btnPublish = document.createElement('button');
        btnPublish.type = 'button';
        btnPublish.className = 'btn btn-primary btn-xs';
        btnPublish.textContent = 'Publish';
        btnPublish.onclick = () => this.handlePublishLocation(loc);
        tdActions.appendChild(btnPublish);
      } else if (loc.status === 'active') {
        const btnClose = document.createElement('button');
        btnClose.type = 'button';
        btnClose.className = 'btn btn-outline btn-xs';
        btnClose.textContent = 'Close';
        btnClose.onclick = () => this.promptCloseLocation(loc);
        tdActions.appendChild(btnClose);

        const btnArchive = document.createElement('button');
        btnArchive.type = 'button';
        btnArchive.className = 'btn btn-danger btn-xs';
        btnArchive.textContent = 'Archive';
        btnArchive.onclick = () => this.promptArchiveLocation(loc);
        tdActions.appendChild(btnArchive);
      } else if (loc.status === 'closed') {
        const btnReopen = document.createElement('button');
        btnReopen.type = 'button';
        btnReopen.className = 'btn btn-primary btn-xs';
        btnReopen.textContent = 'Reopen';
        btnReopen.onclick = () => this.handleReopenLocation(loc);
        tdActions.appendChild(btnReopen);

        const btnArchive = document.createElement('button');
        btnArchive.type = 'button';
        btnArchive.className = 'btn btn-danger btn-xs';
        btnArchive.textContent = 'Archive';
        btnArchive.onclick = () => this.promptArchiveLocation(loc);
        tdActions.appendChild(btnArchive);
      }

      tr.appendChild(tdActions);
      this.el.locationsTbody.appendChild(tr);
    }

    const totalPages = Math.ceil(this.locationsTotal / this.locationsLimit) || 1;
    this.updateLocationsPagination(this.locationsTotal, this.locationsPage, totalPages);
  }

  updateLocationsPagination(total, page, totalPages) {
    if (this.el.locationsPageInfo) {
      this.el.locationsPageInfo.textContent = `Page ${page} of ${totalPages} (${total} total)`;
    }
    if (this.el.btnPrevLocations) this.el.btnPrevLocations.disabled = page <= 1;
    if (this.el.btnNextLocations) this.el.btnNextLocations.disabled = page >= totalPages;
  }

  async loadAllLocationsForPickers() {
    const seq = ++this.pickersRequestSeq;
    const all = [];
    let page = 1;
    const limit = 100;
    const maxSafetyPages = 50;

    try {
      while (page <= maxSafetyPages) {
        const res = await ApiClient.get(`/api/admin/locations?page=${page}&limit=${limit}`);
        if (seq !== this.pickersRequestSeq) return;

        if (res && res.success && Array.isArray(res.locations)) {
          all.push(...res.locations);
          const total = typeof res.total === 'number' ? res.total : 0;
          if (all.length >= total || res.locations.length < limit || res.locations.length === 0) {
            break;
          }
          page++;
        } else {
          break;
        }
      }

      if (seq !== this.pickersRequestSeq) return;

      this.pickerLocations = all;
      this.populateLocationDropdowns();
    } catch (err) {
      if (seq !== this.pickersRequestSeq) return;
      console.error('[AdminConsole] Failed to load locations for pickers:', err);
    }
  }

  populateLocationDropdowns() {
    const list = this.pickerLocations.length > 0 ? this.pickerLocations : this.locations;

    // Dropdown in Slots tab
    if (this.el.selectSlotLocation) {
      const currentVal = this.selectedLocationId || this.el.selectSlotLocation.value;
      this.el.selectSlotLocation.innerHTML = '<option value="">-- Choose Location --</option>';
      for (const loc of list) {
        const opt = document.createElement('option');
        opt.value = loc.id || loc._id;
        opt.textContent = `${loc.name} (${loc.city || 'No city'}) [${loc.status}]`;
        this.el.selectSlotLocation.appendChild(opt);
      }
      if (currentVal) this.el.selectSlotLocation.value = currentVal;
    }

    // Dropdown in Bookings tab
    if (this.el.filterBookingLocation) {
      const currentVal = this.bookingsLocationFilter || this.el.filterBookingLocation.value;
      this.el.filterBookingLocation.innerHTML = '<option value="">All Locations</option>';
      for (const loc of list) {
        const opt = document.createElement('option');
        opt.value = loc.id || loc._id;
        opt.textContent = `${loc.name} (${loc.city || ''})`;
        this.el.filterBookingLocation.appendChild(opt);
      }
      if (currentVal) this.el.filterBookingLocation.value = currentVal;
    }
  }

  // ── Location Modal & Leaflet Map ────────────────────────────

  openAddLocationModal() {
    if (!this.el.modalLocation) return;
    this.lastFocusedElement = document.activeElement;
    this.activeModal = this.el.modalLocation;
    this.editingLocation = null;

    this.el.modalLocationTitle.textContent = 'Add New Parking Location';
    this.el.formLocation.reset();
    this.el.locId.value = '';
    this.clearLocationErrors();

    this.el.modalLocation.classList.remove('hidden');
    this.initOrRefreshMap(null, null);
    if (this.el.locName) this.el.locName.focus();
  }

  openEditLocationModal(loc) {
    if (!this.el.modalLocation) return;
    this.lastFocusedElement = document.activeElement;
    this.activeModal = this.el.modalLocation;
    this.editingLocation = loc;

    this.el.modalLocationTitle.textContent = `Edit Location: ${loc.name}`;
    this.el.formLocation.reset();
    this.clearLocationErrors();

    this.el.locId.value = loc.id || loc._id || '';
    if (this.el.locName) this.el.locName.value = loc.name || '';
    if (this.el.locCategory) this.el.locCategory.value = ALLOWED_CATEGORIES.has(loc.category) ? loc.category : 'other';
    if (this.el.locAddress) this.el.locAddress.value = loc.address || '';
    if (this.el.locCity) this.el.locCity.value = loc.city || '';
    if (this.el.locArea) this.el.locArea.value = loc.area || '';
    if (this.el.locPhone) this.el.locPhone.value = loc.contactPhone || '';
    if (this.el.locLatitude) this.el.locLatitude.value = loc.latitude !== undefined && loc.latitude !== null ? loc.latitude : '';
    if (this.el.locLongitude) this.el.locLongitude.value = loc.longitude !== undefined && loc.longitude !== null ? loc.longitude : '';

    // Check facilities
    const facSet = new Set((loc.facilities || []).map((f) => String(f).toLowerCase()));
    const checkboxes = this.el.formLocation.querySelectorAll('input[name="loc-facilities"]');
    for (const cb of checkboxes) {
      cb.checked = facSet.has(cb.value.toLowerCase());
    }

    this.el.modalLocation.classList.remove('hidden');
    this.initOrRefreshMap(loc.latitude, loc.longitude);
    if (this.el.locName) this.el.locName.focus();
  }

  closeLocationModal() {
    if (this.el.modalLocation) this.el.modalLocation.classList.add('hidden');
    if (this.activeModal === this.el.modalLocation) this.activeModal = null;
    this.editingLocation = null;
    this.restoreFocus();
  }

  clearLocationErrors() {
    if (this.el.locFormError) this.el.locFormError.classList.add('hidden');
    if (this.el.locFormErrorText) this.el.locFormErrorText.textContent = '';
    if (this.el.locFormErrorViolations) {
      this.el.locFormErrorViolations.innerHTML = '';
      this.el.locFormErrorViolations.classList.add('hidden');
    }
  }

  showLocationError(msg, violations = []) {
    if (!this.el.locFormError) return;
    if (this.el.locFormErrorText) this.el.locFormErrorText.textContent = msg;

    if (violations && violations.length > 0 && this.el.locFormErrorViolations) {
      this.el.locFormErrorViolations.innerHTML = '';
      for (const v of violations) {
        const li = document.createElement('li');
        li.textContent = v;
        this.el.locFormErrorViolations.appendChild(li);
      }
      this.el.locFormErrorViolations.classList.remove('hidden');
    } else if (this.el.locFormErrorViolations) {
      this.el.locFormErrorViolations.classList.add('hidden');
    }

    this.el.locFormError.classList.remove('hidden');
  }

  initOrRefreshMap(initialLat, initialLng) {
    const hasLeaflet = typeof window !== 'undefined' && window.L && typeof window.L.map === 'function';

    if (!hasLeaflet) {
      if (this.el.adminMapFallback) this.el.adminMapFallback.classList.remove('hidden');
      return;
    }

    if (this.el.adminMapFallback) this.el.adminMapFallback.classList.add('hidden');

    try {
      if (!this.leafletMap) {
        // Set up marker icons
        try {
          delete window.L.Icon.Default.prototype._getIconUrl;
          window.L.Icon.Default.mergeOptions({
            iconRetinaUrl: 'vendor/leaflet/images/marker-icon-2x.png',
            iconUrl: 'vendor/leaflet/images/marker-icon.png',
            shadowUrl: 'vendor/leaflet/images/marker-shadow.png',
          });
        } catch {
          // ignore icon override error
        }

        const mapEl = document.getElementById('admin-map');
        if (!mapEl) return;

        this.leafletMap = window.L.map('admin-map', {
          center: [20.5937, 78.9629],
          zoom: 4,
          zoomControl: true,
        });

        window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
        }).addTo(this.leafletMap);

        // Click on map to place pin
        this.leafletMap.on('click', (e) => {
          this.setMapPin(e.latlng.lat, e.latlng.lng, true);
        });

        this.isMapReady = true;
      }

      // Small delay to allow modal display rendering
      setTimeout(() => {
        if (this.leafletMap) {
          this.leafletMap.invalidateSize();
          const hasCoords = Number.isFinite(parseFloat(initialLat)) && Number.isFinite(parseFloat(initialLng));
          if (hasCoords) {
            const lat = parseFloat(initialLat);
            const lng = parseFloat(initialLng);
            this.setMapPin(lat, lng, false);
            this.leafletMap.setView([lat, lng], 13);
          } else {
            this.clearMapPin();
            this.leafletMap.setView([20.5937, 78.9629], 4);
          }
        }
      }, 150);
    } catch (err) {
      console.warn('[AdminConsole] Map init degraded:', err);
      if (this.el.adminMapFallback) this.el.adminMapFallback.classList.remove('hidden');
    }
  }

  setMapPin(lat, lng, updateInputs = false) {
    if (!this.leafletMap || !window.L) return;

    if (!this.mapMarker) {
      this.mapMarker = window.L.marker([lat, lng], { draggable: true }).addTo(this.leafletMap);
      this.mapMarker.on('dragend', () => {
        const pos = this.mapMarker.getLatLng();
        this.updateCoordsInputs(pos.lat, pos.lng);
      });
    } else {
      this.mapMarker.setLatLng([lat, lng]);
    }

    if (updateInputs) {
      this.updateCoordsInputs(lat, lng);
    }
  }

  clearMapPin() {
    if (this.mapMarker && this.leafletMap) {
      this.leafletMap.removeLayer(this.mapMarker);
      this.mapMarker = null;
    }
    if (this.el.locLatitude) this.el.locLatitude.value = '';
    if (this.el.locLongitude) this.el.locLongitude.value = '';
  }

  updateCoordsInputs(lat, lng) {
    if (this.el.locLatitude) this.el.locLatitude.value = Number(lat).toFixed(6);
    if (this.el.locLongitude) this.el.locLongitude.value = Number(lng).toFixed(6);
  }

  syncManualCoordsToPin() {
    const latStr = this.el.locLatitude ? String(this.el.locLatitude.value ?? '').trim() : '';
    const lngStr = this.el.locLongitude ? String(this.el.locLongitude.value ?? '').trim() : '';

    if (latStr === '' || lngStr === '') return;

    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180) {
      this.setMapPin(lat, lng, false);
      if (this.leafletMap) {
        this.leafletMap.panTo([lat, lng]);
      }
    }
  }

  async handleLocationSubmit(e) {
    e.preventDefault();
    if (this.isSubmittingLocation) return;
    this.clearLocationErrors();

    const name = this.el.locName ? String(this.el.locName.value ?? '').trim() : '';
    if (!name) {
      this.showLocationError('Location name is required.');
      if (this.el.locName) this.el.locName.focus();
      return;
    }

    const latVal = this.el.locLatitude ? String(this.el.locLatitude.value ?? '').trim() : '';
    const lngVal = this.el.locLongitude ? String(this.el.locLongitude.value ?? '').trim() : '';
    const coordCheck = validateCoordinates(latVal, lngVal);
    if (!coordCheck.valid) {
      this.showLocationError(coordCheck.error);
      return;
    }

    const editId = this.el.locId ? String(this.el.locId.value ?? '').trim() : '';

    // Facilities with custom unrepresented items preserved
    const checkedFacilities = [];
    const checkboxes = this.el.formLocation.querySelectorAll('input[name="loc-facilities"]:checked');
    for (const cb of checkboxes) {
      checkedFacilities.push(cb.value);
    }

    let facilities = checkedFacilities;
    if (editId && this.editingLocation && Array.isArray(this.editingLocation.facilities)) {
      facilities = mergePreservedItems(this.editingLocation.facilities, checkedFacilities, KNOWN_FACILITY_VALUES);
    }

    const rawData = {
      name,
      category: this.el.locCategory && ALLOWED_CATEGORIES.has(this.el.locCategory.value) ? this.el.locCategory.value : 'other',
      address: this.el.locAddress ? this.el.locAddress.value : '',
      city: this.el.locCity ? this.el.locCity.value : '',
      area: this.el.locArea ? this.el.locArea.value : '',
      contactPhone: this.el.locPhone ? this.el.locPhone.value : '',
      latitude: coordCheck.lat,
      longitude: coordCheck.lng,
      facilities,
    };

    const payload = buildLocationPayload(rawData);

    this.isSubmittingLocation = true;
    if (this.el.btnSaveLocation) {
      this.el.btnSaveLocation.disabled = true;
      this.el.btnSaveLocation.textContent = 'Saving...';
    }

    try {
      if (editId) {
        // PATCH existing location
        const res = await ApiClient.patch(`/api/admin/locations/${editId}`, payload);
        if (res && res.success) {
          this.closeLocationModal();
          this.showGlobalAlert(`Location "${payload.name}" updated successfully.`, 'success');
          await this.loadLocations();
          await this.loadAllLocationsForPickers();
          await this.loadOverview();
        } else {
          throw new Error(res?.message || 'Failed to update location.');
        }
      } else {
        // POST new location (starts in draft)
        const res = await ApiClient.post('/api/admin/locations', payload);
        if (res && res.success) {
          this.closeLocationModal();
          this.showGlobalAlert(`New draft location "${payload.name}" created successfully. Add slots and publish when ready.`, 'success');
          await this.loadLocations();
          await this.loadAllLocationsForPickers();
          await this.loadOverview();
        } else {
          throw new Error(res?.message || 'Failed to create location.');
        }
      }
    } catch (err) {
      console.error('[AdminConsole] Location save error:', err);
      if (err.status === 409 && err.data?.code === 'ARCHIVED_IMMUTABLE') {
        this.showLocationError('Archived locations cannot be modified.');
      } else if (err.status === 422 && err.data?.violations) {
        this.showLocationError(err.message || 'Validation preconditions failed.', err.data.violations);
      } else {
        this.showLocationError(err.message || 'Could not save location. Please review entered fields.');
      }
    } finally {
      this.isSubmittingLocation = false;
      if (this.el.btnSaveLocation) {
        this.el.btnSaveLocation.disabled = false;
        this.el.btnSaveLocation.textContent = 'Save Location';
      }
    }
  }

  // ── Location Lifecycle Actions ──────────────────────────────

  async handlePublishLocation(loc) {
    if (this.isPerformingLifecycle) return;
    this.isPerformingLifecycle = true;
    try {
      const res = await ApiClient.patch(`/api/admin/locations/${loc.id || loc._id}`, { status: 'active' });
      if (res && res.success) {
        this.showGlobalAlert(`Location "${loc.name}" published! It is now publicly listed and open for bookings.`, 'success');
        await this.loadLocations();
        await this.loadAllLocationsForPickers();
        await this.loadOverview();
      }
    } catch (err) {
      if (err.status === 422 && err.data?.violations) {
        this.openConfirmModal({
          title: 'Cannot Publish Location',
          message: `Preconditions to publish "${loc.name}" were not met:`,
          warning: err.data.violations.join('\n'),
          proceedText: 'Understood',
          isAlertOnly: true,
        });
      } else {
        this.showGlobalAlert(err.message || 'Failed to publish location.', 'error');
      }
    } finally {
      this.isPerformingLifecycle = false;
    }
  }

  promptCloseLocation(loc) {
    this.openConfirmModal({
      title: `Close Location: ${loc.name}?`,
      message: `Closing "${loc.name}" leaves it visible in search results but prevents drivers from making new bookings. Existing bookings remain active.`,
      warning: 'Consequence: No new bookings can be made while closed. You may reopen it at any time.',
      proceedText: 'Close Location',
      onProceed: async () => {
        if (this.isPerformingLifecycle) return;
        this.isPerformingLifecycle = true;
        try {
          const res = await ApiClient.patch(`/api/admin/locations/${loc.id || loc._id}`, { status: 'closed' });
          if (res && res.success) {
            this.showGlobalAlert(`Location "${loc.name}" is now closed.`, 'success');
            await this.loadLocations();
            await this.loadAllLocationsForPickers();
            await this.loadOverview();
          }
        } catch (err) {
          this.showGlobalAlert(err.message || 'Failed to close location.', 'error');
        } finally {
          this.isPerformingLifecycle = false;
        }
      },
    });
  }

  async handleReopenLocation(loc) {
    if (this.isPerformingLifecycle) return;
    this.isPerformingLifecycle = true;
    try {
      const res = await ApiClient.patch(`/api/admin/locations/${loc.id || loc._id}`, { status: 'active' });
      if (res && res.success) {
        this.showGlobalAlert(`Location "${loc.name}" reopened successfully. Accepting bookings.`, 'success');
        await this.loadLocations();
        await this.loadAllLocationsForPickers();
        await this.loadOverview();
      }
    } catch (err) {
      this.showGlobalAlert(err.message || 'Failed to reopen location.', 'error');
    } finally {
      this.isPerformingLifecycle = false;
    }
  }

  promptArchiveLocation(loc) {
    this.openConfirmModal({
      title: `Archive Location: ${loc.name}?`,
      message: `Archiving "${loc.name}" permanently removes it from public discovery and disables all future bookings.`,
      warning: 'CRITICAL: Archiving is permanent and immutable. This location cannot be reopened. Active bookings must be 0.',
      proceedText: 'Permanently Archive',
      onProceed: async () => {
        if (this.isPerformingLifecycle) return;
        this.isPerformingLifecycle = true;
        try {
          const res = await ApiClient.patch(`/api/admin/locations/${loc.id || loc._id}`, { status: 'archived' });
          if (res && res.success) {
            this.showGlobalAlert(`Location "${loc.name}" has been permanently archived.`, 'success');
            await this.loadLocations();
            await this.loadAllLocationsForPickers();
            await this.loadOverview();
          }
        } catch (err) {
          if (err.status === 409 && err.data?.code === 'ACTIVE_BOOKINGS_EXIST') {
            this.showGlobalAlert(`Cannot archive "${loc.name}": Active customer bookings currently exist. Wait for bookings to complete or resolve before archiving.`, 'error');
          } else {
            this.showGlobalAlert(err.message || 'Failed to archive location.', 'error');
          }
        } finally {
          this.isPerformingLifecycle = false;
        }
      },
    });
  }

  // ── Slot Inventory Management ───────────────────────────────

  selectLocationForSlots(locationId) {
    this.selectedLocationId = locationId;
    this.selectedLocation =
      this.pickerLocations.find((l) => (l.id || l._id) === locationId) ||
      this.locations.find((l) => (l.id || l._id) === locationId) ||
      null;

    if (this.el.selectSlotLocation) {
      this.el.selectSlotLocation.value = locationId;
    }

    this.renderSelectedLocationHeader();
  }

  renderSelectedLocationHeader() {
    if (!this.selectedLocation) {
      setText('slots-parent-name', 'No Location Selected');
      setText('slots-parent-meta', 'Select a location above or click "Manage Slots" from the Locations tab.');
      if (this.el.btnOpenAddSlot) this.el.btnOpenAddSlot.disabled = true;
      if (this.el.btnRefreshSlots) this.el.btnRefreshSlots.disabled = true;
      if (this.el.slotsNoSelection) this.el.slotsNoSelection.classList.remove('hidden');
      if (this.el.slotsTableCard) this.el.slotsTableCard.classList.add('hidden');
      return;
    }

    setText('slots-parent-name', this.selectedLocation.name || 'Unnamed Location');
    const addr = [this.selectedLocation.address, this.selectedLocation.city, this.selectedLocation.area].filter(Boolean).join(', ');
    setText('slots-parent-meta', `${addr || 'No address specified'} • Status: ${this.selectedLocation.status.toUpperCase()}`);

    const isArchived = this.selectedLocation.status === 'archived';
    if (this.el.btnOpenAddSlot) this.el.btnOpenAddSlot.disabled = isArchived;
    if (this.el.btnRefreshSlots) this.el.btnRefreshSlots.disabled = false;
    if (this.el.slotsNoSelection) this.el.slotsNoSelection.classList.add('hidden');
    if (this.el.slotsTableCard) this.el.slotsTableCard.classList.remove('hidden');
  }

  async loadSlotsForLocation(locationId) {
    // Stale response guard: increment sequence ID
    const currentSeq = ++this.slotsRequestSeq;

    if (this.selectedLocationId && this.selectedLocationId !== locationId) {
      return;
    }

    if (this.el.slotsLoading) this.el.slotsLoading.classList.remove('hidden');
    if (this.el.slotsError) this.el.slotsError.classList.add('hidden');
    if (this.el.slotsEmpty) this.el.slotsEmpty.classList.add('hidden');
    if (this.el.slotsTableWrapper) this.el.slotsTableWrapper.classList.add('hidden');

    try {
      const res = await ApiClient.get(`/api/admin/locations/${locationId}/slots`);

      // Before applying a slot response, require BOTH:
      // - its sequence is current;
      // - its locationId still matches selectedLocationId.
      if (currentSeq !== this.slotsRequestSeq || (this.selectedLocationId && this.selectedLocationId !== locationId)) {
        return;
      }

      if (res && res.success) {
        this.slots = res.slots || [];
        this.renderSlotsTable();
      } else {
        throw new Error(res?.message || 'Failed to retrieve slots.');
      }
    } catch (err) {
      if (currentSeq !== this.slotsRequestSeq || (this.selectedLocationId && this.selectedLocationId !== locationId)) return;
      console.error('[AdminConsole] Failed to load slots:', err);
      if (this.el.slotsErrorMessage) {
        this.el.slotsErrorMessage.textContent = err.message || 'Error loading slots.';
      }
      if (this.el.slotsError) this.el.slotsError.classList.remove('hidden');
    } finally {
      if (currentSeq === this.slotsRequestSeq && (!this.selectedLocationId || this.selectedLocationId === locationId) && this.el.slotsLoading) {
        this.el.slotsLoading.classList.add('hidden');
      }
    }
  }

  renderSlotsTable() {
    if (!this.el.slotsTbody) return;
    this.el.slotsTbody.innerHTML = '';

    if (this.slots.length === 0) {
      if (this.el.slotsEmpty) this.el.slotsEmpty.classList.remove('hidden');
      return;
    }

    if (this.el.slotsTableWrapper) this.el.slotsTableWrapper.classList.remove('hidden');

    for (const slot of this.slots) {
      const tr = document.createElement('tr');

      // Col 1: Code
      const tdCode = document.createElement('td');
      const codeStrong = document.createElement('strong');
      codeStrong.textContent = slot.code || '—';
      tdCode.appendChild(codeStrong);
      tr.appendChild(tdCode);

      // Col 2: Zone & Floor
      const tdZoneFloor = document.createElement('td');
      tdZoneFloor.textContent = `Zone ${slot.zone || '—'}, Floor ${slot.floor ?? '—'}`;
      tr.appendChild(tdZoneFloor);

      // Col 3: Vehicle Type
      const tdType = document.createElement('td');
      tdType.textContent = (slot.vehicleType || 'car').toUpperCase();
      tr.appendChild(tdType);

      // Col 4: Price / Hr
      const tdPrice = document.createElement('td');
      tdPrice.textContent = formatPaiseToRupees(slot.pricePerHourPaise);
      tr.appendChild(tdPrice);

      // Col 5: Distance
      const tdDist = document.createElement('td');
      tdDist.textContent = slot.distanceFromEntry !== undefined ? `${slot.distanceFromEntry}m` : '—';
      tr.appendChild(tdDist);

      // Col 6: Operational Status
      const tdStatus = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = `badge badge-${slot.serviceStatus || 'enabled'}`;
      statusBadge.textContent = slot.serviceStatus || 'enabled';
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // Col 7: Occupancy
      const tdOccupancy = document.createElement('td');
      const isOccupied = Boolean(slot.activeBooking);
      const occBadge = document.createElement('span');
      if (isOccupied) {
        occBadge.className = 'badge badge-occupied';
        occBadge.textContent = 'Occupied';
        tdOccupancy.appendChild(occBadge);
        const refDiv = document.createElement('div');
        refDiv.className = 'field-help';
        refDiv.textContent = `Booking ID: ${String(slot.activeBooking).slice(-6)}`;
        tdOccupancy.appendChild(refDiv);
      } else {
        occBadge.className = 'badge badge-available';
        occBadge.textContent = 'Available';
        tdOccupancy.appendChild(occBadge);
      }
      tr.appendChild(tdOccupancy);

      // Col 8: Actions
      const tdActions = document.createElement('td');
      tdActions.className = 'td-actions';

      if (slot.serviceStatus !== 'archived') {
        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.className = 'btn btn-outline btn-xs';
        btnEdit.textContent = 'Edit';
        btnEdit.onclick = () => this.openEditSlotModal(slot);
        tdActions.appendChild(btnEdit);

        // Maintenance Toggle / State display:
        // Do not offer Enable or Archive for occupied slots
        if (isOccupied) {
          if (slot.serviceStatus === 'enabled') {
            const btnMaint = document.createElement('button');
            btnMaint.type = 'button';
            btnMaint.className = 'btn btn-secondary btn-xs';
            btnMaint.textContent = 'Maintenance';
            btnMaint.onclick = () => this.toggleSlotMaintenance(slot);
            tdActions.appendChild(btnMaint);
          } else {
            // Occupied slot already in maintenance: show its state without offering invalid transition
            const lockedText = document.createElement('span');
            lockedText.className = 'field-help';
            lockedText.textContent = 'In Maintenance';
            tdActions.appendChild(lockedText);
          }
        } else {
          // Unoccupied slot: standard maintenance toggle
          const btnMaint = document.createElement('button');
          btnMaint.type = 'button';
          btnMaint.className = 'btn btn-secondary btn-xs';
          btnMaint.textContent = slot.serviceStatus === 'maintenance' ? 'Enable' : 'Maintenance';
          btnMaint.onclick = () => this.toggleSlotMaintenance(slot);
          tdActions.appendChild(btnMaint);

          // Archive action (strictly prohibited if occupied)
          const btnArchive = document.createElement('button');
          btnArchive.type = 'button';
          btnArchive.className = 'btn btn-danger btn-xs';
          btnArchive.textContent = 'Archive';
          btnArchive.onclick = () => this.promptArchiveSlot(slot);
          tdActions.appendChild(btnArchive);
        }
      }

      tr.appendChild(tdActions);
      this.el.slotsTbody.appendChild(tr);
    }
  }

  // ── Slot Modals & Actions ───────────────────────────────────

  openAddSlotModal() {
    if (!this.selectedLocationId || !this.selectedLocation) {
      this.showGlobalAlert('Please select a parking location first.', 'error');
      return;
    }

    if (this.selectedLocation.status === 'archived') {
      this.showGlobalAlert('Cannot add slots to an archived location.', 'error');
      return;
    }

    this.lastFocusedElement = document.activeElement;
    this.activeModal = this.el.modalSlot;
    this.editingSlot = null;

    this.el.modalSlotTitle.textContent = `Add Slot to ${this.selectedLocation.name}`;
    this.el.formSlot.reset();
    this.el.slotId.value = '';
    this.el.slotLocationId.value = this.selectedLocationId;
    this.clearSlotErrors();

    // Enable all fields for new slot
    this.enableSlotFormFields(true);
    if (this.el.groupSlotStatus) this.el.groupSlotStatus.classList.add('hidden');

    this.el.modalSlot.classList.remove('hidden');
    if (this.el.slotCode) this.el.slotCode.focus();
  }

  openEditSlotModal(slot) {
    if (!this.selectedLocationId || !this.selectedLocation) return;

    this.lastFocusedElement = document.activeElement;
    this.activeModal = this.el.modalSlot;
    this.editingSlot = slot;

    this.el.modalSlotTitle.textContent = `Edit Slot ${slot.code} (${this.selectedLocation.name})`;
    this.el.formSlot.reset();
    this.clearSlotErrors();

    this.el.slotId.value = slot.id || slot._id || '';
    this.el.slotLocationId.value = this.selectedLocationId;

    if (this.el.slotCode) this.el.slotCode.value = slot.code || '';
    if (this.el.slotZone) this.el.slotZone.value = slot.zone || '';
    if (this.el.slotFloor) this.el.slotFloor.value = slot.floor !== undefined ? slot.floor : '';
    if (this.el.slotVehicleType) this.el.slotVehicleType.value = ALLOWED_VEHICLE_TYPES.has(slot.vehicleType) ? slot.vehicleType : 'car';
    if (this.el.slotPriceRupees) {
      this.el.slotPriceRupees.value = slot.pricePerHourPaise !== undefined ? (slot.pricePerHourPaise / 100).toFixed(2) : '';
    }
    if (this.el.slotDistance) this.el.slotDistance.value = slot.distanceFromEntry !== undefined ? slot.distanceFromEntry : '';

    // Features checkboxes
    const featSet = new Set((slot.features || []).map((f) => String(f).toLowerCase()));
    const checkboxes = this.el.formSlot.querySelectorAll('input[name="slot-features"]');
    for (const cb of checkboxes) {
      cb.checked = featSet.has(cb.value.toLowerCase());
    }

    const isClaimed = Boolean(slot.activeBooking);

    // Configure status select dropdown options dynamically based on occupancy
    if (this.el.slotServiceStatus) {
      this.el.slotServiceStatus.innerHTML = '';
      if (isClaimed) {
        // Do not offer Enable or Archive for occupied slots
        if (slot.serviceStatus === 'maintenance') {
          // Occupied slot already in maintenance: show its state without offering invalid transition
          const optMaint = document.createElement('option');
          optMaint.value = 'maintenance';
          optMaint.textContent = 'Maintenance (Occupied — Locked)';
          this.el.slotServiceStatus.appendChild(optMaint);
          this.el.slotServiceStatus.value = 'maintenance';
          this.el.slotServiceStatus.disabled = true;
        } else {
          // Occupied enabled slot: can only transition to maintenance
          const optCurr = document.createElement('option');
          optCurr.value = 'enabled';
          optCurr.textContent = 'Enabled (Current)';
          this.el.slotServiceStatus.appendChild(optCurr);

          const optMaint = document.createElement('option');
          optMaint.value = 'maintenance';
          optMaint.textContent = 'Maintenance (Temporarily Unavailable)';
          this.el.slotServiceStatus.appendChild(optMaint);

          this.el.slotServiceStatus.value = slot.serviceStatus || 'enabled';
          this.el.slotServiceStatus.disabled = false;
        }
      } else {
        // Unoccupied slot offers all standard transitions
        const statuses = [
          { value: 'enabled', label: 'Enabled (Operational)' },
          { value: 'maintenance', label: 'Maintenance (Temporarily Unavailable)' },
          { value: 'archived', label: 'Archived (Decommissioned)' },
        ];
        for (const s of statuses) {
          const opt = document.createElement('option');
          opt.value = s.value;
          opt.textContent = s.label;
          this.el.slotServiceStatus.appendChild(opt);
        }
        this.el.slotServiceStatus.value = slot.serviceStatus || 'enabled';
        this.el.slotServiceStatus.disabled = false;
      }
    }

    if (this.el.groupSlotStatus) this.el.groupSlotStatus.classList.remove('hidden');

    // Claimed slot enforcement:
    // If slot has active booking, non-status fields CANNOT be edited! Only maintenance allowed.
    if (isClaimed) {
      this.enableSlotFormFields(false);
      if (slot.serviceStatus === 'maintenance') {
        if (this.el.slotStatusClaimedNote) {
          this.el.slotStatusClaimedNote.textContent = 'Slot is currently occupied and in maintenance. No status transitions or field edits are permitted until the booking ends.';
        }
        if (this.el.btnSaveSlot) this.el.btnSaveSlot.disabled = true;
      } else {
        if (this.el.slotStatusClaimedNote) {
          this.el.slotStatusClaimedNote.textContent = 'Slot is currently occupied. Field modifications are prohibited; placing into maintenance is allowed.';
        }
        if (this.el.btnSaveSlot) this.el.btnSaveSlot.disabled = false;
        if (this.el.slotServiceStatus) this.el.slotServiceStatus.focus();
      }
    } else {
      this.enableSlotFormFields(true);
      if (this.el.btnSaveSlot) this.el.btnSaveSlot.disabled = false;
      if (this.el.slotStatusClaimedNote) {
        this.el.slotStatusClaimedNote.textContent = 'Set operational service status.';
      }
      if (this.el.slotCode) this.el.slotCode.focus();
    }

    this.el.modalSlot.classList.remove('hidden');
  }

  enableSlotFormFields(enabled) {
    if (this.el.slotCode) this.el.slotCode.disabled = !enabled;
    if (this.el.slotZone) this.el.slotZone.disabled = !enabled;
    if (this.el.slotFloor) this.el.slotFloor.disabled = !enabled;
    if (this.el.slotVehicleType) this.el.slotVehicleType.disabled = !enabled;
    if (this.el.slotPriceRupees) this.el.slotPriceRupees.disabled = !enabled;
    if (this.el.slotDistance) this.el.slotDistance.disabled = !enabled;
    const checkboxes = this.el.formSlot.querySelectorAll('input[name="slot-features"]');
    for (const cb of checkboxes) cb.disabled = !enabled;
  }

  closeSlotModal() {
    if (this.el.modalSlot) this.el.modalSlot.classList.add('hidden');
    if (this.activeModal === this.el.modalSlot) this.activeModal = null;
    this.editingSlot = null;
    this.restoreFocus();
  }

  clearSlotErrors() {
    if (this.el.slotFormError) this.el.slotFormError.classList.add('hidden');
    if (this.el.slotFormErrorText) this.el.slotFormErrorText.textContent = '';
  }

  showSlotError(msg) {
    if (!this.el.slotFormError) return;
    if (this.el.slotFormErrorText) this.el.slotFormErrorText.textContent = msg;
    this.el.slotFormError.classList.remove('hidden');
  }

  async handleSlotSubmit(e) {
    e.preventDefault();
    if (this.isSubmittingSlot) return;
    this.clearSlotErrors();

    const locationId = this.el.slotLocationId ? String(this.el.slotLocationId.value ?? '').trim() : '';
    const slotId = this.el.slotId ? String(this.el.slotId.value ?? '').trim() : '';

    if (!locationId) {
      this.showSlotError('Parent location is missing. Cannot save slot.');
      return;
    }

    const isClaimed = Boolean(slotId && this.editingSlot && this.editingSlot.activeBooking);

    let payload;

    if (isClaimed) {
      // OCCUPIED / CLAIMED SLOT:
      // Backend strictly rejects any non-status keys with 409 SLOT_CLAIMED.
      // Only placing into maintenance is allowed.
      const chosenStatus = this.el.slotServiceStatus ? String(this.el.slotServiceStatus.value ?? '') : '';
      if (!chosenStatus || chosenStatus === this.editingSlot.serviceStatus) {
        this.showSlotError('No operational status change selected. Occupied slots can only be transitioned to maintenance.');
        return;
      }
      if (chosenStatus !== 'maintenance') {
        this.showSlotError('Occupied slots can only be transitioned to maintenance status.');
        return;
      }

      // Strictly ONLY serviceStatus: 'maintenance'
      payload = { serviceStatus: 'maintenance' };
    } else {
      // UNCLAIMED OR NEW SLOT:
      const code = this.el.slotCode ? String(this.el.slotCode.value ?? '').trim().toUpperCase() : '';
      if (!code) {
        this.showSlotError('Slot Code is required (e.g. A-101).');
        if (this.el.slotCode) this.el.slotCode.focus();
        return;
      }

      const priceCheck = convertRupeesToPaise(this.el.slotPriceRupees ? String(this.el.slotPriceRupees.value ?? '').trim() : '');
      if (!priceCheck.valid) {
        this.showSlotError(priceCheck.error);
        return;
      }

      const checkedFeatures = [];
      const checkboxes = this.el.formSlot.querySelectorAll('input[name="slot-features"]:checked');
      for (const cb of checkboxes) checkedFeatures.push(cb.value);

      // Preserve unrepresented features when editing
      let features = checkedFeatures;
      if (slotId && this.editingSlot && Array.isArray(this.editingSlot.features)) {
        features = mergePreservedItems(this.editingSlot.features, checkedFeatures, KNOWN_SLOT_FEATURE_VALUES);
      }

      const rawData = {
        code,
        zone: this.el.slotZone ? String(this.el.slotZone.value ?? '').trim().toUpperCase() : '',
        floor: this.el.slotFloor ? String(this.el.slotFloor.value ?? '').trim() : '',
        vehicleType: this.el.slotVehicleType && ALLOWED_VEHICLE_TYPES.has(this.el.slotVehicleType.value) ? this.el.slotVehicleType.value : 'car',
        pricePerHourPaise: priceCheck.paise,
        distanceFromEntry: this.el.slotDistance ? String(this.el.slotDistance.value ?? '').trim() : '',
        features,
      };

      payload = buildSlotPayload(rawData);

      // Include serviceStatus ONLY if editing and the status has actually changed
      if (slotId && this.editingSlot && this.el.slotServiceStatus && !this.el.slotServiceStatus.disabled) {
        const chosenStatus = this.el.slotServiceStatus.value;
        if (chosenStatus && chosenStatus !== this.editingSlot.serviceStatus) {
          payload.serviceStatus = chosenStatus;
        }
      }
    }

    this.isSubmittingSlot = true;
    if (this.el.btnSaveSlot) {
      this.el.btnSaveSlot.disabled = true;
      this.el.btnSaveSlot.textContent = 'Saving...';
    }

    const targetLocationId = locationId;
    const targetSlotId = slotId;

    try {
      if (targetSlotId) {
        // PATCH existing slot scoped to locationId and slotId
        const res = await ApiClient.patch(`/api/admin/locations/${targetLocationId}/slots/${targetSlotId}`, payload);
        if (res && res.success) {
          const currentModalLoc = this.el.slotLocationId ? String(this.el.slotLocationId.value ?? '').trim() : '';
          const currentModalSlotId = this.el.slotId ? String(this.el.slotId.value ?? '').trim() : '';
          const isSameEditor = currentModalLoc === targetLocationId && currentModalSlotId === targetSlotId;
          if (isSameEditor) {
            this.closeSlotModal();
          }
          this.showGlobalAlert(`Slot "${payload.code || (this.editingSlot && this.editingSlot.code) || ''}" updated successfully.`, 'success');
          if (this.selectedLocationId === targetLocationId) {
            await this.loadSlotsForLocation(targetLocationId);
          }
          await this.loadLocations();
          await this.loadOverview();
        } else {
          throw new Error(res?.message || 'Failed to update slot.');
        }
      } else {
        // POST new slot scoped to locationId
        const res = await ApiClient.post(`/api/admin/locations/${targetLocationId}/slots`, payload);
        if (res && res.success) {
          const currentModalLoc = this.el.slotLocationId ? String(this.el.slotLocationId.value ?? '').trim() : '';
          const currentModalSlotId = this.el.slotId ? String(this.el.slotId.value ?? '').trim() : '';
          const isSameEditor = currentModalLoc === targetLocationId && !currentModalSlotId;
          if (isSameEditor) {
            this.closeSlotModal();
          }
          this.showGlobalAlert(`Slot "${payload.code}" added successfully.`, 'success');
          if (this.selectedLocationId === targetLocationId) {
            await this.loadSlotsForLocation(targetLocationId);
          }
          await this.loadLocations();
          await this.loadOverview();
        } else {
          throw new Error(res?.message || 'Failed to create slot.');
        }
      }
    } catch (err) {
      console.error('[AdminConsole] Slot save error:', err);
      if (err.status === 409 && err.data?.code === 'DUPLICATE_SLOT_CODE') {
        this.showSlotError(`Slot code "${payload.code || (this.editingSlot && this.editingSlot.code) || ''}" already exists in this location. Codes must be unique per location.`);
      } else if (err.status === 409 && err.data?.code === 'SLOT_CLAIMED') {
        this.showSlotError('This slot is currently occupied by an active booking. Modifications are restricted to maintenance.');
      } else if (err.status === 409 && err.data?.code === 'ARCHIVED_IMMUTABLE') {
        this.showSlotError('Cannot add or modify slots for an archived location.');
      } else {
        this.showSlotError(err.message || 'Failed to save slot.');
      }
    } finally {
      this.isSubmittingSlot = false;
      if (this.el.btnSaveSlot) {
        this.el.btnSaveSlot.disabled = false;
        this.el.btnSaveSlot.textContent = 'Save Slot';
      }
    }
  }

  async toggleSlotMaintenance(slot) {
    if (!this.selectedLocationId || this.isPerformingLifecycle) return;
    const isOccupied = Boolean(slot.activeBooking);
    if (isOccupied && slot.serviceStatus === 'maintenance') {
      this.showGlobalAlert('Occupied slots in maintenance cannot be re-enabled while an active booking exists.', 'error');
      return;
    }
    const targetLocationId = this.selectedLocationId;
    this.isPerformingLifecycle = true;

    const newStatus = slot.serviceStatus === 'maintenance' ? 'enabled' : 'maintenance';
    try {
      const res = await ApiClient.patch(`/api/admin/locations/${targetLocationId}/slots/${slot.id || slot._id}`, {
        serviceStatus: newStatus,
      });
      if (res && res.success) {
        this.showGlobalAlert(`Slot "${slot.code}" service status changed to ${newStatus}.`, 'success');
        if (this.selectedLocationId === targetLocationId) {
          await this.loadSlotsForLocation(targetLocationId);
        }
        await this.loadOverview();
      }
    } catch (err) {
      this.showGlobalAlert(err.message || 'Failed to update slot service status.', 'error');
    } finally {
      this.isPerformingLifecycle = false;
    }
  }

  promptArchiveSlot(slot) {
    if (!this.selectedLocationId || !this.selectedLocation) return;

    this.openConfirmModal({
      title: `Archive Slot: ${slot.code}?`,
      message: `Are you sure you want to archive slot "${slot.code}" in location "${this.selectedLocation.name}"?`,
      warning: 'Archiving a slot is permanent. The slot will no longer be available for booking. (Archived slots cannot be deleted or re-enabled).',
      proceedText: 'Archive Slot',
      onProceed: async () => {
        if (this.isPerformingLifecycle) return;
        this.isPerformingLifecycle = true;
        try {
          const res = await ApiClient.patch(`/api/admin/locations/${this.selectedLocationId}/slots/${slot.id || slot._id}`, {
            serviceStatus: 'archived',
          });
          if (res && res.success) {
            this.showGlobalAlert(`Slot "${slot.code}" has been archived.`, 'success');
            await this.loadSlotsForLocation(this.selectedLocationId);
            await this.loadOverview();
          }
        } catch (err) {
          if (err.status === 409 && err.data?.code === 'SLOT_CLAIMED') {
            this.showGlobalAlert(`Cannot archive slot "${slot.code}": slot has an active booking.`, 'error');
          } else {
            this.showGlobalAlert(err.message || 'Failed to archive slot.', 'error');
          }
        } finally {
          this.isPerformingLifecycle = false;
        }
      },
    });
  }

  // ── Bookings Oversight ──────────────────────────────────────

  async loadBookings() {
    const seq = ++this.bookingsRequestSeq;
    if (this.el.bookingsLoading) this.el.bookingsLoading.classList.remove('hidden');
    if (this.el.bookingsError) this.el.bookingsError.classList.add('hidden');
    if (this.el.bookingsEmpty) this.el.bookingsEmpty.classList.add('hidden');
    if (this.el.bookingsTableWrapper) this.el.bookingsTableWrapper.classList.add('hidden');

    try {
      let queryUrl = `/api/admin/bookings?page=${this.bookingsPage}&limit=${this.bookingsLimit}`;
      if (this.bookingsLocationFilter) {
        queryUrl += `&location=${encodeURIComponent(this.bookingsLocationFilter)}`;
      }
      if (this.bookingsStatusFilter) {
        queryUrl += `&status=${encodeURIComponent(this.bookingsStatusFilter)}`;
      }

      const res = await ApiClient.get(queryUrl);
      if (seq !== this.bookingsRequestSeq) return;

      if (res && res.success) {
        this.bookings = res.bookings || [];
        this.bookingsTotal = res.total || 0;
        this.renderBookingsTable();
      } else {
        throw new Error(res?.message || 'Failed to retrieve bookings.');
      }
    } catch (err) {
      if (seq !== this.bookingsRequestSeq) return;
      console.error('[AdminConsole] Failed to load bookings:', err);
      if (this.el.bookingsErrorMessage) {
        this.el.bookingsErrorMessage.textContent = err.message || 'Error loading bookings.';
      }
      if (this.el.bookingsError) this.el.bookingsError.classList.remove('hidden');
    } finally {
      if (seq === this.bookingsRequestSeq && this.el.bookingsLoading) {
        this.el.bookingsLoading.classList.add('hidden');
      }
    }
  }

  renderBookingsTable() {
    if (!this.el.bookingsTbody) return;
    this.el.bookingsTbody.innerHTML = '';

    if (this.bookings.length === 0) {
      if (this.el.bookingsEmpty) this.el.bookingsEmpty.classList.remove('hidden');
      this.updateBookingsPagination(0, 1, 1);
      return;
    }

    if (this.el.bookingsTableWrapper) this.el.bookingsTableWrapper.classList.remove('hidden');

    for (const b of this.bookings) {
      const tr = document.createElement('tr');

      // Col 1: Booking Reference
      const tdRef = document.createElement('td');
      const refStrong = document.createElement('strong');
      refStrong.textContent = `#${String(b.id || b._id || '').slice(-8)}`;
      tdRef.appendChild(refStrong);
      if (b.createdAt) {
        const timeDiv = document.createElement('div');
        timeDiv.className = 'field-help';
        timeDiv.textContent = new Date(b.createdAt).toLocaleDateString();
        tdRef.appendChild(timeDiv);
      }
      tr.appendChild(tdRef);

      // Col 2: Customer / User
      const tdUser = document.createElement('td');
      if (b.user && typeof b.user === 'object') {
        const userName = document.createElement('div');
        userName.textContent = b.user.name || 'Anonymous';
        tdUser.appendChild(userName);

        const userContact = document.createElement('div');
        userContact.className = 'field-help';
        userContact.textContent = [b.user.email, b.user.phone].filter(Boolean).join(' • ');
        tdUser.appendChild(userContact);
      } else {
        tdUser.textContent = 'Guest / Unknown';
      }
      tr.appendChild(tdUser);

      // Col 3: Location & Slot
      const tdLocSlot = document.createElement('td');
      const locName = document.createElement('strong');
      locName.textContent = b.locationName || 'Location';
      tdLocSlot.appendChild(locName);

      const slotSpan = document.createElement('div');
      slotSpan.className = 'field-help';
      slotSpan.textContent = `Slot: ${b.slotCode || '—'}`;
      tdLocSlot.appendChild(slotSpan);
      tr.appendChild(tdLocSlot);

      // Col 4: Vehicle
      const tdVehicle = document.createElement('td');
      if (b.vehicle) {
        const regDiv = document.createElement('div');
        regDiv.textContent = b.vehicle.registrationNumber || '—';
        tdVehicle.appendChild(regDiv);

        const typeDiv = document.createElement('div');
        typeDiv.className = 'field-help';
        const vType = b.vehicle.type || b.vehicle.vehicleType || '';
        typeDiv.textContent = vType ? vType.toUpperCase() : '—';
        tdVehicle.appendChild(typeDiv);
      } else {
        tdVehicle.textContent = '—';
      }
      tr.appendChild(tdVehicle);

      // Col 5: Schedule
      const tdSchedule = document.createElement('td');
      const startStr = b.startTime ? new Date(b.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      const endStr = b.endTime ? new Date(b.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      tdSchedule.textContent = `${startStr} – ${endStr}`;
      const durDiv = document.createElement('div');
      durDiv.className = 'field-help';
      durDiv.textContent = `${b.durationHours || 1} hr(s)`;
      tdSchedule.appendChild(durDiv);
      tr.appendChild(tdSchedule);

      // Col 6: Status
      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge badge-${b.status || 'active'}`;
      badge.textContent = b.status || 'active';
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // Col 7: Total (₹)
      const tdTotal = document.createElement('td');
      tdTotal.textContent = formatPaiseToRupees(b.totalPaise);
      tr.appendChild(tdTotal);

      this.el.bookingsTbody.appendChild(tr);
    }

    const totalPages = Math.ceil(this.bookingsTotal / this.bookingsLimit) || 1;
    this.updateBookingsPagination(this.bookingsTotal, this.bookingsPage, totalPages);
  }

  updateBookingsPagination(total, page, totalPages) {
    if (this.el.bookingsPageInfo) {
      this.el.bookingsPageInfo.textContent = `Page ${page} of ${totalPages} (${total} total)`;
    }
    if (this.el.btnPrevBookings) this.el.btnPrevBookings.disabled = page <= 1;
    if (this.el.btnNextBookings) this.el.btnNextBookings.disabled = page >= totalPages;
  }

  // ── Universal Confirmation Modal ────────────────────────────

  openConfirmModal({ title, message, warning, proceedText = 'Proceed', onProceed, isAlertOnly = false }) {
    if (!this.el.modalConfirm) return;

    this.lastFocusedElement = document.activeElement;
    this.activeModal = this.el.modalConfirm;

    if (this.el.modalConfirmTitle) this.el.modalConfirmTitle.textContent = title;
    if (this.el.confirmModalMessage) this.el.confirmModalMessage.textContent = message;

    if (warning && this.el.confirmModalWarning) {
      this.el.confirmModalWarning.textContent = warning;
      this.el.confirmModalWarning.classList.remove('hidden');
    } else if (this.el.confirmModalWarning) {
      this.el.confirmModalWarning.classList.add('hidden');
    }

    if (this.el.btnConfirmProceed) {
      this.el.btnConfirmProceed.textContent = proceedText;
      this.el.btnConfirmProceed.onclick = async () => {
        if (typeof onProceed === 'function') {
          await onProceed();
        }
        this.closeConfirmModal();
      };
    }

    if (this.el.btnConfirmCancel) {
      if (isAlertOnly) {
        this.el.btnConfirmCancel.classList.add('hidden');
      } else {
        this.el.btnConfirmCancel.classList.remove('hidden');
      }
    }

    this.el.modalConfirm.classList.remove('hidden');
    if (this.el.btnConfirmProceed) this.el.btnConfirmProceed.focus();
  }

  closeConfirmModal() {
    if (this.el.modalConfirm) this.el.modalConfirm.classList.add('hidden');
    if (this.activeModal === this.el.modalConfirm) this.activeModal = null;
    this.restoreFocus();
  }

  restoreFocus() {
    if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
      try {
        this.lastFocusedElement.focus();
      } catch {
        // Ignore focus restoration errors in detached/mock nodes
      }
      this.lastFocusedElement = null;
    }
  }

  trapModalFocus(e, modal) {
    if (!modal) return;
    const focusableSelectors = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(modal.querySelectorAll(focusableSelectors)).filter(
      (node) => !node.hidden && node.style.display !== 'none'
    );
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || !modal.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last || !modal.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  }
}

// ── Auto-Initialization in Browser ────────────────────────────

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    // Only auto-init if we are on admin.html
    if (document.getElementById('admin-console-app')) {
      const app = new AdminConsoleApp();
      window.__adminApp = app;
      app.init();
    }
  });
}

// ── CommonJS Exports for Testing ──────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ALLOWED_LOCATION_FIELDS,
    ALLOWED_SLOT_FIELDS,
    ALLOWED_CATEGORIES,
    ALLOWED_VEHICLE_TYPES,
    KNOWN_FACILITY_VALUES,
    KNOWN_SLOT_FEATURE_VALUES,
    validateCoordinates,
    convertRupeesToPaise,
    formatPaiseToRupees,
    buildLocationPayload,
    buildSlotPayload,
    mergePreservedItems,
    AdminConsoleApp,
  };
}
