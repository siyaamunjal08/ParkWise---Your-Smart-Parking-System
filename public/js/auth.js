// public/js/auth.js — Authentication Business Logic & Session Verification
/* ============================================================
   Smart Parking System — Authentication Business Logic

   PURPOSE:
   Shared authentication module consumed by frontend pages.
   Handles backend user registration, login, logout, session
   verification with GET /api/auth/me, and asynchronous route guards.

   DEPENDS ON (loaded before this file):
     - js/storage.js → SessionStore
     - js/api.js     → ApiClient, ApiError
     - js/utils.js   → redirectTo, showToast

   DOES NOT:
     - Perform browser-only password hashing
     - Fall back to local authentication
     - Touch form DOM directly (handled by login.js / register.js)
   ============================================================ */

'use strict';

// ══════════════════════════════════════════════════════════════
// 1. REGISTRATION (POST /api/auth/register)
// ══════════════════════════════════════════════════════════════

/**
 * Result shape returned by registerUser and loginUser.
 * @typedef {{ success: boolean, message: string, user?: Object, code?: string }} AuthResult
 */

/**
 * Register a new user via the backend API.
 * Strictly sends only the allowed fields (name, email, phone, password).
 * Rejects public role selection; registration never creates admins.
 *
 * @param {{ name: string, email: string, phone: string, password: string }} userData
 * @returns {Promise<AuthResult>}
 */
const registerUser = async (userData) => {
  const { name, email, phone, password } = userData;

  // Strict whitelist of allowed fields sent over the wire
  const payload = {
    name: typeof name === 'string' ? name.trim() : '',
    email: typeof email === 'string' ? email.trim().toLowerCase() : '',
    phone: typeof phone === 'string' ? phone.trim() : '',
    password: typeof password === 'string' ? password : '',
  };

  try {
    const data = await ApiClient.post('/api/auth/register', payload);

    if (data && data.success && data.token && data.user) {
      // Save JWT and user DTO in sessionStorage
      SessionStore.save(data.token, data.user);
      return {
        success: true,
        message: data.message || `Welcome, ${data.user.name}! Your account has been created.`,
        user: data.user,
      };
    }

    return {
      success: false,
      message: (data && data.message) || 'Registration failed. Please try again.',
      code: (data && data.code) || 'REGISTRATION_FAILED',
    };
  } catch (err) {
    return {
      success: false,
      message: err.message || 'Registration failed. Please check your details and try again.',
      code: err.code || 'REGISTRATION_ERROR',
    };
  }
};


// ══════════════════════════════════════════════════════════════
// 2. LOGIN (POST /api/auth/login)
// ══════════════════════════════════════════════════════════════

/**
 * Authenticate a user or admin by email and password via backend API.
 * Uses generic invalid-credentials error to prevent user enumeration.
 * Never falls back to local storage authentication.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<AuthResult>}
 */
const loginUser = async (email, password) => {
  const payload = {
    email: typeof email === 'string' ? email.trim().toLowerCase() : '',
    password: typeof password === 'string' ? password : '',
  };

  try {
    const data = await ApiClient.post('/api/auth/login', payload);

    if (data && data.success && data.token && data.user) {
      // Store session in sessionStorage
      SessionStore.save(data.token, data.user);
      return {
        success: true,
        message: data.message || `Welcome back, ${data.user.name}!`,
        user: data.user,
      };
    }

    return {
      success: false,
      message: 'Invalid email or password.',
      code: 'INVALID_CREDENTIALS',
    };
  } catch (err) {
    if (err.status === 401) {
      return {
        success: false,
        message: 'Invalid email or password.',
        code: 'INVALID_CREDENTIALS',
      };
    }
    return {
      success: false,
      message: err.message || 'Login failed. Please check your connection and try again.',
      code: err.code || 'LOGIN_ERROR',
    };
  }
};


// ══════════════════════════════════════════════════════════════
// 3. LOGOUT
// ══════════════════════════════════════════════════════════════

/**
 * Log out the current user.
 * Clears only authentication session state (sessionStorage)
 * without deleting unrelated application or browser data.
 */
const logoutUser = () => {
  SessionStore.clear();
  redirectTo('login.html');
};


