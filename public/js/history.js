// History Module — Real Backend Migration & Live Countdown (Stage 11A)
/* ============================================================
   public/js/history.js
   ParkWise — Booking History Page Controller

   PURPOSE:
   Owns all DOM interaction for history.html using real backend APIs.
   Loads the user's booking history from GET /api/bookings/me with real
   server-side pagination, search, sorting, and status filtering.
   Displays stats and tab counts across full booking history, supports
   authoritative cancellation via PATCH /api/bookings/:id/cancel,
   provides live synchronized countdowns for active cards, and guards
   against race conditions and memory leaks.

   DEPENDS ON:
     - js/storage.js    → SessionStore
     - js/utils.js      → getElement, setText, showToast, formatDateTime,
                          formatTime, formatDuration, getStatusClass,
                          getVehicleTypeLabel, capitalise, formatCurrency,
                          redirectTo
     - js/api.js        → ApiClient, ApiError
     - js/auth.js       → requireAuth, logoutUser, getSession, getSafeReturnUrl
   ============================================================ */

'use strict';

(function () {
  // ── State & Variables ──────────────────────────────────────
  let activeStatus = 'all';
  let searchQuery = '';
  let sortOrder = 'newest';
  let currentPage = 1;
  const pageLimit = 10;
  let totalRecords = 0;
  let totalPages = 1;

  let serverClockOffsetMs = 0;
  let requestSeq = 0;
  let activeRequestSeq = 0;
  let countdownTimerId = null;
  let pollTimerId = null;
  let searchDebounceTimer = null;
  let isRefreshing = false;
  let isSuspended = false;
  let isDisposed = false;
  let isInitialized = false;
  let lastZeroRefreshTime = 0;
  let activeBookingsData = [];
  const pendingCancellations = new Set();
  const confirmedCancellations = new Set();

  // ── Safe Helper Wrappers ───────────────────────────────────
  const safeGetElement = (id) => {
    if (typeof getElement === 'function') return getElement(id);
    if (typeof document !== 'undefined') return document.getElementById(id);
    return null;
  };

  const safeSetText = (id, text) => {
    if (typeof setText === 'function') {
      setText(id, text);
    } else {
      const el = safeGetElement(id);
      if (el) el.textContent = String(text ?? '');
    }
  };

  const safeShowToast = (msg, type) => {
    if (typeof showToast === 'function') showToast(msg, type);
  };

  const safeFormatCurrency = (amount) => {
    if (typeof formatCurrency === 'function') return formatCurrency(amount);
    return `₹${Number(amount || 0).toLocaleString('en-IN')}`;
  };

  const safeFormatDateTime = (d) => {
    if (typeof formatDateTime === 'function') return formatDateTime(d);
    return d ? new Date(d).toLocaleString() : '—';
  };

  const safeFormatTime = (t) => {
    if (typeof formatTime === 'function') return formatTime(t);
    return t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  };

  const safeFormatDuration = (h) => {
    if (typeof formatDuration === 'function') return formatDuration(h);
    return `${h} hr${h > 1 ? 's' : ''}`;
  };

  const safeGetStatusClass = (s) => {
    if (typeof getStatusClass === 'function') return getStatusClass(s);
    return `status--${s}`;
  };

  const safeGetVehicleTypeLabel = (t) => {
    if (typeof getVehicleTypeLabel === 'function') return getVehicleTypeLabel(t);
    return String(t || '').toUpperCase();
  };

  const safeCapitalise = (s) => {
    if (typeof capitalise === 'function') return capitalise(s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  };

  const formatPaise = (paise) => {
    if (typeof paise !== 'number' || !Number.isFinite(paise)) return '₹0';
    return safeFormatCurrency(paise / 100);
  };

  const getVehicleIcon = (type) => {
    return safeGetVehicleTypeLabel(type);
  };

  const debounce = (fn, delayMs) => {
    return (...args) => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        fn(...args);
      }, delayMs);
    };
  };

  const calculateRemainingMs = (endTime) => {
    if (!endTime) return 0;
    const endMs = new Date(endTime).getTime();
    const currentServerMs = Date.now() + serverClockOffsetMs;
    return Math.max(0, endMs - currentServerMs);
  };

  const formatRemainingTime = (diffMs) => {
    if (diffMs <= 0) {
      return 'Checking booking status…';
    }
    const totalSecs = Math.floor(diffMs / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    if (hrs > 0) {
      return `${hrs}h ${mins}m ${secs}s remaining`;
    }
    if (mins > 0) {
      return `${mins}m ${secs}s remaining`;
    }
    return `${secs}s remaining`;
  };

  // ── Session Expiry & Auth Error Handler ─────────────────────
  const handleAuthError = (err) => {
    if (err && err.status === 401) {
      cleanup();
      if (typeof SessionStore !== 'undefined' && SessionStore && typeof SessionStore.clear === 'function') {
        SessionStore.clear();
      }
      let target = '';
      if (typeof window !== 'undefined' && window.location) {
        const pageName = window.location.pathname.split('/').pop() || '';
        if (pageName && pageName !== 'login.html' && pageName !== 'register.html') {
          target = pageName + window.location.search;
        }
      }
      const safeTarget = typeof getSafeReturnUrl === 'function' ? getSafeReturnUrl(target, '') : target;
      const loginRedirect = safeTarget && safeTarget !== 'dashboard.html'
        ? `login.html?returnUrl=${encodeURIComponent(safeTarget)}`
        : 'login.html';
      if (typeof redirectTo === 'function') {
        redirectTo(loginRedirect);
      } else if (typeof window !== 'undefined' && window.location) {
        window.location.href = loginRedirect;
      }
      return true;
    }
    return false;
  };

  // ── Countdown Tick ─────────────────────────────────────────
  const updateCountdowns = () => {
    if (typeof document === 'undefined' || document.hidden || isDisposed || isSuspended) return;
    const countdownEls = document.querySelectorAll('#history-list [data-countdown-end]');
    let hasExpiredSlot = false;

    countdownEls.forEach((el) => {
      const endIso = el.getAttribute('data-countdown-end');
      const remMs = calculateRemainingMs(endIso);
      const textSpan = el.querySelector('.countdown-text');
      if (textSpan) {
        textSpan.textContent = formatRemainingTime(remMs);
      }
      if (remMs <= 0) {
        hasExpiredSlot = true;
      }
    });

    if (hasExpiredSlot && !isRefreshing && !isDisposed && !isSuspended && !document.hidden && activeBookingsData.length > 0) {
      const now = Date.now();
      if (now - lastZeroRefreshTime > 8000) {
        lastZeroRefreshTime = now;
        loadHistory({ silent: true });
      }
    }
  };

  const startCountdownTimer = () => {
    stopCountdownTimer();
    if (isDisposed || isSuspended) return;
    countdownTimerId = setInterval(updateCountdowns, 1000);
  };

  const stopCountdownTimer = () => {
    if (countdownTimerId) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  };

  // ── Polling Controls ───────────────────────────────────────
  const startPolling = () => {
    stopPolling();
    if (isDisposed || isSuspended) return;
    pollTimerId = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden && !isDisposed && !isSuspended && !isRefreshing) {
        loadHistory({ silent: true });
      }
    }, 30000);
  };

  const stopPolling = () => {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  };

  const handleVisibilityChange = () => {
    if (isDisposed || isSuspended) return;
    if (typeof document !== 'undefined' && document.hidden) {
      stopPolling();
      stopCountdownTimer();
    } else {
      startCountdownTimer();
      startPolling();
      if (!isRefreshing) {
        loadHistory({ silent: true });
      }
    }
  };

  // ── Page Lifecycle: Suspend vs Resume vs Permanent Teardown ─
  const suspendPage = () => {
    isSuspended = true;
    requestSeq++; // Invalidate stale in-flight responses
    isRefreshing = false;
    stopCountdownTimer();
    stopPolling();
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };

  const resumePage = (event) => {
    if (isDisposed) return;
    // Only resume if restored from bfcache or resuming from suspension
    const shouldResume = event ? Boolean(event.persisted) : isSuspended;
    if (shouldResume) {
      isSuspended = false;
      isDisposed = false;

      // Re-attach visibility listener cleanly
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }

      // Resume timers and refresh visible data
      if (typeof document === 'undefined' || !document.hidden) {
        startCountdownTimer();
        startPolling();
        loadHistory({ silent: true });
      }
    }
  };

  const handlePageHide = () => {
    suspendPage();
  };

  const handlePageShow = (event) => {
    resumePage(event);
  };

  // ── User Info ──────────────────────────────────────────────
  const populateUserInfo = () => {
    if (typeof getSession !== 'function') return;
    const session = getSession();
    if (!session) return;
    const firstName = session.name ? session.name.trim().split(' ')[0] : 'there';
    const roleSuffix = session.role === 'admin' ? ' (Admin)' : '';
    safeSetText('header-user-name', `Hi, ${firstName}${roleSuffix}`);

    const adminNav = safeGetElement('nav-admin-link');
    if (adminNav) {
      if (session.role === 'admin') adminNav.classList.remove('hidden');
      else adminNav.classList.add('hidden');
    }
  };

  // ── Safe Card Builder (DOM Construction) ───────────────────
  const createHistoryCard = (booking) => {
    const statusClass = safeGetStatusClass(booking.status);
    const isActive = booking.status === 'active';
    const isCancelled = booking.status === 'cancelled';
    const vehicleType = booking.vehicle?.type || 'car';
    const vehicleReg = booking.vehicle?.registrationNumber || '—';
    const remMs = calculateRemainingMs(booking.endTime);

    const article = typeof document !== 'undefined'
      ? document.createElement('article')
      : { className: '', dataset: {}, appendChild: () => {} };

    if (article.classList && article.classList.add) {
      article.classList.add('history-card');
    } else {
      article.className = 'history-card';
    }

    // Assign individual dataset fields (never assign to article.dataset getter)
    article.dataset.status = booking.status || '';
    article.dataset.id = booking.id || '';

    // ── Header container
    const headerDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (headerDiv.classList && headerDiv.classList.add) headerDiv.classList.add('history-card__header');
    else headerDiv.className = 'history-card__header';

    const titleRow = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (titleRow.classList && titleRow.classList.add) titleRow.classList.add('history-card__title-row');
    else titleRow.className = 'history-card__title-row';

    const slotSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (slotSpan.classList && slotSpan.classList.add) slotSpan.classList.add('history-card__slot-id');
    else slotSpan.className = 'history-card__slot-id';
    slotSpan.textContent = `Slot ${booking.slotCode || '—'}`;
    titleRow.appendChild(slotSpan);

    const locSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (locSpan.classList && locSpan.classList.add) locSpan.classList.add('history-card__location');
    else locSpan.className = 'history-card__location';
    locSpan.textContent = booking.locationName || 'Facility';
    titleRow.appendChild(locSpan);

    headerDiv.appendChild(titleRow);

    const badgeSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (badgeSpan.classList && badgeSpan.classList.add) badgeSpan.classList.add('status-badge', statusClass);
    else badgeSpan.className = `status-badge ${statusClass}`;
    badgeSpan.textContent = safeCapitalise(booking.status);
    headerDiv.appendChild(badgeSpan);

    const dateP = typeof document !== 'undefined' ? document.createElement('p') : {};
    if (dateP.classList && dateP.classList.add) dateP.classList.add('history-card__date');
    else dateP.className = 'history-card__date';
    dateP.textContent = safeFormatDateTime(booking.createdAt);
    headerDiv.appendChild(dateP);

    article.appendChild(headerDiv);

    // ── Meta items container
    const metaDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (metaDiv.classList && metaDiv.classList.add) metaDiv.classList.add('history-card__meta');
    else metaDiv.className = 'history-card__meta';

    // Vehicle type
    const metaType = typeof document !== 'undefined' ? document.createElement('span') : { appendChild: () => {} };
    if (metaType.classList && metaType.classList.add) metaType.classList.add('history-card__meta-item');
    else metaType.className = 'history-card__meta-item';
    const iconSpan = typeof document !== 'undefined' ? document.createElement('span') : { setAttribute: () => {} };
    if (typeof iconSpan.setAttribute === 'function') iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M9 17V7h4a3 3 0 0 1 0 6H9"></path></svg>';
    metaType.appendChild(iconSpan);
    const strongType = typeof document !== 'undefined' ? document.createElement('strong') : {};
    strongType.textContent = ` ${safeGetVehicleTypeLabel(vehicleType)}`;
    metaType.appendChild(strongType);
    metaDiv.appendChild(metaType);

    // Registration number
    const metaReg = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (metaReg.classList && metaReg.classList.add) metaReg.classList.add('history-card__meta-item');
    else metaReg.className = 'history-card__meta-item';
    metaReg.textContent = `Reg: ${vehicleReg}`;
    metaDiv.appendChild(metaReg);

    // Duration
    const metaDur = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (metaDur.classList && metaDur.classList.add) metaDur.classList.add('history-card__meta-item');
    else metaDur.className = 'history-card__meta-item';
    metaDur.textContent = `Duration: ${safeFormatDuration(booking.durationHours)}`;
    metaDiv.appendChild(metaDur);

    // From
    const metaFrom = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (metaFrom.classList && metaFrom.classList.add) metaFrom.classList.add('history-card__meta-item');
    else metaFrom.className = 'history-card__meta-item';
    metaFrom.textContent = `From: ${safeFormatTime(booking.startTime)}`;
    metaDiv.appendChild(metaFrom);

    // Until
    const metaUntil = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (metaUntil.classList && metaUntil.classList.add) metaUntil.classList.add('history-card__meta-item');
    else metaUntil.className = 'history-card__meta-item';
    metaUntil.textContent = `Until: ${safeFormatTime(booking.endTime)}`;
    metaDiv.appendChild(metaUntil);

    article.appendChild(metaDiv);

    // ── Countdown if active
    if (isActive) {
      const countdownDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {}, setAttribute: () => {} };
      if (countdownDiv.classList && countdownDiv.classList.add) countdownDiv.classList.add('history-card__countdown');
      else countdownDiv.className = 'history-card__countdown';
      if (typeof countdownDiv.setAttribute === 'function') {
        countdownDiv.setAttribute('data-countdown-end', booking.endTime || '');
        countdownDiv.setAttribute('aria-live', 'polite');
      }
      countdownDiv.textContent = '';
      const timerIcon = typeof document !== 'undefined' ? document.createElement('span') : { setAttribute: () => {} };
      if (typeof timerIcon.setAttribute === 'function') timerIcon.setAttribute('aria-hidden', 'true');
      timerIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ';
      countdownDiv.appendChild(timerIcon);
      const countdownSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
      if (countdownSpan.classList && countdownSpan.classList.add) countdownSpan.classList.add('countdown-text');
      else countdownSpan.className = 'countdown-text';
      countdownSpan.textContent = formatRemainingTime(remMs);
      countdownDiv.appendChild(countdownSpan);
      article.appendChild(countdownDiv);
    }

    // ── Footer container
    const footerDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (footerDiv.classList && footerDiv.classList.add) footerDiv.classList.add('history-card__footer');
    else footerDiv.className = 'history-card__footer';

    const costP = typeof document !== 'undefined' ? document.createElement('p') : { setAttribute: () => {} };
    if (costP.classList && costP.classList.add) costP.classList.add('history-card__cost');
    else costP.className = 'history-card__cost';
    if (isCancelled && typeof costP.setAttribute === 'function') {
      costP.setAttribute('aria-label', 'Cancelled booking amount');
    }
    costP.textContent = formatPaise(booking.totalPaise);
    footerDiv.appendChild(costP);

    if (isActive) {
      const actionBtn = typeof document !== 'undefined'
        ? document.createElement('button')
        : { dataset: {}, setAttribute: () => {} };
      actionBtn.type = 'button';

      if (confirmedCancellations.has(booking.id)) {
        if (actionBtn.classList && actionBtn.classList.add) actionBtn.classList.add('btn-refresh-card');
        else actionBtn.className = 'btn-refresh-card';
        actionBtn.dataset.action = 'refresh';
        actionBtn.textContent = 'Refresh List';
        if (typeof actionBtn.setAttribute === 'function') {
          actionBtn.setAttribute('aria-label', 'Refresh booking history list');
        }
        actionBtn.onclick = (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
          loadHistory({ silent: false });
        };
      } else if (pendingCancellations.has(booking.id)) {
        if (actionBtn.classList && actionBtn.classList.add) actionBtn.classList.add('btn-cancel');
        else actionBtn.className = 'btn-cancel';
        actionBtn.dataset.bookingId = booking.id || '';
        actionBtn.dataset.slotCode = booking.slotCode || '';
        actionBtn.dataset.locationName = booking.locationName || '';
        actionBtn.disabled = true;
        actionBtn.textContent = 'Cancelling…';
        if (typeof actionBtn.setAttribute === 'function') {
          actionBtn.setAttribute('aria-label', `Cancel booking for slot ${booking.slotCode || ''}`);
        }
      } else {
        if (actionBtn.classList && actionBtn.classList.add) actionBtn.classList.add('btn-cancel');
        else actionBtn.className = 'btn-cancel';
        actionBtn.dataset.bookingId = booking.id || '';
        actionBtn.dataset.slotCode = booking.slotCode || '';
        actionBtn.dataset.locationName = booking.locationName || '';
        actionBtn.textContent = 'Cancel';
        if (typeof actionBtn.setAttribute === 'function') {
          actionBtn.setAttribute('aria-label', `Cancel booking for slot ${booking.slotCode || ''}`);
        }
      }

      footerDiv.appendChild(actionBtn);
    }

    article.appendChild(footerDiv);

    return article;
  };

  // ── Render History List ────────────────────────────────────
  const renderHistoryList = (bookings, total, page, limit) => {
    activeBookingsData = bookings.filter((b) => b.status === 'active');
    totalRecords = total;
    totalPages = Math.max(1, Math.ceil(total / limit));
    currentPage = Number(page) || 1;

    const historyListEl = safeGetElement('history-list');
    const emptyStateEl = safeGetElement('history-empty-state');
    const resultsCountEl = safeGetElement('results-count');
    const paginationEl = safeGetElement('history-pagination');
    const pageInfoEl = safeGetElement('history-page-info');
    const prevBtn = safeGetElement('history-prev-btn');
    const nextBtn = safeGetElement('history-next-btn');

    if (!historyListEl) return;

    // Results count line
    if (resultsCountEl) {
      if (total === 0) {
        resultsCountEl.textContent = '';
      } else {
        resultsCountEl.textContent = `${total} booking${total !== 1 ? 's' : ''} found`;
      }
    }

    // Remove existing cards
    const existingCards = historyListEl.querySelectorAll('.history-card');
    existingCards.forEach((c) => c.remove());

    if (total === 0) {
      if (emptyStateEl) emptyStateEl.removeAttribute('hidden');
      if (paginationEl) paginationEl.classList.add('hidden');
      return;
    }

    if (emptyStateEl) emptyStateEl.setAttribute('hidden', '');

    // Render cards
    bookings.forEach((booking) => {
      historyListEl.appendChild(createHistoryCard(booking));
    });

    // Update pagination controls
    if (paginationEl) {
      paginationEl.classList.remove('hidden');
    }
    if (pageInfoEl) {
      pageInfoEl.textContent = totalPages > 1
        ? `Page ${currentPage} of ${totalPages}`
        : 'Page 1 of 1';
    }
    if (prevBtn) {
      const isPrevDisabled = currentPage <= 1;
      prevBtn.disabled = isPrevDisabled;
      prevBtn.setAttribute('aria-disabled', String(isPrevDisabled));
    }
    if (nextBtn) {
      const isNextDisabled = currentPage >= totalPages;
      nextBtn.disabled = isNextDisabled;
      nextBtn.setAttribute('aria-disabled', String(isNextDisabled));
    }

    updateCountdowns();
  };

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      currentPage++;
      return loadHistory({ silent: false });
    }
    return Promise.resolve();
  };

  const goToPrevPage = () => {
    if (currentPage > 1) {
      currentPage--;
      return loadHistory({ silent: false });
    }
    return Promise.resolve();
  };

  // ── Data Fetching ──────────────────────────────────────────
  const loadHistory = async ({ silent = false, rethrow = false } = {}) => {
    if (isDisposed || isSuspended) return;
    if (silent && typeof document !== 'undefined' && document.hidden) return;

    const currentSeq = ++requestSeq;
    activeRequestSeq = currentSeq;
    isRefreshing = true;

    const loadingEl = safeGetElement('history-loading');
    const errorEl = safeGetElement('history-error');
    const emptyStateEl = safeGetElement('history-empty-state');
    const paginationEl = safeGetElement('history-pagination');

    if (!silent) {
      if (loadingEl) loadingEl.classList.remove('hidden');
      if (errorEl) errorEl.classList.add('hidden');
      if (emptyStateEl) emptyStateEl.setAttribute('hidden', '');
    }

    try {
      const client = typeof ApiClient !== 'undefined' ? ApiClient : (typeof global !== 'undefined' ? global.ApiClient : null);
      if (!client) throw new Error('ApiClient is unavailable');

      const params = new URLSearchParams();
      params.set('page', String(currentPage));
      params.set('limit', String(pageLimit));
      params.set('sort', sortOrder);

      if (activeStatus !== 'all') {
        params.set('status', activeStatus);
      }
      if (searchQuery.trim()) {
        params.set('search', searchQuery.trim());
      }

      const res = await client.get(`/api/bookings/me?${params.toString()}`);

      if (currentSeq !== requestSeq || isDisposed || isSuspended) {
        return; // Discard stale or disposed response
      }

      if (res.serverTime) {
        serverClockOffsetMs = new Date(res.serverTime).getTime() - Date.now();
      }

      const total = res.total || 0;
      const limit = res.limit || pageLimit;
      const maxPage = Math.max(1, Math.ceil(total / limit));

      // If history's current page becomes invalid after cancellation/filter changes,
      // move to a valid page and refetch instead of showing "Page 2 of 1"
      // Note: pass rethrow through so failures reach the caller recovery handler
      if (currentPage > maxPage) {
        currentPage = maxPage;
        return loadHistory({ silent, rethrow });
      }

      // Update stat cards and tab counts from all-time counts breakdown
      if (res.counts) {
        safeSetText('stat-total', res.counts.total);
        safeSetText('stat-active', res.counts.active);
        safeSetText('stat-completed', res.counts.completed);
        safeSetText('stat-cancelled', res.counts.cancelled);

        safeSetText('tab-count-all', res.counts.total);
        safeSetText('tab-count-active', res.counts.active);
        safeSetText('tab-count-completed', res.counts.completed);
        safeSetText('tab-count-cancelled', res.counts.cancelled);
      }

      // Clear any previous error banner on successful refresh, even if silent
      if (errorEl) errorEl.classList.add('hidden');
      if (loadingEl) loadingEl.classList.add('hidden');

      renderHistoryList(res.bookings || [], total, res.page || currentPage, limit);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (currentSeq !== requestSeq || isDisposed || isSuspended) return;

      if (!silent) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errorEl) {
          errorEl.classList.remove('hidden');
          const msgEl = safeGetElement('history-error-msg');
          if (msgEl) msgEl.textContent = err.message || 'Failed to load booking history.';
        }
        if (paginationEl) paginationEl.classList.add('hidden');
      }
      safeShowToast(err.message || 'Failed to load booking history.', 'error');
      if (rethrow) throw err;
    } finally {
      if (activeRequestSeq === currentSeq) {
        isRefreshing = false;
      }
    }
  };

  // ── Cancellation Handler ───────────────────────────────────
  const handleCancelBooking = async (bookingId, slotCode, locationName, btn) => {
    if (pendingCancellations.has(bookingId) || confirmedCancellations.has(bookingId)) return;

    const locLabel = locationName || 'Parking Facility';
    const slotLabel = slotCode ? `Slot ${slotCode}` : 'your slot';

    const win = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global.window : null);
    const confirmed = win && typeof win.confirm === 'function'
      ? win.confirm(`Are you sure you want to cancel the booking for ${locLabel} (${slotLabel})?\nThis cannot be undone.`)
      : true;
    if (!confirmed) return;

    pendingCancellations.add(bookingId);
    const originalText = btn ? btn.textContent : 'Cancel';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Cancelling…';
    }

    try {
      const client = typeof ApiClient !== 'undefined' ? ApiClient : (typeof global !== 'undefined' ? global.ApiClient : null);
      if (!client) throw new Error('ApiClient is unavailable');

      const res = await client.patch(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`);

      pendingCancellations.delete(bookingId);
      confirmedCancellations.add(bookingId);

      if (res.serverTime) {
        serverClockOffsetMs = new Date(res.serverTime).getTime() - Date.now();
      }

      const returnedStatus = res.booking?.status;
      if (returnedStatus === 'cancelled') {
        safeShowToast(`Booking for ${slotLabel} has been cancelled.`, 'success');
      } else if (returnedStatus === 'completed') {
        safeShowToast(`Booking for ${slotLabel} had already expired and is now marked completed.`, 'info');
      } else {
        safeShowToast(`Booking status updated to ${returnedStatus || 'processed'}.`, 'info');
      }

      try {
        await loadHistory({ silent: true, rethrow: true });
      } catch (refreshErr) {
        // Confirmed cancelled on backend, but refresh GET failed.
        // Convert button into a refresh-only control (never sends another PATCH)
        if (btn) {
          btn.disabled = false;
          if (btn.classList && btn.classList.remove) {
            btn.classList.remove('btn-cancel');
            btn.classList.add('btn-refresh-card');
          } else {
            btn.className = 'btn-refresh-card';
          }
          btn.dataset.action = 'refresh';
          delete btn.dataset.bookingId;
          if (typeof btn.removeAttribute === 'function') {
            btn.removeAttribute('data-booking-id');
          }
          btn.textContent = 'Refresh List';
          if (typeof btn.setAttribute === 'function') {
            btn.setAttribute('aria-label', 'Refresh booking history list');
          }
          btn.onclick = (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            loadHistory({ silent: false });
          };
        }
        safeShowToast('Cancellation confirmed, but the list could not refresh. Please click Refresh.', 'warning');
      }
    } catch (err) {
      pendingCancellations.delete(bookingId);
      if (handleAuthError(err)) return;

      const isNetworkError = Boolean(
        err && (err.isNetwork || err.code === 'NETWORK_ERROR' || err.status === 0 || err.name === 'TypeError')
      );

      if (isNetworkError) {
        safeShowToast(
          'Cancellation outcome is not yet confirmed. Refresh to check before trying again.',
          'warning'
        );
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry Cancellation';
        }
      } else {
        safeShowToast(err.message || 'Failed to cancel booking.', 'error');
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }
    }
  };

  // ── Status Tabs ────────────────────────────────────────────
  const activateStatusTab = (tab) => {
    const allTabs = ['tab-all', 'tab-active', 'tab-completed', 'tab-cancelled']
      .map((id) => safeGetElement(id))
      .filter(Boolean);

    allTabs.forEach((t) => t.setAttribute('aria-pressed', t === tab ? 'true' : 'false'));
    activeStatus = tab.dataset?.status ?? 'all';
    currentPage = 1; // Reset to page 1 on filter change
    loadHistory({ silent: false });
  };

  // ── Permanent Teardown & Auth Cleanup ──────────────────────
  const cleanup = () => {
    isDisposed = true;
    suspendPage();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    }
    isInitialized = false;
  };

  // ── Initialisation ─────────────────────────────────────────
  const initHistoryPage = async () => {
    const initialLoadingEl = safeGetElement('history-initial-loading');
    const mainContentEl = safeGetElement('main-content');

    let user = null;
    if (typeof requireAuth === 'function') {
      user = await requireAuth();
    }
    if (!user) return;

    // Smoothly reveal protected content once user is verified
    if (initialLoadingEl) {
      initialLoadingEl.classList.add('hidden');
    }
    if (mainContentEl) {
      mainContentEl.classList.remove('hidden');
    }

    isDisposed = false;
    isSuspended = false;
    populateUserInfo();

    // Event listener: logout
    const logoutBtn = safeGetElement('btn-logout');
    if (logoutBtn && typeof logoutUser === 'function') logoutBtn.addEventListener('click', logoutUser);

    // Event listener: status tabs
    const allTabs = ['tab-all', 'tab-active', 'tab-completed', 'tab-cancelled']
      .map((id) => safeGetElement(id))
      .filter(Boolean);
    allTabs.forEach((tab) => {
      tab.addEventListener('click', () => activateStatusTab(tab));
    });

    // Event listener: search (debounced 300ms)
    const searchInputEl = safeGetElement('search-input');
    if (searchInputEl) {
      searchInputEl.addEventListener(
        'input',
        debounce((event) => {
          searchQuery = event.target.value;
          currentPage = 1; // Reset to page 1 on search change
          loadHistory({ silent: false });
        }, 300)
      );
    }

    // Event listener: sort select
    const sortSelectEl = safeGetElement('sort-select');
    if (sortSelectEl) {
      sortSelectEl.addEventListener('change', (event) => {
        sortOrder = event.target.value;
        currentPage = 1; // Reset to page 1 on sort change
        loadHistory({ silent: false });
      });
    }

    // Event delegation on history list: distinct routing for refresh vs cancel
    const listEl = safeGetElement('history-list');
    if (listEl) {
      listEl.addEventListener('click', (event) => {
        // 1. Refresh action: sends GET only, never triggers cancel or PATCH
        const refreshBtn = event.target.closest ? event.target.closest('.btn-refresh-card, [data-action="refresh"]') : null;
        if (refreshBtn) {
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          loadHistory({ silent: false });
          return;
        }

        // 2. Cancellation action
        const cancelBtn = event.target.closest ? event.target.closest('.btn-cancel') : null;
        if (!cancelBtn || cancelBtn.disabled) return;

        // Guard: if this button was converted to a refresh action or has no bookingId, ignore
        if (cancelBtn.classList.contains('btn-refresh-card') || cancelBtn.dataset.action === 'refresh') {
          return;
        }

        const bookingId = cancelBtn.dataset.bookingId;
        if (!bookingId || confirmedCancellations.has(bookingId)) {
          return;
        }

        const slotCode = cancelBtn.dataset.slotCode;
        const locationName = cancelBtn.dataset.locationName;
        handleCancelBooking(bookingId, slotCode, locationName, cancelBtn);
      });
    }

    // Event listener: pagination buttons
    const prevBtn = safeGetElement('history-prev-btn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        goToPrevPage();
      });
    }

    const nextBtn = safeGetElement('history-next-btn');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        goToNextPage();
      });
    }

    // Event listener: retry button
    const retryBtn = safeGetElement('btn-retry-history');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        loadHistory({ silent: false });
      });
    }

    // Lifecycle events: register only once to avoid duplicate listeners
    if (!isInitialized) {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('pageshow', handlePageShow);
      }
      isInitialized = true;
    }

    // Initial load
    await loadHistory({ silent: false });
    startCountdownTimer();
    startPolling();
  };

  const HistoryApp = {
    loadHistory,
    goToNextPage,
    goToPrevPage,
    handleCancelBooking,
    calculateRemainingMs,
    formatRemainingTime,
    setServerClockOffset: (offset) => { serverClockOffsetMs = offset; },
    getServerClockOffset: () => serverClockOffsetMs,
    getRequestSeq: () => requestSeq,
    getActiveBookings: () => [...activeBookingsData],
    getCurrentPage: () => currentPage,
    setCurrentPage: (p) => { currentPage = p; },
    getTotalPages: () => totalPages,
    getTotalRecords: () => totalRecords,
    getActiveStatus: () => activeStatus,
    setActiveStatus: (s) => { activeStatus = s; },
    getSearchQuery: () => searchQuery,
    setSearchQuery: (q) => { searchQuery = q; },
    getSortOrder: () => sortOrder,
    setSortOrder: (s) => { sortOrder = s; },
    createHistoryCard,
    renderHistoryList,
    activateStatusTab,
    cleanup,
    suspendPage,
    resumePage,
    handlePageHide,
    handlePageShow,
    initHistoryPage,
    getPendingCancellations: () => pendingCancellations,
    getConfirmedCancellations: () => confirmedCancellations,
    isDisposed: () => isDisposed,
    isSuspended: () => isSuspended,
    resetDisposed: () => { isDisposed = false; isSuspended = false; },
  };

  if (typeof window !== 'undefined') {
    window.__historyApp = HistoryApp;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initHistoryPage);
    } else {
      initHistoryPage();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      HistoryApp,
      formatPaise,
      calculateRemainingMs,
      formatRemainingTime,
      getVehicleIcon,
      createHistoryCard,
    };
  }
})();
