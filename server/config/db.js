// server/config/db.js — Mongoose connection lifecycle & connectivity verification

'use strict';

const mongoose = require('mongoose');
const { validateDatabaseConfig, sanitizeUri } = require('./env');

const CONNECTION_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
};

// ── Lifecycle Event Listeners ────────────────────────────────
mongoose.connection.on('connected', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[Database] Mongoose connected to database "${mongoose.connection.name}".`);
  }
});

mongoose.connection.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[Database Error] Connection error: ${err.message}`);
  }
});

mongoose.connection.on('disconnected', () => {
  if (process.env.NODE_ENV !== 'test') {
    console.log('[Database] Mongoose disconnected.');
  }
});

/**
 * Connect Mongoose to the application database or test database.
 * Used during server startup or test execution.
 *
 * @param {string|Object} [options] Optional URI override string or options object
 * @param {boolean} [options.isTest=false] Whether to connect to test database
 * @param {string} [options.uri] Optional URI override
 * @returns {Promise<mongoose.Connection>}
 */
async function connectDB(options = {}) {
  let isTest = false;
  let customUri = null;

  if (typeof options === 'string') {
    customUri = options;
  } else if (typeof options === 'object' && options !== null) {
    isTest = Boolean(options.isTest);
    customUri = options.uri || options.appUri || null;
  }

  const config = validateDatabaseConfig({
    appUri: isTest ? undefined : (customUri || undefined),
    testUri: isTest ? (customUri || undefined) : undefined,
    isTest: isTest || process.env.NODE_ENV === 'test',
  });

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(config.targetUri, CONNECTION_OPTIONS);
  return mongoose.connection;
}

/**
 * Gracefully disconnect Mongoose.
 * @returns {Promise<void>}
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Return whether Mongoose currently has an active, ready connection.
 * @returns {boolean}
 */
function isConnected() {
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

/**
 * Return the connected database name, or null if disconnected.
 * @returns {string|null}
 */
function getActiveDatabaseName() {
  return isConnected() ? mongoose.connection.name : null;
}

/**
 * Read-only connectivity probe for db:check and db:check:test.
 * Connects temporarily, tests ping and transaction capability, then disconnects.
 * Strictly read-only: does not insert, delete, seed, or modify any collections.
 *
 * @param {Object} options
 * @param {boolean} [options.isTest=false]
 * @returns {Promise<{ ok: boolean, database: string, supportsTransactions: boolean, sanitizedUri: string }>}
 */
async function inspectConnectivity(options = {}) {
  const isTest = Boolean(options.isTest);
  const config = validateDatabaseConfig({ isTest });

  // Disconnect any existing connection before isolated probe
  await disconnectDB();

  try {
    await mongoose.connect(config.targetUri, CONNECTION_OPTIONS);
    const db = mongoose.connection.db;

    // 1. Read-only ping to verify database server responsiveness
    await db.admin().ping();

    // 2. Read-only hello/isMaster command to safely detect replica set & transaction support
    let supportsTransactions = false;
    try {
      const helloResult = await db.admin().command({ hello: 1 });
      // MongoDB transactions require replica sets (setName defined) or sharded clusters (msg === 'isdbgrid')
      supportsTransactions = Boolean(helloResult.setName || helloResult.msg === 'isdbgrid');
    } catch {
      // If hello fails (older server), check isMaster
      const isMasterResult = await db.admin().command({ isMaster: 1 });
      supportsTransactions = Boolean(isMasterResult.setName || isMasterResult.msg === 'isdbgrid');
    }

    const report = {
      ok: true,
      database: mongoose.connection.name,
      supportsTransactions,
      sanitizedUri: config.sanitizedTarget,
    };

    return report;
  } finally {
    await disconnectDB();
  }
}

module.exports = {
  connectDB,
  disconnectDB,
  isConnected,
  getActiveDatabaseName,
  inspectConnectivity,
  CONNECTION_OPTIONS,
};
