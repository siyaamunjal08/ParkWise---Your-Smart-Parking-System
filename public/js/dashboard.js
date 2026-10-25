// Dashboard Module — Real Backend Migration & Live Countdown (Stage 11A)
/* ============================================================
   public/js/dashboard.js
   ParkWise — Dashboard Page Controller

   PURPOSE:
   Owns all DOM interaction for dashboard.html using real backend APIs.
   Displays user booking counts covering full booking history, renders
   real active booking cards with server-clock synchronized live
   countdowns, handles real atomic cancellations, and manages 30s
   background polling with visibility & page lifecycle safeguards.

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
  let serverClockOffsetMs = 0;
  let requestSeq = 0;
  let activeRequestSeq = 0;
  let countdownTimerId = null;
  let pollTimerId = null;
  let isRefreshing = false;
  let isSuspended = false;
  let isDisposed = false;
  let isInitialized = false;
  let lastZeroRefreshTime = 0;
  let activeBookingsData = [];
  let savedVehiclesData = [];
  let isVehicleSubmitting = false;
  let isVehiclesLoading = false;
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

  const getFirstName = (fullName) => {
    return fullName ? fullName.trim().split(' ')[0] : 'there';
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
    const countdownEls = document.querySelectorAll('#active-bookings-list [data-countdown-end]');
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
        loadDashboardData({ silent: true });
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
        loadDashboardData({ silent: true });
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
        loadDashboardData({ silent: true });
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
        loadDashboardData({ silent: true });
      }
    }
  };

  const handlePageHide = () => {
    suspendPage();
  };

  const handlePageShow = (event) => {
    resumePage(event);
  };

  // ── User Info & Nav ────────────────────────────────────────
  const populateUserInfo = () => {
    if (typeof getSession !== 'function') return;
    const session = getSession();
    if (!session) return;

    const firstName = getFirstName(session.name);
    const roleSuffix = session.role === 'admin' ? ' (Admin)' : '';

    safeSetText('header-user-name', `Hi, ${firstName}${roleSuffix}`);
    safeSetText('welcome-name', `${firstName}${roleSuffix}`);
    if (session.loginAt) {
      safeSetText('welcome-meta', `Last login: ${safeFormatDateTime(session.loginAt)}`);
    }

    if (session.role === 'admin') {
      const adminNav = safeGetElement('nav-admin-link');
      if (adminNav) adminNav.classList.remove('hidden');
    }
  };

  // ── Safe Card Builder (DOM Construction) ───────────────────
  const createBookingCard = (booking) => {
    const remMs = calculateRemainingMs(booking.endTime);
    const statusClass = safeGetStatusClass(booking.status);
    const vehicleType = booking.vehicle?.type || 'car';
    const vehicleReg = booking.vehicle?.registrationNumber || '—';

    const article = typeof document !== 'undefined'
      ? document.createElement('article')
      : { className: '', dataset: {}, appendChild: () => {} };

    if (article.classList && article.classList.add) {
      article.classList.add('booking-card');
    } else {
      article.className = 'booking-card';
    }

    // Assign individual dataset fields (never assign to article.dataset getter)
    article.dataset.status = booking.status || '';
    article.dataset.id = booking.id || '';

    // ── Info container
    const infoDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (infoDiv.classList && infoDiv.classList.add) infoDiv.classList.add('booking-card__info');
    else infoDiv.className = 'booking-card__info';

    // Location name
    const locDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (locDiv.classList && locDiv.classList.add) locDiv.classList.add('booking-card__location');
    else locDiv.className = 'booking-card__location';
    locDiv.textContent = booking.locationName || 'Parking Facility';
    infoDiv.appendChild(locDiv);

    // Slot code
    const slotP = typeof document !== 'undefined' ? document.createElement('p') : { appendChild: () => {} };
    if (slotP.classList && slotP.classList.add) slotP.classList.add('booking-card__slot');
    else slotP.className = 'booking-card__slot';
    slotP.textContent = `Slot ${booking.slotCode || '—'}`;
    infoDiv.appendChild(slotP);

    // Meta items container
    const metaDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (metaDiv.classList && metaDiv.classList.add) metaDiv.classList.add('booking-card__meta');
    else metaDiv.className = 'booking-card__meta';

    // Vehicle span
    const spanVehicle = typeof document !== 'undefined' ? document.createElement('span') : { appendChild: () => {} };
    spanVehicle.textContent = `${safeGetVehicleTypeLabel(vehicleType)}: `;
    const strongReg = typeof document !== 'undefined' ? document.createElement('strong') : {};
    strongReg.textContent = vehicleReg;
    spanVehicle.appendChild(strongReg);
    metaDiv.appendChild(spanVehicle);

    // Duration span
    const spanDuration = typeof document !== 'undefined' ? document.createElement('span') : {};
    spanDuration.textContent = `Duration: ${safeFormatDuration(booking.durationHours)}`;
    metaDiv.appendChild(spanDuration);

    // From span
    const spanFrom = typeof document !== 'undefined' ? document.createElement('span') : {};
    spanFrom.textContent = `From: ${safeFormatTime(booking.startTime)}`;
    metaDiv.appendChild(spanFrom);

    // Until span
    const spanUntil = typeof document !== 'undefined' ? document.createElement('span') : {};
    spanUntil.textContent = `Until: ${safeFormatTime(booking.endTime)}`;
    metaDiv.appendChild(spanUntil);

    infoDiv.appendChild(metaDiv);

    // Countdown container
    const countdownDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {}, setAttribute: () => {} };
    if (countdownDiv.classList && countdownDiv.classList.add) countdownDiv.classList.add('booking-card__countdown');
    else countdownDiv.className = 'booking-card__countdown';
    if (typeof countdownDiv.setAttribute === 'function') {
      countdownDiv.setAttribute('data-countdown-end', booking.endTime || '');
      countdownDiv.setAttribute('aria-live', 'polite');
    }
    const timerIcon = typeof document !== 'undefined' ? document.createElement('span') : { setAttribute: () => {} };
    if (typeof timerIcon.setAttribute === 'function') timerIcon.setAttribute('aria-hidden', 'true');
    timerIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ';
    countdownDiv.appendChild(timerIcon);
    const countdownSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (countdownSpan.classList && countdownSpan.classList.add) countdownSpan.classList.add('countdown-text');
    else countdownSpan.className = 'countdown-text';
    countdownSpan.textContent = formatRemainingTime(remMs);
    countdownDiv.appendChild(countdownSpan);
    infoDiv.appendChild(countdownDiv);

    // Cost
    const costP = typeof document !== 'undefined' ? document.createElement('p') : {};
    if (costP.classList && costP.classList.add) costP.classList.add('booking-card__cost');
    else costP.className = 'booking-card__cost';
    costP.textContent = formatPaise(booking.totalPaise);
    infoDiv.appendChild(costP);

    article.appendChild(infoDiv);

    // ── Actions container
    const actionsDiv = typeof document !== 'undefined' ? document.createElement('div') : { appendChild: () => {} };
    if (actionsDiv.classList && actionsDiv.classList.add) actionsDiv.classList.add('booking-card__actions');
    else actionsDiv.className = 'booking-card__actions';

    // Status badge
    const badgeSpan = typeof document !== 'undefined' ? document.createElement('span') : {};
    if (badgeSpan.classList && badgeSpan.classList.add) badgeSpan.classList.add('status-badge', statusClass);
    else badgeSpan.className = `status-badge ${statusClass}`;
    badgeSpan.textContent = safeCapitalise(booking.status);
    actionsDiv.appendChild(badgeSpan);

    // Action button: Cancel button or Refresh-only button
    const actionBtn = typeof document !== 'undefined'
      ? document.createElement('button')
      : { dataset: {}, setAttribute: () => {} };
    actionBtn.type = 'button';

    if (confirmedCancellations.has(booking.id)) {
      // Confirmed cancelled: provide Refresh List button only (no cancel class, no booking ID)
      if (actionBtn.classList && actionBtn.classList.add) actionBtn.classList.add('btn-refresh-card');
      else actionBtn.className = 'btn-refresh-card';
      actionBtn.dataset.action = 'refresh';
      actionBtn.textContent = 'Refresh List';
      if (typeof actionBtn.setAttribute === 'function') {
        actionBtn.setAttribute('aria-label', 'Refresh active bookings list');
      }
      actionBtn.onclick = (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        loadDashboardData({ silent: false });
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

    actionsDiv.appendChild(actionBtn);
    article.appendChild(actionsDiv);

    return article;
  };

  // ── Render Active Bookings ─────────────────────────────────
  const renderActiveBookings = (bookings, totalActiveCount) => {
    activeBookingsData = bookings;
    const listEl = safeGetElement('active-bookings-list');
    const emptyMsg = safeGetElement('no-bookings-msg');
    const previewNoticeEl = safeGetElement('dashboard-preview-notice');
    const previewTextEl = safeGetElement('dashboard-preview-text');

    const totalActive = typeof totalActiveCount === 'number' ? totalActiveCount : bookings.length;
    safeSetText('active-bookings-count', totalActive);

    if (!listEl) return;

    // Remove any previously rendered cards
    const existingCards = listEl.querySelectorAll('.booking-card');
    existingCards.forEach((c) => c.remove());

    if (bookings.length === 0) {
      if (emptyMsg) emptyMsg.removeAttribute('hidden');
      if (previewNoticeEl) previewNoticeEl.classList.add('hidden');
      return;
    }

    if (emptyMsg) emptyMsg.setAttribute('hidden', '');

    bookings.forEach((booking) => {
      listEl.appendChild(createBookingCard(booking));
    });

    // Handle limited preview notice if active bookings exceed fetched limit
    if (previewNoticeEl) {
      if (totalActive > bookings.length) {
        previewNoticeEl.classList.remove('hidden');
        if (previewTextEl) {
          previewTextEl.textContent = `Showing latest ${bookings.length} of ${totalActive} active bookings.`;
        }
      } else {
        previewNoticeEl.classList.add('hidden');
      }
    }

    updateCountdowns();
  };

  // ── Data Fetching ──────────────────────────────────────────
  const loadDashboardData = async ({ silent = false, rethrow = false } = {}) => {
    if (isDisposed || isSuspended) return;
    if (silent && typeof document !== 'undefined' && document.hidden) return;

    const currentSeq = ++requestSeq;
    activeRequestSeq = currentSeq;
    isRefreshing = true;

    const loadingEl = safeGetElement('dashboard-loading');
    const errorEl = safeGetElement('dashboard-error');
    const emptyMsg = safeGetElement('no-bookings-msg');

    if (!silent) {
      if (loadingEl) loadingEl.classList.remove('hidden');
      if (errorEl) errorEl.classList.add('hidden');
      if (emptyMsg) emptyMsg.setAttribute('hidden', '');
    }

    try {
      const client = typeof ApiClient !== 'undefined' ? ApiClient : (typeof global !== 'undefined' ? global.ApiClient : null);
      if (!client) throw new Error('ApiClient is unavailable');

      const res = await client.get('/api/bookings/me?status=active&limit=50');

      if (currentSeq !== requestSeq || isDisposed || isSuspended) {
        return; // Stale or disposed response discarded
      }

      if (res.serverTime) {
        serverClockOffsetMs = new Date(res.serverTime).getTime() - Date.now();
      }

      // Update stat cards across full history
      let totalActive = 0;
      if (res.counts) {
        safeSetText('stat-total-bookings', res.counts.total);
        safeSetText('stat-active-bookings', res.counts.active);
        safeSetText('stat-completed-bookings', res.counts.completed);
        safeSetText('stat-cancelled-bookings', res.counts.cancelled);
        totalActive = res.counts.active;
      } else {
        totalActive = res.total || 0;
        safeSetText('stat-active-bookings', totalActive);
      }

      // Clear any previous error banner on successful refresh, even if silent
      if (errorEl) errorEl.classList.add('hidden');
      if (loadingEl) loadingEl.classList.add('hidden');

      renderActiveBookings(res.bookings || [], totalActive);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (currentSeq !== requestSeq || isDisposed || isSuspended) return;

      if (!silent) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errorEl) {
          errorEl.classList.remove('hidden');
          const msgEl = safeGetElement('dashboard-error-msg');
          if (msgEl) msgEl.textContent = err.message || 'Failed to load active bookings.';
        }
      }
      safeShowToast(err.message || 'Could not refresh dashboard data.', 'error');
      if (rethrow) throw err;
    } finally {
      if (activeRequestSeq === currentSeq) {
        isRefreshing = false;
      }
    }
  };

  // ── Real Cancellation Handler ──────────────────────────────
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
        await loadDashboardData({ silent: true, rethrow: true });
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
            btn.setAttribute('aria-label', 'Refresh active bookings list');
          }
          btn.onclick = (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            loadDashboardData({ silent: false });
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

  // ── Vehicle Management (Stage 11B) ─────────────────────────
  const createVehicleCard = (vehicle) => {
    const card = document.createElement('article');
    card.className = 'vehicle-card';
    card.dataset.vehicleId = vehicle.id;

    // Type badge
    const typeBadge = document.createElement('div');
    const type = (vehicle.type || 'car').toLowerCase();
    typeBadge.className = `vehicle-card__type vehicle-card__type--${type}`;
    typeBadge.textContent = type.toUpperCase();
    card.appendChild(typeBadge);

    // Info container
    const info = document.createElement('div');
    info.className = 'vehicle-card__info';

    const reg = document.createElement('p');
    reg.className = 'vehicle-card__reg';
    reg.textContent = vehicle.registrationNumber || '—';
    info.appendChild(reg);

    const label = document.createElement('p');
    label.className = 'vehicle-card__label';
    label.textContent = vehicle.label ? vehicle.label : `${type.toUpperCase()} Vehicle`;
    info.appendChild(label);

    card.appendChild(info);

    // Actions container
    const actions = document.createElement('div');
    actions.className = 'vehicle-card__actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-sm btn-outline btn-edit-vehicle btn-vehicle-action';
    editBtn.dataset.vehicleId = vehicle.id;
    editBtn.textContent = 'Edit';
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-sm btn-danger btn-delete-vehicle btn-vehicle-action';
    deleteBtn.dataset.vehicleId = vehicle.id;
    deleteBtn.dataset.vehicleReg = vehicle.registrationNumber || '';
    deleteBtn.textContent = 'Delete';
    actions.appendChild(deleteBtn);

    card.appendChild(actions);

    return card;
  };

  const renderVehiclesList = (vehicles) => {
    const listEl = safeGetElement('vehicles-list');
    const emptyEl = safeGetElement('no-vehicles-msg');
    const countEl = safeGetElement('vehicles-count');

    if (countEl) {
      countEl.textContent = String(Array.isArray(vehicles) ? vehicles.length : 0);
    }

    if (!listEl) return;

    // Remove old vehicle cards, keep loading, error, empty state elements intact
    const existingCards = listEl.querySelectorAll('.vehicle-card');
    existingCards.forEach((card) => card.remove());

    if (!vehicles || vehicles.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    vehicles.forEach((vehicle) => {
      const card = createVehicleCard(vehicle);
      listEl.appendChild(card);
    });
  };

  const loadVehicles = async ({ silent = false } = {}) => {
    const loadingEl = safeGetElement('vehicles-loading');
    const errorEl = safeGetElement('vehicles-error');
    const errorMsgEl = safeGetElement('vehicles-error-msg');
    const emptyEl = safeGetElement('no-vehicles-msg');

    if (!silent) {
      if (loadingEl) loadingEl.classList.remove('hidden');
      if (errorEl) errorEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.add('hidden');
    }

    isVehiclesLoading = true;

    try {
      const res = await ApiClient.get('/api/vehicles/me');
      if (res && res.success) {
        savedVehiclesData = Array.isArray(res.vehicles) ? res.vehicles : [];
        if (errorEl) errorEl.classList.add('hidden');
        renderVehiclesList(savedVehiclesData);
      } else {
        throw new Error(res?.message || 'Failed to retrieve saved vehicles.');
      }
    } catch (err) {
      if (!silent) {
        if (errorEl) errorEl.classList.remove('hidden');
        if (errorMsgEl) errorMsgEl.textContent = err.message || 'Failed to load vehicles.';
      }
    } finally {
      isVehiclesLoading = false;
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  };

  const openVehicleModal = (mode = 'add', vehicle = null) => {
    const modal = safeGetElement('vehicle-modal');
    const title = safeGetElement('vehicle-modal-title');
    const editIdInput = safeGetElement('vehicle-edit-id');
    const regInput = safeGetElement('vehicle-input-reg');
    const typeInput = safeGetElement('vehicle-input-type');
    const labelInput = safeGetElement('vehicle-input-label');
    const banner = safeGetElement('vehicle-form-error-banner');
    const regError = safeGetElement('vehicle-reg-error');
    const typeError = safeGetElement('vehicle-type-error');
    const labelError = safeGetElement('vehicle-label-error');

    // Reset error banners
    if (banner) {
      banner.textContent = '';
      banner.classList.add('hidden');
    }
    if (regError) {
      regError.textContent = '';
      regError.classList.add('hidden');
    }
    if (typeError) {
      typeError.textContent = '';
      typeError.classList.add('hidden');
    }
    if (labelError) {
      labelError.textContent = '';
      labelError.classList.add('hidden');
    }

    if (mode === 'edit' && vehicle) {
      if (title) title.textContent = 'Edit Vehicle';
      if (editIdInput) editIdInput.value = vehicle.id;
      if (regInput) regInput.value = vehicle.registrationNumber || '';
      if (typeInput) typeInput.value = vehicle.type || 'car';
      if (labelInput) labelInput.value = vehicle.label || '';
    } else {
      if (title) title.textContent = 'Add Vehicle';
      if (editIdInput) editIdInput.value = '';
      if (regInput) regInput.value = '';
      if (typeInput) typeInput.value = 'car';
      if (labelInput) labelInput.value = '';
    }

    if (modal) modal.classList.remove('hidden');
    if (regInput) regInput.focus();
  };

  const closeVehicleModal = () => {
    const modal = safeGetElement('vehicle-modal');
    if (modal) modal.classList.add('hidden');
  };

  const handleSaveVehicle = async (event) => {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }

    if (isVehicleSubmitting) return;

    const editIdInput = safeGetElement('vehicle-edit-id');
    const regInput = safeGetElement('vehicle-input-reg');
    const typeInput = safeGetElement('vehicle-input-type');
    const labelInput = safeGetElement('vehicle-input-label');
    const banner = safeGetElement('vehicle-form-error-banner');
    const regError = safeGetElement('vehicle-reg-error');
    const typeError = safeGetElement('vehicle-type-error');
    const labelError = safeGetElement('vehicle-label-error');
    const saveBtn = safeGetElement('btn-save-vehicle');

    if (banner) {
      banner.textContent = '';
      banner.classList.add('hidden');
    }
    if (regError) {
      regError.textContent = '';
      regError.classList.add('hidden');
    }
    if (typeError) {
      typeError.textContent = '';
      typeError.classList.add('hidden');
    }
    if (labelError) {
      labelError.textContent = '';
      labelError.classList.add('hidden');
    }

    const editId = editIdInput ? editIdInput.value.trim() : '';
    const regRaw = regInput ? regInput.value.trim() : '';
    const typeRaw = typeInput ? typeInput.value.trim() : '';
    const labelRaw = labelInput ? labelInput.value.trim() : '';

    // Validation
    if (!regRaw) {
      if (regError) {
        regError.textContent = 'Registration number is required.';
        regError.classList.remove('hidden');
      }
      if (regInput) regInput.focus();
      return;
    }
    if (regRaw.length < 2 || regRaw.length > 20) {
      if (regError) {
        regError.textContent = 'Registration number must be between 2 and 20 characters.';
        regError.classList.remove('hidden');
      }
      if (regInput) regInput.focus();
      return;
    }

    if (!['car', 'bike', 'ev'].includes(typeRaw.toLowerCase())) {
      if (typeError) {
        typeError.textContent = 'Please select a valid vehicle type.';
        typeError.classList.remove('hidden');
      }
      return;
    }

    if (labelRaw.length > 50) {
      if (labelError) {
        labelError.textContent = 'Nickname cannot exceed 50 characters.';
        labelError.classList.remove('hidden');
      }
      return;
    }

    isVehicleSubmitting = true;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      const payload = {
        registrationNumber: regRaw,
        type: typeRaw.toLowerCase(),
        label: labelRaw,
      };

      if (editId) {
        const res = await ApiClient.patch(`/api/vehicles/${encodeURIComponent(editId)}`, payload);
        if (res && res.success) {
          safeShowToast('Vehicle updated successfully.', 'success');
          closeVehicleModal();
          await loadVehicles({ silent: true });
        } else {
          throw new Error(res?.message || 'Failed to update vehicle.');
        }
      } else {
        const res = await ApiClient.post('/api/vehicles', payload);
        if (res && res.success) {
          safeShowToast('Vehicle saved successfully.', 'success');
          closeVehicleModal();
          await loadVehicles({ silent: true });
        } else {
          throw new Error(res?.message || 'Failed to save vehicle.');
        }
      }
    } catch (err) {
      if (banner) {
        banner.textContent = err.message || 'Failed to save vehicle.';
        banner.classList.remove('hidden');
      }
    } finally {
      isVehicleSubmitting = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Vehicle';
      }
    }
  };

  const handleDeleteVehicle = async (vehicleId, regNumber) => {
    if (!vehicleId) return;

    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`Are you sure you want to remove vehicle "${regNumber || ''}"?`)
      : true;

    if (!confirmed) return;

    try {
      const res = await ApiClient.delete(`/api/vehicles/${encodeURIComponent(vehicleId)}`);
      if (res && res.success) {
        safeShowToast('Vehicle removed successfully.', 'success');
        await loadVehicles({ silent: true });
      } else {
        throw new Error(res?.message || 'Failed to delete vehicle.');
      }
    } catch (err) {
      safeShowToast(err.message || 'Failed to delete vehicle.', 'error');
    }
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
  const initDashboard = async () => {
    const loadingGate = safeGetElement('dashboard-initial-loading');
    if (typeof requireAuth !== 'function') {
      if (loadingGate) loadingGate.classList.add('hidden');
      return;
    }
    const user = await requireAuth();
    if (loadingGate) loadingGate.classList.add('hidden');
    if (!user) return;

    const mainEl = safeGetElement('main-content');
    if (mainEl) mainEl.classList.remove('hidden');

    isDisposed = false;
    isSuspended = false;
    populateUserInfo();

    // Event listener: logout
    const logoutBtn = safeGetElement('btn-logout');
    if (logoutBtn && typeof logoutUser === 'function') logoutBtn.addEventListener('click', logoutUser);

    // Event listener: retry button
    const retryBtn = safeGetElement('btn-retry-dashboard');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        loadDashboardData({ silent: false });
      });
    }

    // Event delegation on active bookings list: distinct routing for refresh vs cancel
    const listEl = safeGetElement('active-bookings-list');
    if (listEl) {
      listEl.addEventListener('click', (event) => {
        // 1. Refresh action: sends GET only, never triggers cancel or PATCH
        const refreshBtn = event.target.closest ? event.target.closest('.btn-refresh-card, [data-action="refresh"]') : null;
        if (refreshBtn) {
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          loadDashboardData({ silent: false });
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

    // Event listeners: Vehicle management
    const addVehicleBtn = safeGetElement('btn-add-vehicle');
    if (addVehicleBtn) addVehicleBtn.addEventListener('click', () => openVehicleModal('add'));

    const addVehicleEmptyBtn = safeGetElement('btn-add-vehicle-empty');
    if (addVehicleEmptyBtn) addVehicleEmptyBtn.addEventListener('click', () => openVehicleModal('add'));

    const closeVehicleModalBtn = safeGetElement('btn-close-vehicle-modal');
    if (closeVehicleModalBtn) closeVehicleModalBtn.addEventListener('click', closeVehicleModal);

    const cancelVehicleModalBtn = safeGetElement('btn-cancel-vehicle-modal');
    if (cancelVehicleModalBtn) cancelVehicleModalBtn.addEventListener('click', closeVehicleModal);

    const vehicleModal = safeGetElement('vehicle-modal');
    if (vehicleModal) {
      vehicleModal.addEventListener('click', (event) => {
        if (event.target === vehicleModal) closeVehicleModal();
      });
    }

    const vehicleForm = safeGetElement('vehicle-form');
    if (vehicleForm) {
      vehicleForm.addEventListener('submit', handleSaveVehicle);
    }

    const retryVehiclesBtn = safeGetElement('btn-retry-vehicles');
    if (retryVehiclesBtn) {
      retryVehiclesBtn.addEventListener('click', () => loadVehicles({ silent: false }));
    }

    const vehiclesListEl = safeGetElement('vehicles-list');
    if (vehiclesListEl) {
      vehiclesListEl.addEventListener('click', (event) => {
        const editBtn = event.target.closest ? event.target.closest('.btn-edit-vehicle') : null;
        if (editBtn) {
          const vId = editBtn.dataset.vehicleId;
          const vehicle = savedVehiclesData.find((v) => v.id === vId);
          if (vehicle) openVehicleModal('edit', vehicle);
          return;
        }

        const deleteBtn = event.target.closest ? event.target.closest('.btn-delete-vehicle') : null;
        if (deleteBtn) {
          const vId = deleteBtn.dataset.vehicleId;
          const reg = deleteBtn.dataset.vehicleReg;
          handleDeleteVehicle(vId, reg);
          return;
        }
      });
    }

    // Lifecycle events: register only once to avoid duplicate listeners
    if (!isInitialized) {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            const modal = safeGetElement('vehicle-modal');
            if (modal && !modal.classList.contains('hidden')) {
              closeVehicleModal();
            }
          }
        });
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('pageshow', handlePageShow);
      }
      isInitialized = true;
    }

    // Initial load
    await loadDashboardData({ silent: false });
    startCountdownTimer();
    startPolling();
  };

  const DashboardApp = {
    loadDashboardData,
    handleCancelBooking,
    calculateRemainingMs,
    formatRemainingTime,
    setServerClockOffset: (offset) => { serverClockOffsetMs = offset; },
    getServerClockOffset: () => serverClockOffsetMs,
    getRequestSeq: () => requestSeq,
    getActiveBookings: () => [...activeBookingsData],
    createBookingCard,
    renderActiveBookings,
    cleanup,
    suspendPage,
    resumePage,
    handlePageHide,
    handlePageShow,
    initDashboard,
    getPendingCancellations: () => pendingCancellations,
    getConfirmedCancellations: () => confirmedCancellations,
    isDisposed: () => isDisposed,
    isSuspended: () => isSuspended,
    resetDisposed: () => { isDisposed = false; isSuspended = false; },
    // Vehicle additions
    loadVehicles,
    renderVehiclesList,
    createVehicleCard,
    openVehicleModal,
    closeVehicleModal,
    handleSaveVehicle,
    handleDeleteVehicle,
    getSavedVehicles: () => [...savedVehiclesData],
    setSavedVehicles: (v) => { savedVehiclesData = [...v]; },
    isVehicleSubmitting: () => isVehicleSubmitting,
    isVehiclesLoading: () => isVehiclesLoading,
  };

  if (typeof window !== 'undefined') {
    window.__dashboardApp = DashboardApp;
  }

  if (typeof document !== 'undefined') {
    const boot = async () => {
      await initDashboard();
      if (safeGetElement('vehicles-list') || safeGetElement('btn-add-vehicle')) {
        await loadVehicles({ silent: false });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DashboardApp,
      formatPaise,
      calculateRemainingMs,
      formatRemainingTime,
      createBookingCard,
      createVehicleCard,
      renderVehiclesList,
      loadVehicles,
    };
  }
})();
