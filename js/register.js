// Register Module - Aastik

/* ============================================================
   js/register.js
   Smart Parking System — Registration Page Controller

   PURPOSE:
   Owns all DOM interaction for register.html.
   Wires the registration form to the validation and auth layers.

   DEPENDS ON (loaded before this file via register.html):
     - js/storage.js    → UserStore, SessionStore
     - js/utils.js      → disableButton, enableButton,
                          showToast, redirectTo, scrollToElement
     - js/validation.js → validateRegisterForm, validateName,
                          validateEmail, validatePhone,
                          validatePassword, validateConfirmPassword
     - js/auth.js       → requireGuest, registerUser

   RESPONSIBILITIES:
     1. Run requireGuest() — redirect away if already logged in
     2. Grab all form element references
     3. Dynamically create per-field error elements (no HTML change)
     4. Attach real-time blur validation on every input
     5. Handle form submit — validate → register → redirect

   DOES NOT:
     - Contain any business logic (that is auth.js)
     - Contain any validation rules (that is validation.js)
     - Contain any storage calls (that is storage.js)
     - Use inline event handlers (never onclick="..." in HTML)

   ============================================================ */

'use strict';

// ── Guard: if already logged in, go straight to dashboard ────
requireGuest();


// ══════════════════════════════════════════════════════════════
// 1. DOM REFERENCES
// ══════════════════════════════════════════════════════════════

// The form has no id in HTML — select it via section context
const registerForm    = document.querySelector('#register form');
const nameInput       = document.getElementById('name');
const emailInput      = document.getElementById('email');
const phoneInput      = document.getElementById('phone');
const passwordInput   = document.getElementById('password');
const confirmInput    = document.getElementById('confirm-password');
const submitBtn       = registerForm.querySelector('button[type="submit"]');


// ══════════════════════════════════════════════════════════════
// 2. DYNAMIC ERROR ELEMENTS
// ══════════════════════════════════════════════════════════════
// Error <p> tags are created in JS and inserted after each input.
// This avoids modifying register.html and keeps structure clean.
// auth.css already styles .form-error via the #register form rule.

/**
 * Create a hidden error paragraph and append it inside the
 * same <div> that wraps the given input element.
 * @param {HTMLInputElement} inputEl
 * @param {string}           errorId - unique id for this error element
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

const nameError    = createFieldError(nameInput,     'name-error');
const emailError   = createFieldError(emailInput,    'email-error');
const phoneError   = createFieldError(phoneInput,    'phone-error');
const passError    = createFieldError(passwordInput, 'password-error');
const confirmError = createFieldError(confirmInput,  'confirm-password-error');

// Link each input to its error element via aria-describedby
nameInput.setAttribute('aria-describedby',     'name-error');
emailInput.setAttribute('aria-describedby',    'email-error');
phoneInput.setAttribute('aria-describedby',    'phone-error');
passwordInput.setAttribute('aria-describedby', 'password-error');
confirmInput.setAttribute('aria-describedby',  'confirm-password-error');


// ══════════════════════════════════════════════════════════════
// 3. ERROR DISPLAY HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Show an error message in a field's error element and mark the
 * input as invalid with the aria-invalid attribute.
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
 * Clear the error for a field and remove the invalid markers.
 * @param {HTMLElement}      errorEl
 * @param {HTMLInputElement} inputEl
 */
const clearFieldError = (errorEl, inputEl) => {
  errorEl.textContent = '';
  errorEl.setAttribute('hidden', '');
  inputEl.removeAttribute('aria-invalid');
  inputEl.classList.remove('input--error');
};

/** Clear all five field errors at once. */
const clearRegisterErrors = () => {
  clearFieldError(nameError,    nameInput);
  clearFieldError(emailError,   emailInput);
  clearFieldError(phoneError,   phoneInput);
  clearFieldError(passError,    passwordInput);
  clearFieldError(confirmError, confirmInput);
};

