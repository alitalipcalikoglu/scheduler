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
