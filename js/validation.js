/* ============================================================

   PURPOSE:
   All client-side validation logic in one place.
   Organised into three layers:

     Layer 1 — RULES
       Pure functions. Input: raw value. Output: { valid, error }.
       No DOM access. Independently testable.

     Layer 2 — FIELD VALIDATORS
       One function per form field. Calls one or more rules.
       Returns { valid: boolean, error: string }.

     Layer 3 — FORM VALIDATORS
       One function per form (register, login, booking).
       Calls all relevant field validators and collects errors.
       Returns { valid: boolean, errors: { fieldName: message } }.

   RULES FOLLOWED:
   - No inline CSS, no inline JS
   - Pure ES6 — const, arrow functions, regex literals
   - Every validator is a reusable, single-responsibility function
   - No direct DOM manipulation (that belongs in auth.js / page scripts)

   MERN MIGRATION:
   Layer 1 (Rules) can be copy-pasted directly into Express
   middleware or a shared validation library (e.g. Joi schema).
   Layer 2 & 3 stay client-side in React components.
   ============================================================ */

'use strict';


// ══════════════════════════════════════════════════════════════
// LAYER 1 — RULES (pure functions, no side effects)
// ══════════════════════════════════════════════════════════════

// ─── Regex Patterns ───────────────────────────────────────────
const PATTERNS = Object.freeze({
  // Standard email — RFC 5322 simplified
  EMAIL: /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,

  // Indian phone: optional +91, then 10 digits starting with 6-9
  PHONE: /^(\+91[\s\-]?)?[6-9]\d{9}$/,

  // Indian vehicle number: MH12AB1234 or MH 12 AB 1234
  // State(2L) + District(2D) + Series(1-3L) + Number(4D)
  VEHICLE_NUMBER: /^[A-Z]{2}[\s\-]?[0-9]{2}[\s\-]?[A-Z]{1,3}[\s\-]?[0-9]{4}$/,

  // Name — letters, spaces, hyphens, apostrophes only
  NAME: /^[a-zA-Z\s'\-]+$/,

  // Password strength — at least one uppercase, lowercase, digit
  PASSWORD_STRONG: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
});

/**
 * Rule: value must not be empty.
 * @param {string} value
 * @param {string} fieldLabel - human-readable field name
 * @returns {{ valid: boolean, error: string }}
 */
const ruleRequired = (value, fieldLabel = 'This field') => {
  const valid = value !== null && value !== undefined && value.trim() !== '';
  return { valid, error: valid ? '' : `${fieldLabel} is required.` };
};

/**
 * Rule: value must be at least `min` characters long.
 * @param {string} value
 * @param {number} min
 * @param {string} fieldLabel
 * @returns {{ valid: boolean, error: string }}
 */
const ruleMinLength = (value, min, fieldLabel = 'This field') => {
  const valid = value.trim().length >= min;
  return {
    valid,
    error: valid ? '' : `${fieldLabel} must be at least ${min} characters.`,
  };
};

/**
 * Rule: value must not exceed `max` characters.
 * @param {string} value
 * @param {number} max
 * @param {string} fieldLabel
 * @returns {{ valid: boolean, error: string }}
 */
const ruleMaxLength = (value, max, fieldLabel = 'This field') => {
  const valid = value.trim().length <= max;
  return {
    valid,
    error: valid ? '' : `${fieldLabel} must not exceed ${max} characters.`,
  };
};

/**
 * Rule: value must match a regex pattern.
 * @param {string} value
 * @param {RegExp} pattern
 * @param {string} errorMessage
 * @returns {{ valid: boolean, error: string }}
 */
const rulePattern = (value, pattern, errorMessage) => {
  const valid = pattern.test(value.trim());
  return { valid, error: valid ? '' : errorMessage };
};

/**
 * Rule: two values must be identical (e.g. password confirmation).
 * @param {string} value
 * @param {string} matchValue
 * @param {string} fieldLabel
 * @returns {{ valid: boolean, error: string }}
 */
const ruleMatch = (value, matchValue, fieldLabel = 'Fields') => {
  const valid = value === matchValue;
  return {
    valid,
    error: valid ? '' : `${fieldLabel} do not match.`,
  };
};

/**
 * Rule: numeric value must be within a min–max range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {string} fieldLabel
 * @returns {{ valid: boolean, error: string }}
 */
const ruleRange = (value, min, max, fieldLabel = 'Value') => {
  const num   = Number(value);
  const valid = !isNaN(num) && num >= min && num <= max;
  return {
    valid,
    error: valid ? '' : `${fieldLabel} must be between ${min} and ${max}.`,
  };
};

/**
 * Run an array of rule results and return the first failure found.
 * Stops at the first error (fail-fast) so the user sees one
 * message at a time per field — not a wall of errors.
 * @param {Array<{ valid: boolean, error: string }>} rules
 * @returns {{ valid: boolean, error: string }}
 */
const runRules = (rules) => {
  for (const result of rules) {
    if (!result.valid) return result;
  }
  return { valid: true, error: '' };
};


// ══════════════════════════════════════════════════════════════
// LAYER 2 — FIELD VALIDATORS
// ══════════════════════════════════════════════════════════════

/**
 * Validate the full name field.
 * Rules: required → min 2 → max 100 → letters/spaces only
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validateName = (value) => {
  return runRules([
    ruleRequired(value, 'Name'),
    ruleMinLength(value, 2, 'Name'),
    ruleMaxLength(value, 100, 'Name'),
    rulePattern(
      value,
      PATTERNS.NAME,
      'Name must contain letters and spaces only.'
    ),
  ]);
};

/**
 * Validate an email address field.
 * Rules: required → valid email format
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validateEmail = (value) => {
  return runRules([
    ruleRequired(value, 'Email'),
    rulePattern(
      value,
      PATTERNS.EMAIL,
      'Enter a valid email address (e.g. name@example.com).'
    ),
  ]);
};

/**
 * Validate an Indian phone number field.
 * Rules: required → Indian format (10 digits, 6-9 start)
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validatePhone = (value) => {
  return runRules([
    ruleRequired(value, 'Phone'),
    rulePattern(
      value.replace(/[\s\-()]/g, ''), // strip spaces/dashes before testing
      PATTERNS.PHONE,
      'Enter a valid 10-digit Indian mobile number (e.g. 9876543210).'
    ),
  ]);
};

/**
 * Validate a new password field.
 * Rules: required → min 8 → max 64 → must contain upper, lower, digit
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validatePassword = (value) => {
  return runRules([
    ruleRequired(value, 'Password'),
    ruleMinLength(value, 8, 'Password'),
    ruleMaxLength(value, 64, 'Password'),
    rulePattern(
      value,
      PATTERNS.PASSWORD_STRONG,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number.'
    ),
  ]);
};

/**
 * Validate the login password field (less strict — no strength check).
 * Only checks presence; the strength check was done at registration.
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validateLoginPassword = (value) => {
  return runRules([
    ruleRequired(value, 'Password'),
    ruleMinLength(value, 8, 'Password'),
  ]);
};

/**
 * Validate the confirm-password field.
 * Rules: required → must match the original password
 * @param {string} value        - confirmPassword input value
 * @param {string} passwordValue - original password input value
 * @returns {{ valid: boolean, error: string }}
 */
const validateConfirmPassword = (value, passwordValue) => {
  return runRules([
    ruleRequired(value, 'Confirm Password'),
    ruleMatch(value, passwordValue, 'Passwords'),
  ]);
};

/**
 * Validate an Indian vehicle registration number.
 * Format: MH12AB1234 or MH 12 AB 1234 (case-insensitive input).
 * @param {string} value
 * @returns {{ valid: boolean, error: string }}
 */
const validateVehicleNumber = (value) => {
  const normalised = value.trim().toUpperCase();
  return runRules([
    ruleRequired(normalised, 'Vehicle number'),
    rulePattern(
      normalised,
      PATTERNS.VEHICLE_NUMBER,
      'Enter a valid Indian vehicle number (e.g. MH12AB1234).'
    ),
  ]);
};

/**
 * Validate the parking duration field.
 * Rules: required → numeric → between 1 and 24 hours
 * @param {string|number} value
 * @returns {{ valid: boolean, error: string }}
 */
const validateDuration = (value) => {
  const required = ruleRequired(String(value), 'Duration');
  if (!required.valid) return required;

  return runRules([
    ruleRange(value, 1, 24, 'Duration'),
  ]);
};

/**
 * Validate the slot selection.
 * Rules: a slot ID must have been chosen.
 * @param {string} value - slot id e.g. "A-01"
 * @returns {{ valid: boolean, error: string }}
 */
const validateSlotSelection = (value) => {
  return runRules([
    ruleRequired(value, 'Slot selection'),
  ]);
};

/**
 * Validate the vehicle type selection.
 * Rules: must be one of the accepted values.
 * @param {string} value - "car" | "bike" | "ev"
 * @returns {{ valid: boolean, error: string }}
 */
const validateVehicleType = (value) => {
  const accepted = ['car', 'bike', 'ev'];
  const valid    = accepted.includes(value);
  return {
    valid,
    error: valid ? '' : 'Please select a valid vehicle type.',
  };
};


// ══════════════════════════════════════════════════════════════
// LAYER 3 — FORM VALIDATORS
// ══════════════════════════════════════════════════════════════

/**
 * Validate the entire registration form.
 * @param {{ name, email, phone, password, confirmPassword }} data
 * @returns {{ valid: boolean, errors: Object }}
 */
const validateRegisterForm = (data) => {
  const errors = {};

  const nameResult    = validateName(data.name);
  const emailResult   = validateEmail(data.email);
  const phoneResult   = validatePhone(data.phone);
  const passResult    = validatePassword(data.password);
  const confirmResult = validateConfirmPassword(
    data.confirmPassword,
    data.password
  );

  if (!nameResult.valid)    errors.name            = nameResult.error;
  if (!emailResult.valid)   errors.email           = emailResult.error;
  if (!phoneResult.valid)   errors.phone           = phoneResult.error;
  if (!passResult.valid)    errors.password        = passResult.error;
  if (!confirmResult.valid) errors.confirmPassword = confirmResult.error;

  return {
    valid:  Object.keys(errors).length === 0,
    errors,
  };
};

/**
 * Validate the login form.
 * @param {{ email, password }} data
 * @returns {{ valid: boolean, errors: Object }}
 */
const validateLoginForm = (data) => {
  const errors = {};

  const emailResult = validateEmail(data.email);
  const passResult  = validateLoginPassword(data.password);

  if (!emailResult.valid) errors.email    = emailResult.error;
  if (!passResult.valid)  errors.password = passResult.error;

  return {
    valid:  Object.keys(errors).length === 0,
    errors,
  };
};

/**
 * Validate the booking form.
 * @param {{ slotId, vehicleType, vehicleNumber, durationHours }} data
 * @returns {{ valid: boolean, errors: Object }}
 */
const validateBookingForm = (data) => {
  const errors = {};

  const slotResult    = validateSlotSelection(data.slotId);
  const typeResult    = validateVehicleType(data.vehicleType);
  const vehicleResult = validateVehicleNumber(data.vehicleNumber);
  const durResult     = validateDuration(data.durationHours);

  if (!slotResult.valid)    errors.slotId        = slotResult.error;
  if (!typeResult.valid)    errors.vehicleType   = typeResult.error;
  if (!vehicleResult.valid) errors.vehicleNumber = vehicleResult.error;
  if (!durResult.valid)     errors.durationHours = durResult.error;

  return {
    valid:  Object.keys(errors).length === 0,
    errors,
  };
};