// ══════════════════════════════════════════════════════════════
// 4. SESSION VERIFICATION & HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Verify current session with the backend (GET /api/auth/me).
 * Updates cached user information on success.
 *
 * @returns {Promise<{ authenticated: boolean, user?: Object, forbidden?: boolean, networkError?: boolean, reason?: string, error?: any }>}
 */
const verifySession = async () => {
  const token = SessionStore.getToken();
  if (!token) {
    return { authenticated: false, reason: 'NO_TOKEN' };
  }

  try {
    const data = await ApiClient.get('/api/auth/me');
    if (data && data.success && data.user) {
      SessionStore.updateUser(data.user);
      return { authenticated: true, user: data.user };
    }
    return { authenticated: false, reason: 'INVALID_RESPONSE' };
  } catch (err) {
    if (err.status === 401) {
      // Token expired, invalid, or user was deleted from the database
      SessionStore.clear();
      return { authenticated: false, reason: 'UNAUTHORIZED', error: err };
    }
    if (err.status === 403) {
      // Forbidden: caller does not have sufficient role/permissions.
      // Do NOT clear authentication state on 403!
      return { authenticated: true, forbidden: true, reason: 'FORBIDDEN', error: err };
    }
    // Network error or 5xx server failure:
    // Do NOT declare session valid, and do NOT delete the token.
    return {
      authenticated: false,
      networkError: true,
      reason: 'SERVER_OR_NETWORK_ERROR',
      error: err,
    };
  }
};

/**
 * Get the cached user document for display purposes only.
 * Authoritative verification must call verifySession().
 * @returns {Object|null}
 */
const getCurrentUser = () => {
  return SessionStore.get()?.user || null;
};

/**
 * Get current session summary for display.
 * @returns {Object|null}
 */
const getSession = () => {
  return SessionStore.get();
};


// ══════════════════════════════════════════════════════════════
// 5. ROUTE GUARDS & ERROR BANNERS
// ══════════════════════════════════════════════════════════════

/**
 * Display a non-destructive retry banner on the page for network or server errors.
 * Never inserts unescaped HTML content.
 * @param {string} message
 */
