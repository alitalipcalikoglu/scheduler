import { ConfigError, EnvReader, parseApiKeys, parseAudit, parseTarget } from '@atc-web/service-core/config';
import { CronExpression } from './domain/cron.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.apiKeys = v.apiKeys;
    this.signingSecret = v.signingSecret;
    this.targetKeys = v.targetKeys;
    this.targetAllowHttp = v.targetAllowHttp;
    this.targetAllowPrivate = v.targetAllowPrivate;
    this.targetAllowedHosts = v.targetAllowedHosts;
    this.defaultTimezone = v.defaultTimezone;
    this.workerConcurrency = v.workerConcurrency;
    this.pollMs = v.pollMs;
    this.defaultTimeoutMs = v.defaultTimeoutMs;
    this.maxTimeoutMs = v.maxTimeoutMs;
    this.maxRetries = v.maxRetries;
    this.maxBackoffSec = v.maxBackoffSec;
    this.maxBodyBytes = v.maxBodyBytes;
    this.runRetentionDays = v.runRetentionDays;
    this.rateLimitMax = v.rateLimitMax;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const signingSecret = r.required('SIGNING_SECRET');
    if (signingSecret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`SIGNING_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);

    const target = parseTarget(r);

    const defaultTimezone = r.optional('DEFAULT_TIMEZONE') || 'UTC';
    if (!CronExpression.isTimezone(defaultTimezone)) throw new ConfigError(`DEFAULT_TIMEZONE "${defaultTimezone}" is not a known IANA timezone`);

    const defaultTimeoutMs = r.integer('DEFAULT_TIMEOUT_MS', 30_000, { min: 1_000 });
    const maxTimeoutMs = r.integer('MAX_TIMEOUT_MS', 60_000, { min: 1_000 });
    if (defaultTimeoutMs > maxTimeoutMs) throw new ConfigError('DEFAULT_TIMEOUT_MS must be <= MAX_TIMEOUT_MS');

    return new Config({
      port: r.integer('PORT', 3008, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/scheduler.db',
      apiKeys: Config.#parseApiKeys(r.required('SCHEDULER_API_KEYS')),
      signingSecret,
      targetKeys: Config.#parseTargetKeys(r.optional('TARGET_KEYS')),
      targetAllowHttp: target.allowHttp,
      targetAllowPrivate: target.allowPrivate,
      targetAllowedHosts: target.allowedHosts,
      defaultTimezone,
      workerConcurrency: r.integer('WORKER_CONCURRENCY', 8, { min: 1, max: 64 }),
      pollMs: r.integer('POLL_MS', 1_000, { min: 100, max: 60_000 }),
      defaultTimeoutMs,
      maxTimeoutMs,
      maxRetries: r.integer('MAX_RETRIES', 10, { min: 0, max: 100 }),
      maxBackoffSec: r.integer('MAX_BACKOFF_SEC', 3_600, { min: 1 }),
      maxBodyBytes: r.integer('MAX_BODY_BYTES', 16_384, { min: 64 }),
      runRetentionDays: r.integer('RUN_RETENTION_DAYS', 30, { min: 1 }),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
    });
  }

  /**
   * Parse `id:secret[:role]`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'SCHEDULER_API_KEYS', { roles: ['read', 'write', 'readwrite'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }

  /**
   * Parse `name:secret,…`: bearer tokens for the services jobs call. A job names one; the secret
   * itself never leaves the process environment.
   * @param {string} raw
   */
  static #parseTargetKeys(raw) {
    /** @type {Map<string, string>} */
    const keys = new Map();
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = entry.indexOf(':');
      const name = i === -1 ? entry : entry.slice(0, i);
      const secret = i === -1 ? '' : entry.slice(i + 1);
      if (!Config.ID_PATTERN.test(name)) throw new ConfigError(`TARGET_KEYS name "${name}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < 16) throw new ConfigError(`TARGET_KEYS secret for "${name}" must be at least 16 characters`);
      if (keys.has(name)) throw new ConfigError(`TARGET_KEYS name "${name}" is listed twice`);
      keys.set(name, secret);
    }
    return keys;
  }
}
