// server/config/env.js — Deterministic environment resolution & MongoDB URI validation

'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Deterministically load the root .env file regardless of current working directory
const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
dotenv.config({ path: rootEnvPath });

/**
 * Safely parse the database name from a mongodb:// or mongodb+srv:// URI.
 * Does not fall back to any default database.
 *
 * @param {string} rawUri
 * @returns {string|null} Database name, or null if unparseable/missing
 */
function extractDatabaseName(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return null;
  const trimmed = rawUri.trim();
  // Matches mongodb:// or mongodb+srv:// credentials@host[:port]/database_name(?options)?
  const match = trimmed.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?/\s]+)/i);
  if (!match || !match[1] || match[1].trim() === '') {
    return null;
  }
  return match[1].trim();
}

/**
 * Produce a safe, redacted version of a MongoDB URI with credentials masked.
 * Never outputs raw usernames or passwords.
 *
 * @param {string} rawUri
 * @returns {string} Sanitized string e.g. "mongodb+srv://***:***@cluster.mongodb.net/dbname"
 */
function sanitizeUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '[empty]';
  const trimmed = rawUri.trim();
  // Greedy match up to the last @ before the host/domain name
  return trimmed.replace(/^(mongodb(?:\+srv)?:\/\/).+@([a-z0-9.-]+(?::\d+)?(?:\/.*)?)$/i, '$1***:***@$2');
}

/**
 * Validate configuration for database connectivity.
 * Verifies that:
 * 1. Target URI is defined and non-empty.
 * 2. An explicit database name is present in the path.
 * 3. Primary and test databases do not collide on the same database name.
 *
 * @param {Object} options
 * @param {boolean} [options.isTest=false] Whether to validate TEST_MONGODB_URI as primary
 * @param {string} [options.appUri] Override for application URI (testing)
 * @param {string} [options.testUri] Override for test URI (testing)
 * @returns {{ appDbName: string, testDbName: string|null, sanitizedTarget: string, targetUri: string }}
 */
function validateDatabaseConfig(options = {}) {
  const isTest = Boolean(options.isTest);
  const rawApp = (options.appUri !== undefined ? options.appUri : process.env.MONGODB_URI) || '';
  const rawTest = (options.testUri !== undefined ? options.testUri : process.env.TEST_MONGODB_URI) || '';

  const appUri = (typeof rawApp === 'string' ? rawApp : String(rawApp || '')).trim();
  const testUri = (typeof rawTest === 'string' ? rawTest : String(rawTest || '')).trim();

  const targetUri = isTest ? testUri : appUri;
  const targetLabel = isTest ? 'TEST_MONGODB_URI' : 'MONGODB_URI';

  if (!targetUri) {
    const err = new Error(`${targetLabel} is not defined or is empty in .env.`);
    err.code = 'CONFIG_MISSING_URI';
    throw err;
  }

  const appDbName = extractDatabaseName(appUri);
  const testDbName = testUri ? extractDatabaseName(testUri) : null;

  if (isTest) {
    if (!testDbName) {
      const err = new Error(`TEST_MONGODB_URI is missing an explicit database name in its path. Default database fallback is prohibited.`);
      err.code = 'CONFIG_NO_DATABASE_NAME';
      throw err;
    }
  } else {
    if (!appDbName) {
      const err = new Error(`MONGODB_URI is missing an explicit database name in its path. Default database fallback is prohibited.`);
      err.code = 'CONFIG_NO_DATABASE_NAME';
      throw err;
    }
  }

  // Cross-validation: app and test databases must target different database names
  if (appDbName && testDbName && appDbName.toLowerCase() === testDbName.toLowerCase()) {
    const err = new Error(
      `Database isolation error: MONGODB_URI and TEST_MONGODB_URI must target different database names. Both currently target "${appDbName}".`
    );
    err.code = 'CONFIG_DB_NAME_COLLISION';
    throw err;
  }

  const activeDbName = isTest ? testDbName : appDbName;

  return {
    appDbName,
    testDbName,
    activeDbName,
    targetUri,
    sanitizedTarget: sanitizeUri(targetUri),
  };
}

/**
 * Retrieve and validate JWT configuration from environment.
 * Requires JWT_SECRET to be present and non-empty. Fallback secrets are strictly prohibited.
 *
 * @param {Object} [options]
 * @param {string} [options.secret] Override secret for testing
 * @param {string} [options.expiresIn] Override expiry for testing
 * @returns {{ secret: string, expiresIn: string, algorithm: string }}
 */
function getJwtConfig(options = {}) {
  const rawSecret = (options.secret !== undefined ? options.secret : process.env.JWT_SECRET) || '';
  const rawExpiresIn = (options.expiresIn !== undefined ? options.expiresIn : process.env.JWT_EXPIRES_IN) || '1h';

  const secret = (typeof rawSecret === 'string' ? rawSecret : String(rawSecret || '')).trim();
  const expiresIn = (typeof rawExpiresIn === 'string' ? rawExpiresIn : String(rawExpiresIn || '')).trim() || '1h';

  if (!secret) {
    const err = new Error('JWT_SECRET is required and must not be empty. Fallback secrets are strictly prohibited.');
    err.code = 'CONFIG_MISSING_JWT_SECRET';
    throw err;
  }

  return {
    secret,
    expiresIn,
    algorithm: 'HS256',
  };
}

module.exports = {
  rootEnvPath,
  extractDatabaseName,
  sanitizeUri,
  validateDatabaseConfig,
  getJwtConfig,
};