const showNetworkBanner = (message) => {
  const existing = document.getElementById('network-error-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'network-error-banner';
  banner.setAttribute('role', 'alert');
  banner.setAttribute('aria-live', 'assertive');
  banner.style.cssText =
    'background: #451a03; color: #fed7aa; border: 1px solid #b45309; padding: 12px 18px; border-radius: 8px; margin: 16px auto; max-width: 960px; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 0.88rem;';

  const textSpan = document.createElement('span');
  textSpan.textContent = `Connection issue: ${message} Your session was preserved.`;
  banner.appendChild(textSpan);

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.textContent = 'Retry';
  retryBtn.style.cssText =
    'background: #f97316; color: #ffffff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.82rem;';
  retryBtn.onclick = () => window.location.reload();
  banner.appendChild(retryBtn);

  const header = document.querySelector('header');
  if (header && header.parentNode) {
    header.parentNode.insertBefore(banner, header.nextSibling);
  } else {
    const main = document.querySelector('main') || document.body;
    if (main.classList && main.classList.contains('hidden')) {
      main.classList.remove('hidden');
    }
    main.prepend(banner);
  }
};

/**
 * Protect a page that requires an active, verified backend session.
 * Asynchronous: waits for GET /api/auth/me verification.
 *
 * Behavior:
 *   - No token: redirects immediately to login.html.
 *   - 401 (expired/invalid): clears session and redirects once to login.html.
 *   - 403 (forbidden): shows permission notice without logging out.
 *   - Network / 5xx error: shows a retryable banner without deleting token.
 *   - 200 (verified): returns the verified user DTO.
 *
 * @returns {Promise<Object|null>} verified user object or null
 */
const ALLOWED_RETURN_PAGES = new Set([
  'booking.html',
  'dashboard.html',
  'locations.html',
  'history.html',
  'index.html',
  'admin.html',
]);

/**
 * Validate and sanitize return URL query parameters for post-login redirection.
 * Enforces strict same-origin destination resolution, allowlisted application
 * pages, and prevents open-redirect and protocol-relative bypasses.
 *
 * Rules:
 * - Reject external origins (e.g. //evil.com, https://evil.com)
 * - Reject Windows backslash bypasses (e.g. \evil.com, /\evil.com)
 * - Reject protocol-relative and leading slash reinterpretation tricks
 * - Prefer an allowlist of actual supported application page paths
 * - Reject login.html and register.html to prevent redirect loops
 * - Preserve booking location query (?locationId=...)
 * - On rejection or absence, safely falls back to defaultTarget (e.g. 'dashboard.html').
 *
 * @param {string|null|undefined} rawTarget
 * @param {string} [defaultTarget='dashboard.html']
 * @returns {string} Safe relative or path URL to redirect to
 */
const getSafeReturnUrl = (rawTarget, defaultTarget = 'dashboard.html') => {
  if (!rawTarget || typeof rawTarget !== 'string') {
    return defaultTarget;
  }

  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return defaultTarget;
  }

  // Reject control characters, protocol-relative (//), and backslash (\) bypasses
  if (/[\r\n\t\0]/.test(trimmed) || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return defaultTarget;
  }

  try {
    const baseOrigin = typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'http://localhost:5000';
    const baseHref = typeof window !== 'undefined' && window.location && window.location.href
      ? window.location.href
      : `${baseOrigin}/`;

    const parsed = new URL(trimmed, baseHref);

    // Origin must strictly match
    if (parsed.origin !== baseOrigin) {
      return defaultTarget;
    }

    // Protocol must be http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return defaultTarget;
    }

    // Path and query must not contain backslashes or unexpected control characters
    if (parsed.pathname.includes('\\') || parsed.search.includes('\\') || /[\r\n\t]/.test(parsed.pathname)) {
      return defaultTarget;
    }

    // Path must strictly be a single root-level allowlisted page with exactly one leading slash
    // Disallows multi-slash paths like ///example.com or nested paths
    const cleanPath = parsed.pathname.replace(/^\/+/, '');
    if (parsed.pathname !== `/${cleanPath}` || !ALLOWED_RETURN_PAGES.has(cleanPath)) {
      return defaultTarget;
    }

    // Reject login / register loops explicitly
    if (cleanPath === 'login.html' || cleanPath === 'register.html') {
      return defaultTarget;
    }

    // Preserve the booking location query if target is booking.html
    if (cleanPath === 'booking.html') {
      const locId = parsed.searchParams.get('locationId');
      if (locId && locId.trim()) {
        return `booking.html?locationId=${encodeURIComponent(locId.trim())}`;
      }
      return 'booking.html';
    }

    return cleanPath;
  } catch {
    return defaultTarget;
  }
};

/**
 * Protect a page that requires an active, verified backend session.
 * Asynchronous: waits for GET /api/auth/me verification.
 *
 * Behavior:
 *   - No token: redirects immediately to login.html with safe returnUrl.
 *   - 401 (expired/invalid): clears session and redirects once to login.html with safe returnUrl.
 *   - 403 (forbidden): shows permission notice without logging out.
 *   - Network / 5xx error: shows a retryable banner without deleting token.
 *   - 200 (verified): returns the verified user DTO.
 *
 * @param {string} [returnDestination] Optional explicit return path on unauthenticated redirect
 * @returns {Promise<Object|null>} verified user object or null
 */
const requireAuth = async (returnDestination) => {
  let target = returnDestination;
  if (!target && typeof window !== 'undefined' && window.location) {
    const pageName = window.location.pathname.split('/').pop() || '';
    if (pageName && pageName !== 'login.html' && pageName !== 'register.html') {
      target = pageName + window.location.search;
    }
  }

  const safeTarget = target ? getSafeReturnUrl(target, '') : '';
  const loginRedirect = safeTarget && safeTarget !== 'dashboard.html'
    ? `login.html?returnUrl=${encodeURIComponent(safeTarget)}`
    : 'login.html';

  if (!SessionStore.isLoggedIn()) {
    SessionStore.clear();
    redirectTo(loginRedirect);
    return null;
  }

  const result = await verifySession();

  if (result.authenticated) {
    if (result.forbidden) {
      if (typeof showToast === 'function') {
        showToast('Permission denied: You do not have access to this resource.', 'error');
      }
      return null;
    }
    updateAdminNavigation(result.user);
    return result.user;
  }

  if (result.networkError) {
    // Show retryable error banner; session token is preserved
    showNetworkBanner(
      result.error?.message || 'Unable to connect to the server to verify your session.'
    );
    return null;
  }

  // 401 or invalid response: redirect once to login
  redirectTo(loginRedirect);
  return null;
};

