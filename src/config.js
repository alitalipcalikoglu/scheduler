import { CronExpression } from './domain/cron.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

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

    const targetAllowPrivate = r.boolean('TARGET_ALLOW_PRIVATE', false);
    const targetAllowedHosts = r.list('TARGET_ALLOWED_HOSTS').map((h) => h.toLowerCase());
    if (targetAllowPrivate && targetAllowedHosts.length === 0) throw new ConfigError('TARGET_ALLOWED_HOSTS is required when TARGET_ALLOW_PRIVATE is true');

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
      audit: Config.#parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/scheduler.db',
      apiKeys: Config.#parseApiKeys(r.required('SCHEDULER_API_KEYS')),
      signingSecret,
      targetKeys: Config.#parseTargetKeys(r.optional('TARGET_KEYS')),
      targetAllowHttp: r.boolean('TARGET_ALLOW_HTTP', false),
      targetAllowPrivate,
      targetAllowedHosts,
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
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) throw new ConfigError(`SCHEDULER_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret[:role]`);
      const [id, secret, role = 'readwrite'] = parts;
      if (!Config.ID_PATTERN.test(id)) throw new ConfigError(`SCHEDULER_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`SCHEDULER_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      if (role !== 'read' && role !== 'write' && role !== 'readwrite') throw new ConfigError(`SCHEDULER_API_KEYS role for "${id}" must be read, write or readwrite`);
      return { id, secret, role: /** @type {KeyRole} */ (role) };
    });
    if (keys.length === 0) throw new ConfigError('SCHEDULER_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('SCHEDULER_API_KEYS ids must be unique');
    if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError('SCHEDULER_API_KEYS secrets must be unique');
    return keys;
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
  /**
   * `AUDIT_URL` + `AUDIT_API_KEY`: both or neither. Empty = audit events are not forwarded.
   * @param {EnvReader} r
   */
  static #parseAudit(r) {
    const url = r.optional('AUDIT_URL').replace(/\/+$/, '');
    const apiKey = r.optional('AUDIT_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('AUDIT_URL and AUDIT_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('AUDIT_URL must be an absolute http(s) URL');
    if (apiKey.length < 32) throw new ConfigError('AUDIT_API_KEY must be at least 32 characters');
    return { url, apiKey };
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /** Comma-separated list. @param {string} name */
  list(name) {
    return this.optional(name).split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
