// server/scripts/createAdmin.js — Interactive Admin Account Creation CLI
'use strict';

const readline = require('readline');
const { Writable } = require('stream');
const { connectDB, disconnectDB } = require('../config/db');
const { User } = require('../models');
const {
  hashPassword,
  validatePasswordStrength,
  sanitizeUserDto,
} = require('../utils/authUtils');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9+\-\s()]{7,20}$/;

/**
 * Underlying service function to create an admin account.
 * Rejects blank/weak inputs, role promotion of existing users, and duplicate admins.
 *
 * @param {Object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {string} params.phone
 * @param {string} params.password
 * @param {boolean} [params.isTest=false]
 * @returns {Promise<Object>} Sanitized admin user DTO
 */
async function createAdminAccount({ name, email, phone, password, isTest = false }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    const err = new Error('Admin name must be between 2 and 100 characters');
    err.code = 'INVALID_NAME';
    throw err;
  }

  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    const err = new Error('A valid email address is required');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  if (!phone || typeof phone !== 'string' || !PHONE_REGEX.test(phone.trim())) {
    const err = new Error('A valid contact phone number is required');
    err.code = 'INVALID_PHONE';
    throw err;
  }

  // Enforces min 8 characters and max 72 bytes for bcrypt compatibility
  validatePasswordStrength(password);

  const normalizedEmail = email.trim().toLowerCase();

  // Safeguard: Check if account already exists
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    if (existingUser.role === 'admin') {
      const err = new Error(`An admin account with email "${normalizedEmail}" already exists. Password was not reset.`);
      err.code = 'ADMIN_ALREADY_EXISTS';
      throw err;
    } else {
      const err = new Error(
        `User "${normalizedEmail}" already exists as a standard user. Public or automatic role promotion is prohibited.`
      );
      err.code = 'USER_PROMOTION_PROHIBITED';
      throw err;
    }
  }

  // Hash password with documented bcrypt cost factor (10 rounds)
  const passwordHash = await hashPassword(password);

  const adminUser = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    phone: phone.trim(),
    passwordHash,
    role: 'admin',
  });

  return sanitizeUserDto(adminUser);
}

/**
 * Prompts the user with masked input on the terminal.
 * Never echoes entered passwords to stdout.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
function promptHidden(query) {
  return new Promise((resolve) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });

    process.stdout.write(query);
    muted = true;

    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Standard visible terminal prompt.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
function promptText(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// CLI interactive execution
if (require.main === module) {
  (async () => {
    // Prohibit passing passwords via command line arguments
    const forbiddenArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
    if (forbiddenArgs.length > 0) {
      console.error('[Admin Creation] ❌ Error: Passing credentials via command-line arguments is prohibited.');
      console.error('[Admin Creation] Run "npm run admin:create" interactively.');
      process.exit(1);
    }

    const isTest = process.argv.includes('--test');

    console.log('==================================================');
    console.log('  ParkWise — Interactive Admin Account Creation   ');
    console.log('==================================================');
    console.log(`Target: ${isTest ? 'TEST Database' : 'APPLICATION Database'}\n`);

    try {
      const name = await promptText('Enter Admin Full Name: ');
      const email = await promptText('Enter Admin Email: ');
      const phone = await promptText('Enter Admin Contact Phone: ');
      const password = await promptHidden('Enter Admin Password (hidden, min 8 chars): ');

      if (!password) {
        console.error('\n[Admin Creation] ❌ Error: Password cannot be blank.');
        process.exit(1);
      }

      console.log('\n[Admin Creation] Connecting to database...');
      await connectDB({ isTest });

      console.log('[Admin Creation] Verifying constraints and hashing credentials...');
      const adminDto = await createAdminAccount({ name, email, phone, password, isTest });

      console.log(`[Admin Creation] ✅ Success! Admin account created.`);
      console.log(`[Admin Creation] Name:  ${adminDto.name}`);
      console.log(`[Admin Creation] Email: ${adminDto.email}`);
      console.log(`[Admin Creation] Role:  ${adminDto.role}`);
      console.log(`[Admin Creation] ID:    ${adminDto.id}`);

      await disconnectDB();
      process.exit(0);
    } catch (err) {
      console.error(`\n[Admin Creation] ❌ Failed: ${err.message}`);
      try {
        await disconnectDB();
      } catch (_) {}
      process.exit(1);
    }
  })();
}

module.exports = {
  createAdminAccount,
};