/**
 * Render validation errors returned by validateRegisterForm().
 * @param {{ name?, email?, phone?, password?, confirmPassword? }} errors
 */
const renderErrors = (errors) => {
  if (errors.name)            showFieldError(nameError,    nameInput,     errors.name);
  if (errors.email)           showFieldError(emailError,   emailInput,    errors.email);
  if (errors.phone)           showFieldError(phoneError,   phoneInput,    errors.phone);
  if (errors.password)        showFieldError(passError,    passwordInput, errors.password);
  if (errors.confirmPassword) showFieldError(confirmError, confirmInput,  errors.confirmPassword);
};


// ══════════════════════════════════════════════════════════════
// 4. REAL-TIME BLUR VALIDATION
// ══════════════════════════════════════════════════════════════
// Each input is validated the moment the user leaves it (blur).
// This gives instant, non-intrusive feedback before form submit.

nameInput.addEventListener('blur', () => {
  const { valid, error } = validateName(nameInput.value);
  valid
    ? clearFieldError(nameError, nameInput)
    : showFieldError(nameError, nameInput, error);
});

emailInput.addEventListener('blur', () => {
  const { valid, error } = validateEmail(emailInput.value);
  valid
    ? clearFieldError(emailError, emailInput)
    : showFieldError(emailError, emailInput, error);
});

phoneInput.addEventListener('blur', () => {
  const { valid, error } = validatePhone(phoneInput.value);
  valid
    ? clearFieldError(phoneError, phoneInput)
    : showFieldError(phoneError, phoneInput, error);
});

passwordInput.addEventListener('blur', () => {
  const { valid, error } = validatePassword(passwordInput.value);
  valid
    ? clearFieldError(passError, passwordInput)
    : showFieldError(passError, passwordInput, error);
});

confirmInput.addEventListener('blur', () => {
  const { valid, error } = validateConfirmPassword(
    confirmInput.value,
    passwordInput.value
  );
  valid
    ? clearFieldError(confirmError, confirmInput)
    : showFieldError(confirmError, confirmInput, error);
});

// Re-validate confirm password whenever the original password changes
passwordInput.addEventListener('input', () => {
  if (confirmInput.value === '') return;
  const { valid, error } = validateConfirmPassword(
    confirmInput.value,
    passwordInput.value
  );
  valid
    ? clearFieldError(confirmError, confirmInput)
    : showFieldError(confirmError, confirmInput, error);
});


// ══════════════════════════════════════════════════════════════
// 5. FORM SUBMIT HANDLER
// ══════════════════════════════════════════════════════════════

registerForm.addEventListener('submit', (event) => {
  // Prevent default browser form submission
  event.preventDefault();

  // Clear any previous errors from a prior attempt
  clearAllErrors();

  // Collect raw input values
  const formData = {
    name:            nameInput.value,
    email:           emailInput.value,
    phone:           phoneInput.value,
    password:        passwordInput.value,
    confirmPassword: confirmInput.value,
  };

  // Run all field validators at once
  const { valid, errors } = validateRegisterForm(formData);

  if (!valid) {
    // Show every field error found
    renderErrors(errors);

    // Scroll to the first error so the user sees it
    const firstErrorField = registerForm.querySelector('.input--error');
    if (firstErrorField) firstErrorField.focus();
    return;
  }

  // Disable the submit button to prevent double-submission
  disableButton(submitBtn, 'Creating account…');

  // Delegate to auth layer — no storage calls here
  const result = registerUser(formData);

  if (!result.success) {
    // Most likely a duplicate email — show the message on email field
    showFieldError(emailError, emailInput, result.message);
    enableButton(submitBtn);
    emailInput.focus();
    return;
  }

  // Success: notify the user and redirect to dashboard
  showToast(result.message, 'success');
  setTimeout(() => redirectTo('dashboard.html'), 1500);
});
