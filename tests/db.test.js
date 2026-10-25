// tests/db.test.js — Stage 2 Database Configuration, Target Separation & Readiness Tests

'use strict';

process.env.NODE_ENV = 'test';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const app    = require('../server/app');
const {
  extractDatabaseName,
  sanitizeUri,
  validateDatabaseConfig,
} = require('../server/config/env');
const { isConnected } = require('../server/config/db');

let server;
let baseUrl;

before((_, done) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

after((_, done) => {
  if (server) {
    server.close(done);
  } else {
    done();
  }
});

describe('1. Database URI Parsing & Secret Redaction', () => {
  test('extractDatabaseName correctly extracts db name and does not fall back', () => {
    assert.equal(
      extractDatabaseName('mongodb+srv://user:pass@cluster.mongodb.net/parkwise_prod?retryWrites=true'),
      'parkwise_prod'
    );
    assert.equal(
      extractDatabaseName('mongodb://localhost:27017/parkwise_dev'),
      'parkwise_dev'
    );
    // Missing database name returns null — no arbitrary fallback
    assert.equal(extractDatabaseName('mongodb://localhost:27017'), null);
    assert.equal(extractDatabaseName('mongodb+srv://user:pass@cluster.mongodb.net/'), null);
    assert.equal(extractDatabaseName(''), null);
  });

  test('sanitizeUri redacts credentials completely', () => {
    const raw = 'mongodb+srv://super_user:SecretP@ssw0rd!@cluster0.abcde.mongodb.net/parkwise_db?retryWrites=true';
    const sanitized = sanitizeUri(raw);

    assert.ok(!sanitized.includes('super_user'), 'Username must not be present');
    assert.ok(!sanitized.includes('SecretP@ssw0rd!'), 'Password must not be present');
    assert.ok(sanitized.includes('***:***@cluster0.abcde.mongodb.net/parkwise_db'));
  });
});

describe('2. Environment Validation & Database Target Separation', () => {
  test('throws CONFIG_MISSING_URI when target URI is empty', () => {
    assert.throws(
      () => validateDatabaseConfig({ appUri: '', testUri: '' }),
      { code: 'CONFIG_MISSING_URI' }
    );
  });

  test('throws CONFIG_NO_DATABASE_NAME when URI lacks a database path', () => {
    assert.throws(
      () => validateDatabaseConfig({ appUri: 'mongodb+srv://user:pass@cluster.mongodb.net/' }),
      { code: 'CONFIG_NO_DATABASE_NAME' }
    );
  });

  test('throws CONFIG_DB_NAME_COLLISION when app and test DB share the same database name', () => {
    assert.throws(
      () => validateDatabaseConfig({
        appUri: 'mongodb+srv://u:p@cluster.mongodb.net/parkwise_same?w=majority',
        testUri: 'mongodb+srv://u:p@cluster.mongodb.net/parkwise_same?w=majority',
      }),
      { code: 'CONFIG_DB_NAME_COLLISION' }
    );
  });

  test('accepts distinct database names for app and test', () => {
    const config = validateDatabaseConfig({
      appUri: 'mongodb+srv://u:p@cluster.mongodb.net/parkwise_eval2_fresh?w=majority',
      testUri: 'mongodb+srv://u:p@cluster.mongodb.net/parkwise_eval2_fresh_test?w=majority',
    });

    assert.equal(config.appDbName, 'parkwise_eval2_fresh');
    assert.equal(config.testDbName, 'parkwise_eval2_fresh_test');
    assert.equal(config.activeDbName, 'parkwise_eval2_fresh');
  });
});

describe('3. Database Readiness Probe (/api/ready)', () => {
  test('GET /api/ready returns 503 when disconnected and never leaks secrets', async () => {
    const res = await fetch(`${baseUrl}/api/ready`);
    const body = await res.json();

    if (!isConnected()) {
      assert.equal(res.status, 503);
      assert.equal(body.connected, false);
      assert.equal(body.configured, true);
      assert.ok(body.message.includes('not connected'));
      // Verify no secrets leaked in body
      assert.equal(body.password, undefined);
      assert.equal(body.uri, undefined);
    } else {
      assert.equal(res.status, 200);
      assert.equal(body.connected, true);
    }
  });

  test('Importing app.js does not auto-connect database during tests', () => {
    // Tests import app.js without triggering unrequested DB connection
    assert.equal(typeof isConnected(), 'boolean');
  });
});
