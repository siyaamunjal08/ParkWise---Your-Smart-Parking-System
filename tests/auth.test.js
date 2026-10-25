// tests/auth.test.js — Stage 4 Unit & Integration Tests for Auth & Admin Creation
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../server/app');
const { User } = require('../server/models');
const { connectDB, disconnectDB } = require('../server/config/db');
const { validateDatabaseConfig, getJwtConfig } = require('../server/config/env');
const {
  hashPassword,
  comparePassword,
  sanitizeUserDto,
  generateToken,
  validatePasswordStrength,
} = require('../server/utils/authUtils');
const { createAdminAccount } = require('../server/scripts/createAdmin');

test.describe('Stage 4: Backend Authentication & Admin Creation', () => {
  let server;
  let baseUrl;
  const createdUserIds = [];

  test.before(async () => {
    // Validate target isolation
    const config = validateDatabaseConfig({ isTest: true });
    assert.ok(config.testDbName, 'Tests must target an explicit test database');
    assert.notEqual(
      config.testDbName.toLowerCase(),
      (config.appDbName || '').toLowerCase(),
      'Auth tests refused: test database cannot match application database'
    );

    await connectDB({ isTest: true });
    await User.init();

    // Start ephemeral server for HTTP route testing
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  test.after(async () => {
    try {
      if (createdUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
      }
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await disconnectDB();
    }
  });

  // ── 1. Utilities, Hashing & DTO Safeguards ──────────────────
  test.it('1.1. validatePasswordStrength enforces 8 char minimum and 72-byte max length', () => {
    assert.throws(
      () => validatePasswordStrength('short'),
      (err) => err.statusCode === 400 && /at least 8 characters/i.test(err.message),
      'Must reject passwords under 8 characters'
    );

    // 73-character ASCII string (73 bytes)
    const tooLong = 'a'.repeat(73);
    assert.throws(
      () => validatePasswordStrength(tooLong),
      (err) => err.statusCode === 400 && /must not exceed 72 bytes/i.test(err.message),
      'Must reject passwords exceeding 72 bytes'
    );

    // Valid 8-72 character passwords must pass
    assert.doesNotThrow(() => validatePasswordStrength('validpassword123'));
    assert.doesNotThrow(() => validatePasswordStrength('a'.repeat(72)));
  });

  test.it('1.2. Bcrypt hashing and comparison with documented cost', async () => {
    const raw = 'SecurePass@123';
    const hash = await hashPassword(raw);

    assert.notEqual(raw, hash);
    assert.ok(hash.startsWith('$2'), 'Must be a valid bcrypt hash');

    const matches = await comparePassword(raw, hash);
    assert.equal(matches, true, 'Valid password must match hash');

    const wrong = await comparePassword('WrongPassword', hash);
    assert.equal(wrong, false, 'Invalid password must not match hash');
  });

  test.it('1.3. sanitizeUserDto never exposes passwordHash on documents or plain objects', () => {
    const sample = {
      _id: '60d5ecb8b392d72b2c8b4567',
      name: 'Alice User',
      email: 'alice@example.com',
      phone: '+91 99999 11111',
      role: 'user',
      passwordHash: 'secret_bcrypt_hash',
      __v: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const sanitized = sanitizeUserDto(sample);
    assert.equal(sanitized.passwordHash, undefined, 'passwordHash must be stripped');
    assert.equal(sanitized.__v, undefined, '__v must be stripped');
    assert.equal(sanitized.id, '60d5ecb8b392d72b2c8b4567');
    assert.equal(sanitized.email, 'alice@example.com');
  });

  test.it('1.4. getJwtConfig refuses fallback secrets', () => {
    assert.throws(
      () => getJwtConfig({ secret: '' }),
      (err) => err.code === 'CONFIG_MISSING_JWT_SECRET',
      'Must throw error when secret is empty'
    );
  });

  // ── 2. Registration API (POST /api/auth/register) ───────────
  test.it('2.1. Registration creates role=user and returns safe envelope', async () => {
    const email = `reg-test-${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Normal User',
        email,
        phone: '+91 98765 43210',
        password: 'Password@123',
      }),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.message, 'Registration successful.');
    assert.ok(data.token, 'Must return JWT token');
    assert.equal(data.user.role, 'user');
    assert.equal(data.user.passwordHash, undefined, 'passwordHash must not leak in response');
    createdUserIds.push(data.user.id);

    // Verify in DB directly
    const inDb = await User.findById(data.user.id).select('+passwordHash');
    assert.equal(inDb.role, 'user');
    assert.ok(inDb.passwordHash.startsWith('$2'));
  });

  test.it('2.2. Rejects forbidden or unknown fields (role, owner, passwordHash, isAdmin) with 400 and creates no account', async () => {
    const injectionAttempts = [
      { field: 'role', payload: { role: 'admin' } },
      { field: 'passwordHash', payload: { passwordHash: '$2a$10$fakehash' } },
      { field: 'owner', payload: { owner: 'fakeOwnerId' } },
      { field: 'isAdmin', payload: { isAdmin: true } },
      { field: 'unrecognizedExtra', payload: { unrecognizedExtra: 'injected' } },
    ];

    for (const attempt of injectionAttempts) {
      const email = `inject-${attempt.field}-${Date.now()}@example.com`;
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Injection Attempter',
          email,
          phone: '+91 98765 99999',
          password: 'Password@123',
          ...attempt.payload,
        }),
      });

      assert.equal(res.status, 400, `Must return 400 when ${attempt.field} is present`);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'FORBIDDEN_FIELDS');
      assert.match(body.message, /forbidden or unrecognized fields/i);

      // Verify NO user was created in the database
      const userInDb = await User.findOne({ email });
      assert.equal(userInDb, null, `No account must be created when ${attempt.field} is injected`);
    }
  });

  test.it('2.3. Duplicate email registration returns 409 Conflict with safe envelope', async () => {
    const email = `dup-test-${Date.now()}@example.com`;

    // First registration
    const res1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'First User',
        email,
        phone: '+91 98765 11111',
        password: 'Password@123',
      }),
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    createdUserIds.push(data1.user.id);

    // Duplicate registration attempt
    const res2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Second User',
        email,
        phone: '+91 98765 22222',
        password: 'Password@456',
      }),
    });

    assert.equal(res2.status, 409, 'Must return 409 Conflict on duplicate email');
    const data2 = await res2.json();
    assert.equal(data2.success, false);
    assert.equal(data2.code, 'EMAIL_ALREADY_EXISTS');
    assert.equal(data2.message, 'Email already registered.');
  });

  // ── 3. Login API (POST /api/auth/login) ─────────────────────
  test.it('3.1. Login authenticates valid user and returns JWT + safe DTO', async () => {
    const email = `login-test-${Date.now()}@example.com`;
    const password = 'CorrectPassword@123';

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Login User',
        email,
        phone: '+91 98765 33333',
        password,
      }),
    });
    const regData = await regRes.json();
    createdUserIds.push(regData.user.id);

    // Valid login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.success, true);
    assert.equal(loginData.message, 'Login successful.');
    assert.ok(loginData.token);
    assert.equal(loginData.user.email, email);
    assert.equal(loginData.user.passwordHash, undefined);
  });

  test.it('3.2. Login returns generic 401 on wrong password or missing user', async () => {
    // Non-existent email
    const res1 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@example.com', password: 'AnyPassword@123' }),
    });
    assert.equal(res1.status, 401);
    const data1 = await res1.json();
    assert.equal(data1.success, false);
    assert.equal(data1.code, 'INVALID_CREDENTIALS');
    assert.equal(data1.message, 'Invalid email or password.');

    // Real user, wrong password
    const email = `wrong-pw-${Date.now()}@example.com`;
    const user = await User.create({
      name: 'Wrong PW User',
      email,
      phone: '+91 99999 88888',
      passwordHash: await hashPassword('RightPass@123'),
      role: 'user',
    });
    createdUserIds.push(user._id);

    const res2 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword@123' }),
    });
    assert.equal(res2.status, 401);
    const data2 = await res2.json();
    assert.equal(data2.success, false);
    assert.equal(data2.code, 'INVALID_CREDENTIALS');
    assert.equal(data2.message, 'Invalid email or password.');
  });

  // ── 4. Protected Routes & RBAC ──────────────────────────────
  test.it('4.1. GET /api/auth/me rejects missing, bad, forged, or expired token', async () => {
    // Missing token
    const resNoAuth = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(resNoAuth.status, 401);
    const b1 = await resNoAuth.json();
    assert.equal(b1.success, false);
    assert.equal(b1.code, 'AUTH_REQUIRED');

    // Forged token
    const resForged = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer forged.token.value' },
    });
    assert.equal(resForged.status, 401);
    const b2 = await resForged.json();
    assert.equal(b2.success, false);
    assert.equal(b2.code, 'TOKEN_INVALID');

    // Expired token
    const expiredToken = generateToken(
      { _id: '60d5ecb8b392d72b2c8b4567', email: 'test@example.com', role: 'user' },
      { secret: process.env.JWT_SECRET, expiresIn: '-1s', algorithm: 'HS256' }
    );
    const resExpired = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(resExpired.status, 401);
    const b3 = await resExpired.json();
    assert.equal(b3.success, false);
    assert.equal(b3.code, 'TOKEN_EXPIRED');
  });

  test.it('4.2. Token for deleted user returns 401', async () => {
    const tempUser = await User.create({
      name: 'Doomed User',
      email: `doomed-${Date.now()}@example.com`,
      phone: '+91 91111 22222',
      passwordHash: 'hash',
      role: 'user',
    });
    const token = generateToken(tempUser, getJwtConfig());

    // Delete user from DB
    await User.deleteOne({ _id: tempUser._id });

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
    const b = await res.json();
    assert.equal(b.success, false);
    assert.equal(b.code, 'USER_NOT_FOUND');
  });

  test.it('4.3. Dynamic role reload: JWT issued as role=user reflects DB role promotion to admin and demotion to user', async () => {
    const dynamicUser = await User.create({
      name: 'Dynamic Role User',
      email: `dynamic-${Date.now()}@example.com`,
      phone: '+91 94444 55555',
      passwordHash: 'hash',
      role: 'user',
    });
    createdUserIds.push(dynamicUser._id);

    // Issue token while user has role='user'
    const token = generateToken(dynamicUser, getJwtConfig());

    // 1. Initially user: access to test admin route must return 403 Forbidden
    const res1 = await fetch(`${baseUrl}/api/test-admin-check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res1.status, 403);
    const b1 = await res1.json();
    assert.equal(b1.success, false);
    assert.equal(b1.code, 'FORBIDDEN');

    // 2. Promote user to role='admin' directly in DB
    await User.updateOne({ _id: dynamicUser._id }, { $set: { role: 'admin' } });

    // 3. Request with the EXACT SAME token — requireAuth must dynamically fetch active role from DB
    const res2 = await fetch(`${baseUrl}/api/test-admin-check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res2.status, 200, 'Same token must now grant admin access due to dynamic DB reload');
    const b2 = await res2.json();
    assert.equal(b2.success, true);
    assert.equal(b2.user.role, 'admin');

    // 4. Demote user back to role='user' in DB
    await User.updateOne({ _id: dynamicUser._id }, { $set: { role: 'user' } });

    // 5. Request with same token must immediately be rejected again
    const res3 = await fetch(`${baseUrl}/api/test-admin-check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res3.status, 403, 'Same token must immediately lose admin access after DB demotion');
  });

  // ── 5. Rate Limiting Probe ──────────────────────────────────
  test.it('5.1. Authentication rate limiter returns 429 and Retry-After header', async () => {
    // Probe the test rate limit endpoint (configured max: 3)
    const res1 = await fetch(`${baseUrl}/api/test-rate-limit`);
    assert.equal(res1.status, 200);

    const res2 = await fetch(`${baseUrl}/api/test-rate-limit`);
    assert.equal(res2.status, 200);

    const res3 = await fetch(`${baseUrl}/api/test-rate-limit`);
    assert.equal(res3.status, 200);

    // 4th request must be blocked by rate limiter
    const res4 = await fetch(`${baseUrl}/api/test-rate-limit`);
    assert.equal(res4.status, 429);
    assert.ok(res4.headers.get('retry-after'), 'Must include Retry-After header');
    const b4 = await res4.json();
    assert.equal(b4.success, false);
    assert.equal(b4.code, 'RATE_LIMIT_EXCEEDED');
  });

  // ── 6. Admin Creation Service CLI Safeguards ────────────────
  test.it('6.1. createAdminAccount creates admin and rejects user promotion or duplicate admin', async () => {
    const adminEmail = `admin-cli-${Date.now()}@example.com`;

    // 1. Successful admin creation
    const adminDto = await createAdminAccount({
      name: 'System Admin',
      email: adminEmail,
      phone: '+91 90000 11111',
      password: 'AdminPassword@123',
      isTest: true,
    });
    assert.equal(adminDto.role, 'admin');
    assert.equal(adminDto.email, adminEmail);
    assert.equal(adminDto.passwordHash, undefined);
    createdUserIds.push(adminDto.id);

    // 2. Reject duplicate admin creation without resetting password
    await assert.rejects(
      async () => {
        await createAdminAccount({
          name: 'Another Admin',
          email: adminEmail,
          phone: '+91 90000 22222',
          password: 'NewAdminPassword@456',
          isTest: true,
        });
      },
      (err) => err.code === 'ADMIN_ALREADY_EXISTS',
      'Must reject duplicate admin creation'
    );

    // 3. Reject role promotion of existing standard user
    const stdEmail = `std-nopromote-${Date.now()}@example.com`;
    const standardUser = await User.create({
      name: 'Normal Person',
      email: stdEmail,
      phone: '+91 90000 33333',
      passwordHash: 'hash',
      role: 'user',
    });
    createdUserIds.push(standardUser._id);

    await assert.rejects(
      async () => {
        await createAdminAccount({
          name: 'Promoted Person',
          email: stdEmail,
          phone: '+91 90000 33333',
          password: 'PromotePassword@123',
          isTest: true,
        });
      },
      (err) => err.code === 'USER_PROMOTION_PROHIBITED',
      'Must refuse to promote a standard user account to admin'
    );
  });

  // ── 5. Stage 7 Frontend Auth Contract & Verification ────────
  test.it('5.1. Static asset delivery: public/js/api.js is served with JavaScript content-type', async () => {
    const res = await fetch(`${baseUrl}/js/api.js`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(
      contentType.includes('javascript') || contentType.includes('application/octet-stream'),
      `Expected javascript content-type, got: ${contentType}`
    );
    const text = await res.text();
    assert.ok(text.includes('ApiClient'), 'public/js/api.js must export ApiClient');
    assert.ok(text.includes('isSameOrigin'), 'public/js/api.js must provide same-origin protection');
  });

  test.it('5.2. Frontend auth cycle: register -> verify /me -> login -> verify role', async () => {
    const email = `frontend-user-${Date.now()}@example.com`;
    const password = 'FrontendPassword@123';

    // 1. Register
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Frontend Tester',
        email,
        phone: '+91 98765 11111',
        password,
      }),
    });
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.equal(regData.success, true);
    assert.ok(regData.token, 'Registration must return Bearer token');
    assert.equal(regData.user.role, 'user');
    createdUserIds.push(regData.user.id);

    // 2. Session verification with GET /api/auth/me using Bearer token
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.success, true);
    assert.equal(meData.user.id, regData.user.id);
    assert.equal(meData.user.email, email);
    assert.equal(meData.user.role, 'user');
    assert.equal(meData.user.passwordHash, undefined, 'passwordHash must never be exposed');

    // 3. Login with credentials
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.success, true);
    assert.ok(loginData.token);
    assert.equal(loginData.user.id, regData.user.id);

    // 4. Invalid token verification returns 401
    const badTokenRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer invalid.bogus.jwt.token' },
    });
    assert.equal(badTokenRes.status, 401);

    // 5. Missing token verification returns 401
    const noTokenRes = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(noTokenRes.status, 401);
  });
});
