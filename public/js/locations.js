// public/js/locations.js — Location Discovery & Interactive Map
/* ============================================================
   Smart Parking System — Public Location Discovery
   
   PURPOSE:
   Provides real-time search, filtering, and mapping of active
   parking facilities. Publicly accessible without requiring login.

   DEPENDS ON (loaded before this file):
     - js/storage.js → SessionStore
     - js/api.js     → ApiClient, ApiError
     - js/utils.js   → showToast (optional)
     - vendor/leaflet/leaflet.js → window.L (optional / degraded)
   ============================================================ */

'use strict';

/**
 * Storage key for non-sensitive search filter preferences.
 * Only saves city/area preference strings. Never stores JWTs or counts.
 */
const SEARCH_PREFS_KEY = 'parkwise_search_pref';

/**
 * Validate latitude and longitude coordinates.
 * Valid ranges: latitude [-90, 90], longitude [-180, 180].
 * Explicitly accepts valid zero coordinates (0, 0).
 * Rejects empty/whitespace strings and non-numeric values.
 *
 * @param {any} lat
 * @param {any} lng
 * @returns {boolean}
 */
function isValidCoordinate(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return false;
  }
  if (typeof lat === 'string' && lat.trim() === '') {
    return false;
  }
  if (typeof lng === 'string' && lng.trim() === '') {
    return false;
  }
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
    return false;
  }
  if (numLat < -90 || numLat > 90) {
    return false;
  }
  if (numLng < -180 || numLng > 180) {
    return false;
  }
  return true;
}

/**
 * Build a safe query string with URLSearchParams.
 *
 * @param {{ q?: string, city?: string, area?: string, page?: number, limit?: number }} params
 * @returns {string} Encoded query string (e.g. "q=Mall&page=1&limit=10")
 */
function buildLocationQueryString(params = {}) {
  const sp = new URLSearchParams();
  if (params.q && typeof params.q === 'string' && params.q.trim()) {
    sp.set('q', params.q.trim());
  }
  if (params.city && typeof params.city === 'string' && params.city.trim()) {
    sp.set('city', params.city.trim());
  }
  if (params.area && typeof params.area === 'string' && params.area.trim()) {
    sp.set('area', params.area.trim());
  }
  if (params.page && Number.isFinite(Number(params.page)) && Number(params.page) >= 1) {
    sp.set('page', String(Math.floor(Number(params.page))));
  }
  if (params.limit && Number.isFinite(Number(params.limit)) && Number(params.limit) >= 1) {
    sp.set('limit', String(Math.floor(Number(params.limit))));
  }
  return sp.toString();
}

/**
 * Safe text helper: sets textContent on DOM elements.
 * Prevents any unsanitized HTML injection from API responses.
 *
 * @param {HTMLElement} element
 * @param {string|number} text
 */
function setSafeText(element, text) {
  if (!element) return;
  element.textContent = text !== null && text !== undefined ? String(text) : '';
}

/**
 * Main Discovery Application Controller
 */
