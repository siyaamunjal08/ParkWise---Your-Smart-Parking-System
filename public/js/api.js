// public/js/api.js — Centralized API Client
/* ============================================================
   Smart Parking System — Central API Helper

   PURPOSE:
   Provides a safe, reusable HTTP request wrapper around `fetch`:
     - Dispatches requests to validated same-origin /api endpoints.
     - Resolves all request paths strictly via `new URL(path, window.location.href)`.
     - Validates destination before attaching credentials or calling fetch:
         1. Resolved origin matches window.location.origin.
         2. Protocol is HTTP or HTTPS.
         3. Pathname is strictly within /api/.
     - Rejects unsupported, cross-origin, protocol-relative, and backslash URLs
       before they can reach fetch.
     - Automatically serializes JSON request bodies.
     - Attaches the JWT Bearer token only to validated same-origin requests.
     - Safely parses JSON and non-JSON responses.
     - Guarantees credentials and tokens are never logged.

   DEPENDS ON:
     - js/storage.js → SessionStore (for getToken)

   EXPOSES:
     - window.ApiClient: { request, get, post, patch, put, delete, validateApiUrl, isSameOrigin }
     - window.ApiError: error class with status, code, and safe message
   ============================================================ */

'use strict';

/**
 * Custom Error representation for API, URL validation, and Network failures.
 */
class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', data = null, isNetwork = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.isNetwork = isNetwork;
  }
}

/**
 * Resolve and validate a request destination against strict security requirements:
 * 1. Resolves via new URL(path, baseHref).
 * 2. Origin matches window.location.origin.
 * 3. Protocol is http: or https:.
 * 4. Pathname is strictly within /api/.
 *
 * Rejects unsupported destinations before any credentials are attached or fetch is called.
 *
 * @param {string} path - Target path or URL (e.g. '/api/auth/login')
 * @returns {URL} Validated, resolved URL object
 * @throws {ApiError} if validation fails
 */
const validateApiUrl = (path) => {
  if (!path || typeof path !== 'string' || !path.trim()) {
    throw new ApiError('Request destination must be a non-empty string.', {
      status: 0,
      code: 'INVALID_URL',
    });
  }

  const baseHref =
    typeof window !== 'undefined' && window.location && window.location.href
      ? window.location.href
      : 'http://localhost:5000/';

  const expectedOrigin =
    typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : new URL(baseHref).origin;

  let resolved;
  try {
    resolved = new URL(path, baseHref);
  } catch {
    throw new ApiError('Request destination is not a valid URL.', {
      status: 0,
      code: 'INVALID_URL',
    });
  }

  // 1. Origin must strictly match current window origin
  if (resolved.origin !== expectedOrigin) {
    throw new ApiError('Cross-origin requests are not permitted.', {
      status: 0,
      code: 'CROSS_ORIGIN_FORBIDDEN',
    });
  }

  // 2. Protocol must be HTTP or HTTPS
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new ApiError('Unsupported URL protocol. Only HTTP and HTTPS are permitted.', {
      status: 0,
      code: 'UNSUPPORTED_PROTOCOL',
    });
  }

  // 3. Pathname must be strictly within /api/
  if (resolved.pathname !== '/api' && !resolved.pathname.startsWith('/api/')) {
    throw new ApiError('API requests must be within /api/.', {
      status: 0,
      code: 'UNSUPPORTED_DESTINATION',
    });
  }

  return resolved;
};

const ApiClient = (() => {
  /**
   * Determine whether a URL is a valid same-origin API endpoint.
   * Parses through validateApiUrl without string-prefix shortcuts.
   * @param {string} url
   * @returns {boolean}
   */
  const isSameOrigin = (url) => {
    try {
      validateApiUrl(url);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Safe user-facing error message extractor.
   * Does not use innerHTML; ensures plain-text safety.
   * @param {number} status
   * @param {any} data
   * @returns {string}
   */
  const getSafeErrorMessage = (status, data) => {
    if (data && typeof data === 'object' && typeof data.message === 'string' && data.message.trim()) {
      return data.message.trim();
    }
    switch (status) {
      case 400:
        return 'The request could not be processed due to invalid data.';
      case 401:
        return 'Invalid email or password.';
      case 403:
        return 'You do not have permission to perform this action.';
      case 404:
        return 'The requested resource was not found.';
      case 409:
        return 'A conflict occurred with existing data.';
      case 429:
        return 'Too many attempts. Please wait a few moments and try again.';
      case 500:
      case 502:
      case 503:
        return 'The server encountered an error. Please try again later.';
      default:
        return `Request failed (${status}).`;
    }
  };

  /**
   * Perform an HTTP request with strict URL validation, error handling,
   * and safe Bearer token attachment.
   *
   * @param {string} path - Target path or URL (e.g. '/api/auth/login')
   * @param {Object} [options] - Fetch configuration options
   * @returns {Promise<any>}
   */
  const request = async (path, options = {}) => {
    // Validate destination FIRST.
    // If invalid, throws ApiError immediately — fetch is NEVER reached.
    const resolvedUrl = validateApiUrl(path);

    const {
      method = 'GET',
      headers = {},
      body,
      ...customConfig
    } = options;

    const configHeaders = { ...headers };

    // Format JSON body if provided as an object
    let serializedBody = body;
    if (body !== undefined && body !== null) {
      if (typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
        if (!configHeaders['Content-Type']) {
          configHeaders['Content-Type'] = 'application/json';
        }
        serializedBody = JSON.stringify(body);
      }
    }

    // Attach Bearer token ONLY to validated same-origin API requests
    const token =
      typeof SessionStore !== 'undefined' && SessionStore && typeof SessionStore.getToken === 'function'
        ? SessionStore.getToken()
        : null;
    if (token && !configHeaders['Authorization']) {
      configHeaders['Authorization'] = `Bearer ${token}`;
    }

    let response;
    try {
      // Fetch the validated resolved URL href
      response = await fetch(resolvedUrl.href, {
        method,
        headers: configHeaders,
        body: serializedBody,
        ...customConfig,
      });
    } catch (networkErr) {
      // Network failure (offline, connection refused, DNS error, timeout)
      throw new ApiError(
        'Unable to connect to the server. Please check your internet connection and try again.',
        { status: 0, code: 'NETWORK_ERROR', isNetwork: true }
      );
    }

    // Parse response body safely
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    } else {
      // Non-JSON response (e.g. static HTML error page from proxy or plain text)
      const text = await response.text().catch(() => '');
      data = text ? { rawText: text } : null;
    }

    if (!response.ok) {
      const message = getSafeErrorMessage(response.status, data);
      const code = (data && typeof data === 'object' && data.code) || `HTTP_${response.status}`;

      throw new ApiError(message, {
        status: response.status,
        code,
        data,
      });
    }

    return data;
  };

  return Object.freeze({
    request,
    get: (path, options = {}) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options = {}) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options = {}) => request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options = {}) => request(path, { ...options, method: 'PUT', body }),
    delete: (path, options = {}) => request(path, { ...options, method: 'DELETE' }),
    validateApiUrl,
    isSameOrigin,
  });
})();

// Expose globally for vanilla browser scripts
if (typeof window !== 'undefined') {
  window.ApiClient = ApiClient;
  window.ApiError = ApiError;
  window.validateApiUrl = validateApiUrl;
}

// Expose for Node.js test execution
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ApiClient,
    ApiError,
    validateApiUrl,
  };
}
