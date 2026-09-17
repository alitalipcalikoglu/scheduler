import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { FLAGS_TOKEN, testEnv } from './helpers.js';

test('Config: defaults, key roles, target keys', () => {
  const c = Config.fromEnv(testEnv());
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['console', 'readwrite'], ['dashboard', 'read'], ['deployer', 'write']]);
  assert.deepEqual([...c.targetKeys], [['flags', FLAGS_TOKEN]]);
  assert.equal(c.defaultTimezone, 'UTC');
  assert.equal(c.workerConcurrency, 8);
  assert.equal(c.defaultTimeoutMs, 30_000);
  assert.deepEqual(c.targetAllowedHosts, ['127.0.0.1', 'api.example']);
  assert.ok(Object.isFrozen(c));
  assert.equal(Config.fromEnv(testEnv({ TARGET_KEYS: '' })).targetKeys.size, 0);
  assert.equal(Config.fromEnv(testEnv({ DEFAULT_TIMEZONE: 'Europe/Istanbul' })).defaultTimezone, 'Europe/Istanbul');
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ SCHEDULER_API_KEYS: '' }, /SCHEDULER_API_KEYS is required/);
  bad({ SCHEDULER_API_KEYS: 'a:short' }, /at least 32/);
  bad({ SCHEDULER_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write or readwrite/);
  bad({ SIGNING_SECRET: 'short' }, /SIGNING_SECRET must be at least 32/);
  bad({ TARGET_KEYS: 'flags' }, /at least 16/);
  bad({ TARGET_KEYS: `flags:${'x'.repeat(20)},flags:${'y'.repeat(20)}` }, /listed twice/);
  bad({ TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '' }, /TARGET_ALLOWED_HOSTS is required/);
  bad({ DEFAULT_TIMEZONE: 'Mars/Olympus' }, /not a known IANA timezone/);
  bad({ DEFAULT_TIMEOUT_MS: '90000', MAX_TIMEOUT_MS: '60000' }, /DEFAULT_TIMEOUT_MS must be <= MAX_TIMEOUT_MS/);
  bad({ WORKER_CONCURRENCY: '0' }, />= 1/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
});

test('Config: 0 < HEARTBEAT_MS < LEASE_MS invariant (Stage 6.2)', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ HEARTBEAT_MS: '5000', LEASE_MS: '5000' }, /HEARTBEAT_MS must be less than LEASE_MS/);
  bad({ HEARTBEAT_MS: '6000', LEASE_MS: '5000' }, /HEARTBEAT_MS must be less than LEASE_MS/);
  bad({ HEARTBEAT_MS: '0' }, /HEARTBEAT_MS must be >= 250/);
  bad({ LEASE_MS: '0' }, /LEASE_MS must be >= 2000/);
  const c = Config.fromEnv(testEnv({ HEARTBEAT_MS: '1000', LEASE_MS: '5000' }));
  assert.equal(c.heartbeatMs, 1_000);
  assert.equal(c.leaseMs, 5_000);
});

test('Config: externalCallCeilingMs < drainMs < forceExitMs across the whole MAX_TIMEOUT_MS range (Stage 6.2)', () => {
  for (const maxTimeoutMs of [1_000, 60_000, 600_000]) {
    const c = Config.fromEnv(testEnv({ DEFAULT_TIMEOUT_MS: String(Math.min(1_000, maxTimeoutMs)), MAX_TIMEOUT_MS: String(maxTimeoutMs) }));
    assert.equal(c.externalCallCeilingMs, maxTimeoutMs);
    assert.equal(c.drainMs, maxTimeoutMs + 5_000);
    assert.equal(c.forceExitMs, maxTimeoutMs + 10_000);
    assert.ok(c.externalCallCeilingMs < c.drainMs && c.drainMs < c.forceExitMs);
  }
});