/**
 * Display an "Admin Console" navigation link for verified admins.
 * Does not insert links if user is not an admin.
 * @param {Object} user
 */
const updateAdminNavigation = (user) => {
  if (typeof document === 'undefined') return;
  if (!user || user.role !== 'admin') return;

  const existing = document.getElementById('nav-admin-link');
  if (existing) {
    existing.classList.remove('hidden');
    existing.removeAttribute('hidden');
    return;
  }

  const navList = document.querySelector('nav.site-nav ul, nav ul');
  if (navList && !document.getElementById('nav-admin-link')) {
    const li = document.createElement('li');
    li.id = 'nav-admin-link';
    const a = document.createElement('a');
    a.href = 'admin.html';
    a.textContent = 'Admin Console';
    li.appendChild(a);
    navList.appendChild(li);
  }
};

/**
 * Protect an admin-only page (admin.html).
 * Asynchronous: waits for GET /api/auth/me verification.
 *
 * Rules:
 * - Logged-out users go to login with validated return destination (e.g. login.html?returnUrl=admin.html).
 * - Expired/invalid (401) sessions clear token and redirect to login.
 * - Standard logged-in users (non-admin) receive an explicit denial object { denied: true, user }
 *   without logging them out or redirecting.
 * - Only server-verified user with role === 'admin' returns { authorized: true, user }.
 *
 * @param {string} [returnDestination='admin.html']
 * @returns {Promise<{ authorized: boolean, denied?: boolean, networkError?: boolean, user?: Object, reason?: string }>}
 */
const requireAdminAuth = async (returnDestination = 'admin.html') => {
  const safeTarget = getSafeReturnUrl(returnDestination, 'admin.html');
  const loginRedirect = `login.html?returnUrl=${encodeURIComponent(safeTarget)}`;

  if (!SessionStore.isLoggedIn()) {
    SessionStore.clear();
    redirectTo(loginRedirect);
    return { authorized: false, reason: 'NOT_LOGGED_IN' };
  }

  const result = await verifySession();

  if (result.authenticated) {
    if (result.user && result.user.role === 'admin') {
      updateAdminNavigation(result.user);
      return { authorized: true, user: result.user };
    }
    // Authenticated, but not an admin -> access denied
    return { authorized: false, denied: true, user: result.user, reason: 'FORBIDDEN_ROLE' };
  }

  if (result.networkError) {
    showNetworkBanner(
      result.error?.message || 'Unable to connect to the server to verify your session.'
    );
    return { authorized: false, networkError: true, reason: 'NETWORK_ERROR' };
  }

  // 401 or invalid response: redirect to login
  redirectTo(loginRedirect);
  return { authorized: false, reason: 'UNAUTHORIZED' };
};

/**
 * Protect a public guest page (login.html, register.html).
 * If the user has a verified session, redirects to safe return target or dashboard.html.
 * If token is expired (401), clears the stale token to stay on guest page.
 *
 * @returns {Promise<void>}
 */
const requireGuest = async () => {
  if (!SessionStore.isLoggedIn()) {
    return;
  }

  try {
    const result = await verifySession();
    if (result.authenticated && !result.forbidden) {
      const params = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;
      const returnTarget = params ? getSafeReturnUrl(params.get('returnUrl'), 'dashboard.html') : 'dashboard.html';
      redirectTo(returnTarget);
    }
  } catch {
    // Let user stay on guest page if verification encounters an unexpected failure
  }
};

// Export for Node/CommonJS test runners
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    registerUser,
    loginUser,
    logoutUser,
    verifySession,
    getCurrentUser,
    getSession,
    requireAuth,
    requireAdminAuth,
    updateAdminNavigation,
    requireGuest,
    getSafeReturnUrl,
    ALLOWED_RETURN_PAGES,
  };
}
