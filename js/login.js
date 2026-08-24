/* ============================================================
   js/login.js
   Smart Parking System — Login Page Controller

   PURPOSE:
   Owns all DOM interaction for login.html.
   Wires the login form to the validation and auth layers.

   DEPENDS ON (loaded before this file via login.html):
     - js/storage.js    → UserStore, SessionStore
     - js/utils.js      → disableButton, enableButton,
                          showToast, redirectTo
     - js/validation.js → validateLoginForm, validateEmail,
                          validateLoginPassword
     - js/auth.js       → requireGuest, loginUser

   RESPONSIBILITIES:
     1. Run requireGuest() — redirect to dashboard if logged in
     2. Grab all form element references
     3. Dynamically create per-field error elements for email
        and password, plus use the existing #login-error div
        for authentication failures
     4. Attach real-time blur validation on both inputs
     5. Handle form submit — validate → login → redirect

   SECURITY NOTE:
   A deliberate single error message is used for auth failures:
   "Invalid email or password." — this prevents user enumeration
   (an attacker cannot tell which of the two fields was wrong).
   Per-field errors are shown only for FORMAT issues, not for
   credential mismatches.

   DOES NOT:
     - Contain any business logic (that is auth.js)
     - Contain any validation rules (that is validation.js)
     - Contain any storage calls (that is storage.js)
     - Use inline event handlers (never onclick="..." in HTML)

   MERN MIGRATION:
   Replace this file with a React LoginPage component.
   Call POST /api/auth/login via Axios instead of loginUser().
   Store the returned JWT token and handle 401 responses.
   ============================================================ */

'use strict';

// ── Guard: if already logged in, skip the login page ─────────
requireGuest();


// ══════════════════════════════════════════════════════════════
// 1. DOM REFERENCES
// ══════════════════════════════════════════════════════════════

const loginForm     = document.getElementById('login-form');
const emailInput    = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginErrorEl  = document.getElementById('login-error');
const submitBtn     = loginForm.querySelector('button[type="submit"]');


// ══════════════════════════════════════════════════════════════
// 2. PER-FIELD ERROR ELEMENTS
// ══════════════════════════════════════════════════════════════
// Per-field errors are created dynamically for FORMAT issues only
// (e.g. "Enter a valid email address").
// Credential failures go into the shared #login-error div.

/**
 * Create a hidden error paragraph and append it inside the
 * same <div> that wraps the given input element.
 * @param {HTMLInputElement} inputEl
 * @param {string}           errorId
 * @returns {HTMLParagraphElement}
 */
const createFieldError = (inputEl, errorId) => {
  const errorEl = document.createElement('p');
  errorEl.id    = errorId;
  errorEl.classList.add('form-error');
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'polite');
  errorEl.setAttribute('hidden', '');
  inputEl.parentElement.appendChild(errorEl);
  return errorEl;
};

const emailError = createFieldError(emailInput,    'email-error');
const passError  = createFieldError(passwordInput, 'password-error');

// Link each input to its error element via aria-describedby
emailInput.setAttribute('aria-describedby',    'email-error');
passwordInput.setAttribute('aria-describedby', 'password-error');


// ══════════════════════════════════════════════════════════════
// 3. ERROR DISPLAY HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Show a format error on a specific field.
 * @param {HTMLElement}      errorEl
 * @param {HTMLInputElement} inputEl
 * @param {string}           message
 */
const showFieldError = (errorEl, inputEl, message) => {
  errorEl.textContent = message;
  errorEl.removeAttribute('hidden');
  inputEl.setAttribute('aria-invalid', 'true');
  inputEl.classList.add('input--error');
};

/**
 * Clear the format error on a specific field.
 * @param {HTMLElement}      errorEl
 * @param {HTMLInputElement} inputEl
 */
const clearFieldError = (errorEl, inputEl) => {
  errorEl.textContent = '';
  errorEl.setAttribute('hidden', '');
  inputEl.removeAttribute('aria-invalid');
  inputEl.classList.remove('input--error');
};

/**
 * Show the shared auth error box (used for credential failures).
 * The #login-error div already exists in login.html with
 * role="alert" and aria-live="polite" — no extra ARIA needed.
 * @param {string} message
 */
const showAuthError = (message) => {
  loginErrorEl.textContent = message;
  loginErrorEl.removeAttribute('hidden');
  loginErrorEl.classList.add('is-visible');
};

/** Hide the shared auth error box. */
const clearAuthError = () => {
  loginErrorEl.textContent = '';
  loginErrorEl.setAttribute('hidden', '');
  loginErrorEl.classList.remove('is-visible');
};

/** Clear all visible errors — both field and auth errors. */
const clearLoginErrors = () => {
  clearFieldError(emailError, emailInput);
  clearFieldError(passError,  passwordInput);
  clearAuthError();
};


// ══════════════════════════════════════════════════════════════
// 4. REAL-TIME BLUR VALIDATION
// ══════════════════════════════════════════════════════════════
// Only validates FORMAT on blur — not credentials.
// Credential check only happens on submit (requires a server call).

emailInput.addEventListener('blur', () => {
  const { valid, error } = validateEmail(emailInput.value);
  valid
    ? clearFieldError(emailError, emailInput)
    : showFieldError(emailError, emailInput, error);
});

passwordInput.addEventListener('blur', () => {
  const { valid, error } = validateLoginPassword(passwordInput.value);
  valid
    ? clearFieldError(passError, passwordInput)
    : showFieldError(passError, passwordInput, error);
});

// Clear the shared auth error whenever the user starts typing again
emailInput.addEventListener('input', clearAuthError);
passwordInput.addEventListener('input', clearAuthError);


// ══════════════════════════════════════════════════════════════
// 5. FORM SUBMIT HANDLER
// ══════════════════════════════════════════════════════════════

loginForm.addEventListener('submit', (event) => {
  // Prevent default browser form submission
  event.preventDefault();

  // Clear any previous errors
  clearAllErrors();

  // Collect raw input values
  const formData = {
    email:    emailInput.value,
    password: passwordInput.value,
  };

  // Step 1 — Format validation (email pattern, password length)
  const { valid, errors } = validateLoginForm(formData);

  if (!valid) {
    if (errors.email)    showFieldError(emailError, emailInput,    errors.email);
    if (errors.password) showFieldError(passError,  passwordInput, errors.password);

    // Focus the first invalid field
    if (errors.email)    emailInput.focus();
    else if (errors.password) passwordInput.focus();
    return;
  }

  // Step 2 — Disable button to prevent double-submission
  disableButton(submitBtn, 'Logging in…');

  // Step 3 — Credential check via auth layer
  const result = loginUser(formData.email, formData.password);

  if (!result.success) {
    // Show vague auth error — never reveal which field was wrong
    showAuthError(result.message);
    enableButton(submitBtn);

    // Clear password field on failed attempt (security best practice)
    passwordInput.value = '';
    emailInput.focus();
    return;
  }

  // Step 4 — Success: greet the user and redirect to dashboard
  showToast(`Welcome back, ${result.user.name}!`, 'success');
  setTimeout(() => redirectTo('dashboard.html'), 1500);
});