const LocationDiscoveryApp = (() => {
  // Application State
  const state = {
    q: '',
    city: '',
    area: '',
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
    locations: [],
    selectedLocationId: null,
    isLoading: false,
    requestId: 0,
    abortController: null,
  };

  // Leaflet references
  let leafletMap = null;
  let markersLayer = null;
  const markerMap = new Map(); // locationId -> L.Marker
  let isMapInitialized = false;

  // Modal tracking
  let modalOpenerElement = null;
  let detailRequestId = 0;

  // DOM Elements cache
  let elements = {};

  /**
   * Load non-sensitive preferences from localStorage.
   */
  function loadSearchPreferences() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(SEARCH_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.city === 'string') state.city = parsed.city;
        if (typeof parsed.area === 'string') state.area = parsed.area;
      }
    } catch {
      // Ignore storage read errors
    }
  }

  /**
   * Persist non-sensitive filter choices.
   */
  function saveSearchPreferences() {
    try {
      if (typeof localStorage === 'undefined') return;
      const payload = {
        city: state.city || '',
        area: state.area || '',
      };
      localStorage.setItem(SEARCH_PREFS_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage write errors
    }
  }

  /**
   * Configure Leaflet Default Icon assets path to local public/vendor.
   */
  function setupLeafletIconAssets() {
    if (typeof window !== 'undefined' && window.L && window.L.Icon && window.L.Icon.Default) {
      try {
        delete window.L.Icon.Default.prototype._getIconUrl;
        window.L.Icon.Default.mergeOptions({
          iconRetinaUrl: 'vendor/leaflet/images/marker-icon-2x.png',
          iconUrl: 'vendor/leaflet/images/marker-icon.png',
          shadowUrl: 'vendor/leaflet/images/marker-shadow.png',
        });
      } catch (err) {
        console.warn('Could not customize Leaflet icon paths:', err);
      }
    }
  }

  /**
   * Initialize Leaflet Map with OpenStreetMap tiles.
   */
  function initMap() {
    const mapContainer = document.getElementById('map');
    const fallbackEl = document.getElementById('map-fallback');
    if (!mapContainer) return;

    if (!window.L || typeof window.L.map !== 'function') {
      if (fallbackEl) fallbackEl.hidden = false;
      return;
    }

    try {
      setupLeafletIconAssets();

      // Default view: Center on India at zoom 5
      leafletMap = window.L.map('map', {
        center: [20.5937, 78.9629],
        zoom: 5,
        zoomControl: true,
      });

      // Standard OpenStreetMap Tile Layer
      const tileLayer = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
      });

      // Handle tile loading failures with a visible non-destructive notice
      tileLayer.on('tileerror', () => {
        const tileNotice = document.getElementById('map-tile-notice');
        if (tileNotice) {
          tileNotice.hidden = false;
        }
      });

      tileLayer.addTo(leafletMap);

      markersLayer = window.L.layerGroup().addTo(leafletMap);
      isMapInitialized = true;
    } catch (err) {
      console.warn('Map initialization failed; running in map-degraded mode:', err);
      if (fallbackEl) fallbackEl.hidden = false;
      isMapInitialized = false;
    }
  }

  /**
   * Render or update map markers for current locations page.
   * Pins strictly represent the current page results.
   */
  function updateMapMarkers() {
    if (!isMapInitialized || !markersLayer || !leafletMap) return;

    markersLayer.clearLayers();
    markerMap.clear();

    const validBounds = [];
    const emptyOverlay = document.getElementById('map-empty');
    const pinCountBadge = document.getElementById('map-pin-count');

    let validCoordsCount = 0;

    for (const loc of state.locations) {
      if (!isValidCoordinate(loc.latitude, loc.longitude)) {
        continue;
      }

      validCoordsCount++;
      const lat = Number(loc.latitude);
      const lng = Number(loc.longitude);
      validBounds.push([lat, lng]);

      const marker = window.L.marker([lat, lng]);

      // Build safe popup DOM content (no raw HTML insertion)
      const popupEl = document.createElement('div');
      popupEl.className = 'map-popup-node';

      const titleEl = document.createElement('div');
      titleEl.className = 'map-popup-title';
      titleEl.textContent = loc.name || 'Parking Facility';
      popupEl.appendChild(titleEl);

      const addressEl = document.createElement('div');
      addressEl.className = 'map-popup-address';
      addressEl.textContent = `${loc.address || ''}${loc.city ? ', ' + loc.city : ''}`;
      popupEl.appendChild(addressEl);

      const statusEl = document.createElement('div');
      const isClosed = loc.status === 'closed';
      statusEl.className = `map-popup-status ${isClosed ? 'is-closed' : 'is-active'}`;
      statusEl.textContent = isClosed ? 'Closed (Temporarily Unavailable)' : 'Active (Available)';
      popupEl.appendChild(statusEl);

      const slotsEl = document.createElement('div');
      slotsEl.className = 'map-popup-address';
      slotsEl.style.marginTop = '4px';
      slotsEl.textContent = `Available slots: ${loc.availableSlots ?? 0} / ${loc.totalSlots ?? 0}`;
      popupEl.appendChild(slotsEl);

      marker.bindPopup(popupEl);

      // Marker click synchronizes with card selection
      marker.on('click', () => {
        selectLocationCard(loc.id, { scrollIntoView: true, panMap: false });
      });

      marker.addTo(markersLayer);
      markerMap.set(loc.id, marker);
    }

    if (pinCountBadge) {
      pinCountBadge.textContent = `${validCoordsCount} pin${validCoordsCount === 1 ? '' : 's'}`;
    }

    if (validBounds.length > 0) {
      if (emptyOverlay) emptyOverlay.hidden = true;
      if (validBounds.length === 1) {
        leafletMap.setView(validBounds[0], 14);
      } else {
        leafletMap.fitBounds(validBounds, { padding: [35, 35], maxZoom: 15 });
      }
    } else {
      if (emptyOverlay) emptyOverlay.hidden = false;
    }
  }

  /**
   * Synchronize selection between card and map marker.
   *
   * @param {string} locationId
   * @param {{ scrollIntoView?: boolean, panMap?: boolean }} opts
   */
  function selectLocationCard(locationId, { scrollIntoView = false, panMap = true } = {}) {
    state.selectedLocationId = locationId;

    // Update card styling
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const allCards = document.querySelectorAll('.location-card');
      if (allCards && typeof allCards.forEach === 'function') {
        allCards.forEach((c) => {
          if (c.getAttribute && c.getAttribute('data-id') === locationId) {
            if (c.classList && c.classList.add) c.classList.add('is-selected');
            if (scrollIntoView && typeof c.scrollIntoView === 'function') {
              c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          } else {
            if (c.classList && c.classList.remove) c.classList.remove('is-selected');
          }
        });
      }
    }

    // Update map marker and open popup
    if (isMapInitialized && leafletMap && markerMap.has(locationId)) {
      const marker = markerMap.get(locationId);
      if (panMap) {
        leafletMap.setView(marker.getLatLng(), Math.max(leafletMap.getZoom(), 14), {
          animate: true,
        });
      }
      marker.openPopup();
    }
  }

  /**
   * Render individual location card.
   *
   * @param {Object} loc - Location DTO from API
   * @returns {HTMLElement} Card DOM element
   */
  function createLocationCard(loc) {
    const card = document.createElement('article');
    card.className = `location-card ${loc.status === 'closed' ? 'is-closed' : ''}`;
    card.setAttribute('data-id', loc.id);
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', `Parking facility ${loc.name}`);

    // Card Header
    const cardHeader = document.createElement('div');
    cardHeader.className = 'card-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'card-title-group';

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = loc.name || 'Unnamed Facility';
    titleGroup.appendChild(title);

    const badges = document.createElement('div');
    badges.className = 'card-badges';

    if (loc.category) {
      const catBadge = document.createElement('span');
      catBadge.className = 'category-badge';
      catBadge.textContent = loc.category;
      badges.appendChild(catBadge);
    }

    const statusBadge = document.createElement('span');
    const isClosed = loc.status === 'closed';
    statusBadge.className = `status-badge ${isClosed ? 'status-badge--closed' : 'status-badge--active'}`;
    statusBadge.textContent = isClosed ? 'Closed' : 'Active';
    badges.appendChild(statusBadge);

    titleGroup.appendChild(badges);
    cardHeader.appendChild(titleGroup);

    // Header Action: View Details button
    const actions = document.createElement('div');
    actions.className = 'card-actions location-card-actions';

    const btnDetails = document.createElement('button');
    btnDetails.type = 'button';
    btnDetails.className = 'btn btn-secondary';
    btnDetails.textContent = 'View Details';
    btnDetails.setAttribute('aria-label', `View details for ${loc.name}`);
    btnDetails.onclick = (e) => {
      e.stopPropagation();
      openLocationDetailsModal(loc.id, btnDetails);
    };
    actions.appendChild(btnDetails);

    if (loc.status === 'active') {
      const btnCardSlots = document.createElement('a');
      btnCardSlots.className = 'btn btn-primary';
      btnCardSlots.textContent = 'View Slots';
      btnCardSlots.href = `booking.html?locationId=${encodeURIComponent(loc.id)}`;
      btnCardSlots.setAttribute('aria-label', `View slots for ${loc.name}`);
      btnCardSlots.onclick = (e) => {
        e.stopPropagation();
      };
      actions.appendChild(btnCardSlots);
    }
    cardHeader.appendChild(actions);

    card.appendChild(cardHeader);

    // Address & City/Area
    const addressP = document.createElement('p');
    addressP.className = 'card-address';
    addressP.textContent = loc.address || 'Address not listed';
    card.appendChild(addressP);

    const areaCityP = document.createElement('p');
    areaCityP.className = 'card-area-city';
    const cityAreaText = [loc.area, loc.city].filter(Boolean).join(', ');
    areaCityP.textContent = cityAreaText || 'Location unspecified';
    card.appendChild(areaCityP);

    // Facilities tags
    if (Array.isArray(loc.facilities) && loc.facilities.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'facilities-tags';
      loc.facilities.slice(0, 4).forEach((facility) => {
        const tag = document.createElement('span');
        tag.className = 'facility-tag';
        tag.textContent = facility;
        tagsContainer.appendChild(tag);
      });
      if (loc.facilities.length > 4) {
        const moreTag = document.createElement('span');
        moreTag.className = 'facility-tag';
        moreTag.textContent = `+${loc.facilities.length - 4} more`;
        tagsContainer.appendChild(moreTag);
      }
      card.appendChild(tagsContainer);
    }

    // Slots Count & Status Row
    const slotsRow = document.createElement('div');
    slotsRow.className = 'card-slots-row';

    const slotBadge = document.createElement('div');
    slotBadge.className = 'slot-count-badge';

    if (isClosed) {
      const notice = document.createElement('span');
      notice.className = 'closed-notice';
      notice.textContent = loc.unavailableReason || 'Facility temporarily closed; booking unavailable.';
      slotBadge.appendChild(notice);
    } else {
      const numSpan = document.createElement('span');
      numSpan.className = 'slot-count-num';
      numSpan.textContent = String(loc.availableSlots ?? 0);
      slotBadge.appendChild(numSpan);

      const labelSpan = document.createElement('span');
      labelSpan.textContent = ` available of ${loc.totalSlots ?? 0} slots`;
      slotBadge.appendChild(labelSpan);
    }
    slotsRow.appendChild(slotBadge);

    // Map Action Button (if location has valid coordinates)
    if (isValidCoordinate(loc.latitude, loc.longitude)) {
      const btnMap = document.createElement('button');
      btnMap.type = 'button';
      btnMap.className = 'btn btn-outline';
      btnMap.style.fontSize = '0.8rem';
      btnMap.style.padding = '0.3rem 0.8rem';
      btnMap.textContent = 'Map';
      btnMap.setAttribute('aria-label', `Locate ${loc.name} on map`);
      btnMap.onclick = (e) => {
        e.stopPropagation();
        selectLocationCard(loc.id, { panMap: true });
      };
      slotsRow.appendChild(btnMap);
    }

    card.appendChild(slotsRow);

    // Click on card selects and synchronizes
    card.onclick = () => {
      selectLocationCard(loc.id, { panMap: true });
    };

    // Keyboard support: Enter or Space selects card ONLY when not originating from a nested button
    card.onkeydown = (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) {
        return; // Allow button clicks (e.g. View Details) without card intercepting
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectLocationCard(loc.id, { panMap: true });
      }
    };

    return card;
  }

  /**
   * Update Pagination controls.
   */
  function updatePaginationControls() {
    const pagination = elements.pagination;
    const btnPrev = elements.btnPrevPage;
    const btnNext = elements.btnNextPage;
    const pageIndicator = elements.pageIndicator;

    if (!pagination) return;

    if (state.totalPages <= 1) {
      pagination.hidden = true;
      return;
    }

    pagination.hidden = false;
    if (pageIndicator) {
      pageIndicator.textContent = `Page ${state.page} of ${state.totalPages}`;
    }
    if (btnPrev) btnPrev.disabled = state.page <= 1;
    if (btnNext) btnNext.disabled = state.page >= state.totalPages;
  }

  /**
   * Fetch locations from GET /api/locations.
   * Debounced, race-condition safe (newer responses never overwritten by older),
   * and properly resets pagination on filter updates.
   */
  async function fetchLocations() {
    state.requestId += 1;
    const thisRequestId = state.requestId;

    // Abort previous in-flight request if possible
    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch {
        // Ignore abort errors
      }
    }
    state.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    // Set UI Loading State
    state.isLoading = true;
    if (elements.loadingState) elements.loadingState.hidden = false;
    if (elements.errorState) elements.errorState.hidden = true;
    if (elements.emptyState) elements.emptyState.hidden = true;

    const queryString = buildLocationQueryString({
      q: state.q,
      city: state.city,
      area: state.area,
      page: state.page,
      limit: state.limit,
    });

    const endpoint = `/api/locations?${queryString}`;

    try {
      const fetchOpts = {};
      if (state.abortController) {
        fetchOpts.signal = state.abortController.signal;
      }

      const response = await ApiClient.get(endpoint, fetchOpts);

      // Race condition check: discard stale responses
      if (thisRequestId !== state.requestId) {
        return;
      }

      state.isLoading = false;
      if (elements.loadingState) elements.loadingState.hidden = true;

      if (!response || !response.success || !Array.isArray(response.locations)) {
        throw new Error('Invalid response structure from locations API.');
      }

      state.locations = response.locations;
      state.total = response.total || 0;
      state.totalPages = Math.max(1, Math.ceil(state.total / state.limit));

      // Update Results Summary Text
      if (elements.resultsCount) {
        if (state.total === 0) {
          elements.resultsCount.textContent = 'No facilities found';
        } else {
          const start = (state.page - 1) * state.limit + 1;
          const end = Math.min(start + state.locations.length - 1, state.total);
          elements.resultsCount.textContent = `Showing ${start}–${end} of ${state.total} facilities`;
        }
      }

      // Render Cards
      if (elements.locationsList) {
        elements.locationsList.innerHTML = '';
        if (state.locations.length === 0) {
          if (elements.emptyState) elements.emptyState.hidden = false;
        } else {
          state.locations.forEach((loc) => {
            elements.locationsList.appendChild(createLocationCard(loc));
          });
        }
      }

      // Update Pagination & Map
      updatePaginationControls();
      updateMapMarkers();
    } catch (err) {
      // Ignore AbortError from superseded requests
      if (err.name === 'AbortError') return;

      // Race condition check
      if (thisRequestId !== state.requestId) return;

      state.isLoading = false;
      if (elements.loadingState) elements.loadingState.hidden = true;
      if (elements.locationsList) elements.locationsList.innerHTML = '';
      if (elements.errorState) {
        elements.errorState.hidden = false;
        if (elements.errorMessage) {
          elements.errorMessage.textContent =
            err.message || 'Unable to connect to parking service. Please try again.';
        }
      }
      if (elements.resultsCount) {
        elements.resultsCount.textContent = 'Search failed';
      }
      if (elements.pagination) elements.pagination.hidden = true;
      if (markersLayer) markersLayer.clearLayers();
    }
  }

  /**
   * Debounce helper
   */
  let debounceTimer = null;
  function handleFilterInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.page = 1; // Reset pagination when filters change
      saveSearchPreferences();
      fetchLocations();
    }, 300);
  }

  /**
   * Open Location Details Modal (GET /api/locations/:locationId)
   * Focuses modal, traps focus while open, and prevents out-of-order race conditions.
   *
   * @param {string} locationId
   * @param {HTMLElement} [openerElement]
   */
  async function openLocationDetailsModal(locationId, openerElement) {
    const modal = elements.modal || (typeof document !== 'undefined' ? document.getElementById('location-detail-modal') : null);
    if (!modal) return;

    modalOpenerElement = openerElement || (typeof document !== 'undefined' ? document.activeElement : null);
    modal.hidden = false;
    if (typeof document !== 'undefined' && document.body && document.body.style) {
      document.body.style.overflow = 'hidden';
    }

    const btnClose = elements.btnCloseModal || (typeof document !== 'undefined' ? document.getElementById('btn-close-modal') : null);
    if (btnClose && typeof btnClose.focus === 'function') {
      btnClose.focus();
    }

    // Sequence tracking to prevent late responses from overwriting a newer modal selection
    detailRequestId += 1;
    const thisDetailReqId = detailRequestId;

    const modalName = elements.modalName || (typeof document !== 'undefined' ? document.getElementById('modal-location-name') : null);
    const modalCategory = elements.modalCategory || (typeof document !== 'undefined' ? document.getElementById('modal-location-category') : null);
    const modalStatus = elements.modalStatus || (typeof document !== 'undefined' ? document.getElementById('modal-location-status') : null);
    const modalAddress = elements.modalAddress || (typeof document !== 'undefined' ? document.getElementById('modal-location-address') : null);
    const modalCityArea = elements.modalCityArea || (typeof document !== 'undefined' ? document.getElementById('modal-location-city-area') : null);
    const modalCoords = elements.modalCoords || (typeof document !== 'undefined' ? document.getElementById('modal-location-coords') : null);
    const modalPhone = elements.modalPhone || (typeof document !== 'undefined' ? document.getElementById('modal-location-phone') : null);
    const modalPhoneContainer = elements.modalPhoneContainer || (typeof document !== 'undefined' ? document.getElementById('modal-phone-container') : null);
    const modalTotalSlots = elements.modalTotalSlots || (typeof document !== 'undefined' ? document.getElementById('modal-total-slots') : null);
    const modalAvailableSlots = elements.modalAvailableSlots || (typeof document !== 'undefined' ? document.getElementById('modal-available-slots') : null);
    const modalFacilities = elements.modalFacilities || (typeof document !== 'undefined' ? document.getElementById('modal-facilities-list') : null);
    const modalFacilitiesContainer = elements.modalFacilitiesContainer || (typeof document !== 'undefined' ? document.getElementById('modal-facilities-container') : null);
    const modalError = elements.modalError || (typeof document !== 'undefined' ? document.getElementById('modal-error') : null);
    const modalErrorText = elements.modalErrorText || (typeof document !== 'undefined' ? document.getElementById('modal-error-text') : null);
    const modalContentDetails = elements.modalContentDetails || (typeof document !== 'undefined' ? document.getElementById('modal-content-details') : null);
    const btnModalViewSlots = elements.btnModalViewSlots || (typeof document !== 'undefined' ? document.getElementById('btn-modal-view-slots') : null);
    const modalClosedWarning = elements.modalClosedWarning || (typeof document !== 'undefined' ? document.getElementById('modal-closed-warning') : null);

    // Reset modal content elements
    setSafeText(modalName, 'Loading Facility Details...');
    setSafeText(modalCategory, '');
    if (modalCategory) modalCategory.hidden = true;
    setSafeText(modalStatus, '');
    if (modalStatus) modalStatus.hidden = true;
    setSafeText(modalAddress, '');
    setSafeText(modalCityArea, '');
    setSafeText(modalCoords, '');
    setSafeText(modalPhone, '');
    setSafeText(modalTotalSlots, '--');
    setSafeText(modalAvailableSlots, '--');
    if (modalFacilities) modalFacilities.innerHTML = '';
    if (btnModalViewSlots) {
      btnModalViewSlots.hidden = true;
      if (typeof btnModalViewSlots.removeAttribute === 'function') {
        btnModalViewSlots.removeAttribute('href');
      }
    }
    if (modalClosedWarning && modalClosedWarning.style) modalClosedWarning.style.display = 'none';
    if (modalError) modalError.hidden = true;
    if (modalContentDetails) modalContentDetails.hidden = false;

    try {
      const res = await ApiClient.get(`/api/locations/${encodeURIComponent(locationId)}`);

      // Race condition check: discard stale detail response
      if (thisDetailReqId !== detailRequestId) {
        return;
      }

      if (!res || !res.success || !res.location) {
        throw new Error('Location details could not be found.');
      }

      const loc = res.location;

      setSafeText(modalName, loc.name || 'Unnamed Facility');

      if (loc.category && modalCategory) {
        setSafeText(modalCategory, loc.category);
        modalCategory.hidden = false;
      }

      if (modalStatus) {
        const isClosed = loc.status === 'closed';
        modalStatus.className = `status-badge ${isClosed ? 'status-badge--closed' : 'status-badge--active'}`;
        setSafeText(modalStatus, isClosed ? 'Closed' : 'Active');
        modalStatus.hidden = false;
      }

      setSafeText(modalAddress, loc.address || 'Address not provided.');
      setSafeText(modalCityArea, [loc.area, loc.city].filter(Boolean).join(', '));

      if (modalCoords) {
        if (isValidCoordinate(loc.latitude, loc.longitude)) {
          setSafeText(modalCoords, `Coordinates: ${loc.latitude}, ${loc.longitude}`);
          modalCoords.hidden = false;
        } else {
          modalCoords.hidden = true;
        }
      }

      if (modalPhoneContainer) {
        if (loc.contactPhone) {
          setSafeText(modalPhone, loc.contactPhone);
          modalPhoneContainer.hidden = false;
        } else {
          modalPhoneContainer.hidden = true;
        }
      }

      setSafeText(modalTotalSlots, loc.totalSlots ?? 0);
      setSafeText(modalAvailableSlots, loc.availableSlots ?? 0);

      if (modalFacilitiesContainer) {
        if (Array.isArray(loc.facilities) && loc.facilities.length > 0) {
          if (modalFacilities) {
            modalFacilities.innerHTML = '';
            loc.facilities.forEach((fac) => {
              const tag = document.createElement('span');
              tag.className = 'facility-tag';
              tag.textContent = fac;
              modalFacilities.appendChild(tag);
            });
          }
          modalFacilitiesContainer.hidden = false;
        } else {
          modalFacilitiesContainer.hidden = true;
        }
      }

      // Configure View Slots action based on active status
      if (loc.status === 'active') {
        if (btnModalViewSlots) {
          btnModalViewSlots.href = `booking.html?locationId=${encodeURIComponent(loc.id)}`;
          btnModalViewSlots.hidden = false;
          if (typeof btnModalViewSlots.removeAttribute === 'function') {
            btnModalViewSlots.removeAttribute('aria-disabled');
          }
          if (btnModalViewSlots.classList && typeof btnModalViewSlots.classList.remove === 'function') {
            btnModalViewSlots.classList.remove('btn--disabled');
          }
        }
        if (modalClosedWarning && modalClosedWarning.style) modalClosedWarning.style.display = 'none';
      } else {
        if (btnModalViewSlots) {
          btnModalViewSlots.hidden = true;
          if (typeof btnModalViewSlots.setAttribute === 'function') {
            btnModalViewSlots.setAttribute('aria-disabled', 'true');
          }
          if (btnModalViewSlots.classList && typeof btnModalViewSlots.classList.add === 'function') {
            btnModalViewSlots.classList.add('btn--disabled');
          }
          if (typeof btnModalViewSlots.removeAttribute === 'function') {
            btnModalViewSlots.removeAttribute('href');
          }
        }
        if (modalClosedWarning && modalClosedWarning.style) modalClosedWarning.style.display = 'block';
      }
    } catch (err) {
      if (thisDetailReqId !== detailRequestId) return;

      if (modalError) {
        modalError.hidden = false;
        if (modalErrorText) {
          modalErrorText.textContent =
            err.status === 404
              ? 'This parking facility is no longer available.'
              : err.message || 'Unable to retrieve location details.';
        }
      }
    }
  }

  /**
   * Close Location Details Modal and restore keyboard focus to the opening element
   */
  function closeLocationDetailsModal() {
    if (elements.modal) {
      elements.modal.hidden = true;
      document.body.style.overflow = '';
      if (modalOpenerElement && typeof modalOpenerElement.focus === 'function') {
        try {
          modalOpenerElement.focus();
        } catch {
          // Ignore focus errors
        }
      }
    }
  }

  /**
   * Update Header Auth state (logged-in user vs guest)
   * Uses real SessionStore API without nonexistent getUser() or backend logout endpoint.
   */
  async function updateHeaderAuthState() {
    const authContainer = document.getElementById('header-auth');
    if (!authContainer) return;

    if (typeof SessionStore !== 'undefined' && SessionStore.isLoggedIn()) {
      const session = SessionStore.get();
      const userName = SessionStore.getName() || session?.user?.name || session?.name || 'Account';

      authContainer.innerHTML = '';

      const userBadge = document.createElement('span');
      userBadge.className = 'header-user-badge';
      userBadge.textContent = userName;
      authContainer.appendChild(userBadge);

      const logoutBtn = document.createElement('button');
      logoutBtn.type = 'button';
      logoutBtn.className = 'btn btn-outline';
      logoutBtn.textContent = 'Logout';
      logoutBtn.style.fontSize = '0.85rem';
      logoutBtn.style.padding = '0.35rem 0.9rem';
      logoutBtn.onclick = () => {
        // Purely client-side session cleanup
        SessionStore.clear();
        window.location.reload();
      };
      authContainer.appendChild(logoutBtn);

      // Verify session authoritatively before revealing admin navigation
      if (typeof verifySession === 'function') {
        try {
          const authResult = await verifySession();
          if (authResult?.authenticated && authResult?.user?.role === 'admin' && typeof updateAdminNavigation === 'function') {
            updateAdminNavigation(authResult.user);
          }
        } catch {
          // Keep admin link hidden on verification error
        }
      } else if (session?.user?.role === 'admin' && typeof updateAdminNavigation === 'function') {
        updateAdminNavigation(session.user);
      }
    }
  }

  /**
   * Bind event listeners to DOM controls
   */
  function bindEvents() {
    // Search input debounced
    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', (e) => {
        state.q = e.target.value;
        handleFilterInput();
      });
    }

    // City text filter debounced
    if (elements.filterCity) {
      elements.filterCity.addEventListener('input', (e) => {
        state.city = e.target.value;
        handleFilterInput();
      });
    }

    // Area text filter debounced
    if (elements.filterArea) {
      elements.filterArea.addEventListener('input', (e) => {
        state.area = e.target.value;
        handleFilterInput();
      });
    }

    // Clear filters button
    const clearHandler = () => {
      state.q = '';
      state.city = '';
      state.area = '';
      state.page = 1;
      if (elements.searchInput) elements.searchInput.value = '';
      if (elements.filterCity) elements.filterCity.value = '';
      if (elements.filterArea) elements.filterArea.value = '';
      saveSearchPreferences();
      fetchLocations();
    };

    if (elements.btnClearFilters) {
      elements.btnClearFilters.addEventListener('click', clearHandler);
    }
    if (elements.btnEmptyClear) {
      elements.btnEmptyClear.addEventListener('click', clearHandler);
    }

    // Retry button on error
    if (elements.btnRetry) {
      elements.btnRetry.addEventListener('click', () => {
        fetchLocations();
      });
    }

    // Pagination buttons
    if (elements.btnPrevPage) {
      elements.btnPrevPage.addEventListener('click', () => {
        if (state.page > 1) {
          state.page -= 1;
          fetchLocations();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    if (elements.btnNextPage) {
      elements.btnNextPage.addEventListener('click', () => {
        if (state.page < state.totalPages) {
          state.page += 1;
          fetchLocations();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    // Modal close events
    if (elements.btnCloseModal) {
      elements.btnCloseModal.addEventListener('click', closeLocationDetailsModal);
    }

    if (elements.modal) {
      elements.modal.addEventListener('click', (e) => {
        if (e.target === elements.modal) {
          closeLocationDetailsModal();
        }
      });

      // Focus trap within modal
      elements.modal.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          const focusables = Array.from(
            elements.modal.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && elements.modal && !elements.modal.hidden) {
        closeLocationDetailsModal();
      }
    });
  }

  /**
   * Main Initialization
   */
  function init() {
    // Cache elements
    elements = {
      searchInput: document.getElementById('search-input'),
      filterCity: document.getElementById('filter-city'),
      filterArea: document.getElementById('filter-area'),
      btnClearFilters: document.getElementById('btn-clear-filters'),
      btnEmptyClear: document.getElementById('btn-empty-clear'),
      btnRetry: document.getElementById('btn-retry'),
      locationsList: document.getElementById('locations-list'),
      resultsCount: document.getElementById('results-count'),
      loadingState: document.getElementById('loading-state'),
      errorState: document.getElementById('error-state'),
      errorMessage: document.getElementById('error-message'),
      emptyState: document.getElementById('empty-state'),
      pagination: document.getElementById('pagination'),
      btnPrevPage: document.getElementById('btn-prev-page'),
      btnNextPage: document.getElementById('btn-next-page'),
      pageIndicator: document.getElementById('page-indicator'),
      // Modal
      modal: document.getElementById('location-detail-modal'),
      btnCloseModal: document.getElementById('btn-close-modal'),
      modalName: document.getElementById('modal-location-name'),
      modalCategory: document.getElementById('modal-location-category'),
      modalStatus: document.getElementById('modal-location-status'),
      modalAddress: document.getElementById('modal-location-address'),
      modalCityArea: document.getElementById('modal-location-city-area'),
      modalCoords: document.getElementById('modal-location-coords'),
      modalPhone: document.getElementById('modal-location-phone'),
      modalPhoneContainer: document.getElementById('modal-phone-container'),
      modalTotalSlots: document.getElementById('modal-total-slots'),
      modalAvailableSlots: document.getElementById('modal-available-slots'),
      modalFacilities: document.getElementById('modal-facilities-list'),
      modalFacilitiesContainer: document.getElementById('modal-facilities-container'),
      modalError: document.getElementById('modal-error'),
      modalErrorText: document.getElementById('modal-error-text'),
      modalContentDetails: document.getElementById('modal-content-details'),
      btnModalViewSlots: document.getElementById('btn-modal-view-slots'),
      modalClosedWarning: document.getElementById('modal-closed-warning'),
    };

    updateHeaderAuthState();
    loadSearchPreferences();

    if (elements.filterCity && state.city) elements.filterCity.value = state.city;
    if (elements.filterArea && state.area) elements.filterArea.value = state.area;

    initMap();
    bindEvents();
    fetchLocations();
  }

  return {
    init,
    fetchLocations,
    getState: () => ({ ...state }),
    setState: (newState) => Object.assign(state, newState),
    selectLocationCard,
    createLocationCard,
    openLocationDetailsModal,
    closeLocationDetailsModal,
    updateHeaderAuthState,
    isValidCoordinate,
    buildLocationQueryString,
  };
})();

// Auto-initialize when loaded in browser DOM
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', LocationDiscoveryApp.init);
  } else {
    LocationDiscoveryApp.init();
  }
}

// Export for Node/CommonJS test runners
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isValidCoordinate,
    buildLocationQueryString,
    LocationDiscoveryApp,
    SEARCH_PREFS_KEY,
  };
}
