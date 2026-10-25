// server/scripts/checkDb.js — Safe, read-only connectivity check CLI
// Invoked via npm run db:check or npm run db:check:test

'use strict';

const { inspectConnectivity } = require('../config/db');

async function runCheck() {
  const isTest = process.argv.includes('--test');
  const targetLabel = isTest ? 'Test Database (TEST_MONGODB_URI)' : 'Application Database (MONGODB_URI)';

  console.log(`[Database Check] Initiating read-only probe for ${targetLabel}...`);

  try {
    const report = await inspectConnectivity({ isTest });

    console.log(`[Database Check] ✅ Connectivity Status: Connected successfully`);
    console.log(`[Database Check] Target Database: "${report.database}"`);
    console.log(`[Database Check] Target URI: ${report.sanitizedUri}`);
    console.log(`[Database Check] Transactions Supported: ${report.supportsTransactions ? 'Yes (Replica Set / Sharded)' : 'No (Standalone)'}`);
    console.log(`[Database Check] Read-only verification completed. Zero mutations performed.`);
    process.exit(0);
  } catch (err) {
    // Redact any potential credentials from the error message
    const sanitizedMessage = (err.message || 'Unknown database error')
      .replace(/mongodb(?:\+srv)?:\/\/[^@]+@/gi, 'mongodb+srv://***:***@');

    console.error(`[Database Check] ❌ Connectivity Status: Connection failed`);
    console.error(`[Database Check] Reason: ${sanitizedMessage}`);
    process.exit(1);
  }
}

runCheck();
