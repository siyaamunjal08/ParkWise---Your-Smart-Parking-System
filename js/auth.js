// Auth Module - Aastik

/* ============================================================
   js/auth.js
   Smart Parking System — Authentication Business Logic

   PURPOSE:
   Shared authentication module consumed by register.js and
   login.js. Handles password hashing, credential verification,
   user registration, login, logout, and route guard checks.

   DEPENDS ON (must be loaded before this file):
     - js/storage.js   → UserStore, SessionStore
     - js/utils.js     → redirectTo

   DOES NOT:
     - Touch the DOM directly (that is register.js / login.js)
     - Contain form event listeners (page scripts handle those)

   ============================================================ */

'use strict';


// ══════════════════════════════════════════════════════════════
// 1. PASSWORD HASHING
// ══════════════════════════════════════════════════════════════

/**
 * Hash a plain-text password using a deterministic djb2-style
 * polynomial rolling hash. Returns a fixed-length hex string.
 *
 *
 * @param {string} password
 * @returns {string} hex hash string
 */
const hashPassword = (password) => {
  const SALT   = 'sps_salt_v1';           // application-level salt
  const salted = `${SALT}:${password}`;   // prepend salt to input

  let hash = 5381;                        // djb2 initial value

  for (let i = 0; i < salted.length; i++) {
    // hash = hash * 33 ^ charCode  (bitwise for speed)
    hash = ((hash << 5) + hash) ^ salted.charCodeAt(i);
    hash |= 0;                            // force 32-bit integer
  }

  // Convert to an unsigned 32-bit hex string, zero-padded to 8 chars
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * Verify a plain-text password against a stored hash.
 * @param {string} password   - plain-text input from the form
 * @param {string} storedHash - hash retrieved from UserStore
 * @returns {boolean}
 */
const verifyPassword = (password, storedHash) => {
  return hashPassword(password) === storedHash;
};


// ══════════════════════════════════════════════════════════════
// 2. REGISTRATION
// ══════════════════════════════════════════════════════════════

/**
 * Result shape returned by registerUser and loginUser.
 * @typedef {{ success: boolean, message: string, user?: Object }} AuthResult
 */

/**
 * Register a new user.
 * Checks for duplicate email, hashes the password, persists the
 * user document, then creates a session.
 *
 *
 * @param {{ name, email, phone, password }} userData
 * @returns {AuthResult}
 */
const registerUser = (userData) => {
  const { name, email, phone, password } = userData;

  // 1. Duplicate email check
  if (UserStore.emailExists(email)) {
    return {
      success: false,
      message: 'An account with this email address already exists. Please login.',
    };
  }

  // 2. Hash the password before storing
  const passwordHash = hashPassword(password);

  // 3. Persist the new user (password field is never stored plain)
  const savedUser = UserStore.create({
    name:  name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone.trim(),
    passwordHash,
  });

  // 4. Start a session immediately after registration
  SessionStore.save(savedUser);

  return {
    success: true,
    message: `Welcome, ${savedUser.name}! Your account has been created.`,
    user:    savedUser,
  };
};


// ══════════════════════════════════════════════════════════════
// 3. LOGIN
// ══════════════════════════════════════════════════════════════

/**
 * Authenticate a user by email and password.
 * Intentionally uses a vague error message on failure to prevent
 * user enumeration (do not distinguish "email not found" from
 * "wrong password" in the UI).
 *
 *
 * @param {string} email
 * @param {string} password
 * @returns {AuthResult}
 */
const loginUser = (email, password) => {
  // 1. Look up user by email
  const user = UserStore.findByEmail(email);

  // 2. Verify: user must exist AND password must match
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return {
      success: false,
      message: 'Invalid email or password. Please try again.',
    };
  }

  // 3. Create session for the authenticated user
  SessionStore.save(user);

  return {
    success: true,
    message: `Welcome back, ${user.name}!`,
    user,
  };
};


// ══════════════════════════════════════════════════════════════
// 4. LOGOUT
// ══════════════════════════════════════════════════════════════

/**
 * Log out the current user.
 * Clears the session and redirects to the login page.
 *
 */
const logoutUser = () => {
  SessionStore.clear();
  redirectTo('login.html');
};


// ══════════════════════════════════════════════════════════════
// 5. SESSION HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Get the full user document for the currently logged-in user.
 * Combines session data with the full UserStore record.
 *
 *
 * @returns {Object|null} full user document, or null if not logged in
 */
const getCurrentUser = () => {
  const session = SessionStore.get();
  if (!session) return null;
  return UserStore.findById(session.userId) ?? null;
};

/**
 * Get the current session summary (lightweight — no DB lookup).
 * Use this for display-only data (e.g. "Welcome, John").
 * @returns {{ userId, name, email, loginAt }|null}
 */
const getSession = () => {
  return SessionStore.get();
};


// ══════════════════════════════════════════════════════════════
// 6. ROUTE GUARDS
// ══════════════════════════════════════════════════════════════

/**
 * Protect a page that requires the user to be logged in.
 * Call this as the very first line of any protected page script.
 * If the user is not authenticated, they are immediately sent to
 * the login page and the rest of the script never executes.
 *
 *
 * Usage:
 *   // dashboard.js, booking.js, history.js, profile.js
 *   requireAuth();
 */
const requireAuth = () => {
  if (!SessionStore.isLoggedIn()) {
    redirectTo('login.html');
  }
};


const requireGuest = () => {
  if (SessionStore.isLoggedIn()) {
    redirectTo('dashboard.html');
  }
};
