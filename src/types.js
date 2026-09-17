/**
 * Shared JSDoc typedefs for the scheduler service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {string} signingSecret
 * @property {Map<string, string>} targetKeys     Named bearer tokens jobs may reference; never stored or returned.
 * @property {boolean} targetAllowHttp
 * @property {boolean} targetAllowPrivate
 * @property {string[]} targetAllowedHosts
 * @property {string} defaultTimezone
 * @property {number} workerConcurrency
 * @property {number} pollMs
 * @property {number} defaultTimeoutMs
 * @property {number} maxTimeoutMs
 * @property {number} maxRetries
 * @property {number} maxBackoffSec
 * @property {number} maxBodyBytes
 * @property {number} runRetentionDays
 * @property {number} rateLimitMax
 * @property {number} leaseMs          How long a claimed run's lease lasts without a heartbeat.
 * @property {number} heartbeatMs      How often an in-flight run's lease is renewed; must be < leaseMs.
 */

/** @typedef {import('./config.js').Config} Config */

/**
 * When a job fires: a cron expression in a timezone, or a single instant.
 * @typedef {{ cron: string, timezone: string }|{ at: string }} Schedule
 */

/** @typedef {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} HttpMethod */

/**
 * The HTTP call a job makes. `body` is any JSON value, sent as `application/json`.
 * @typedef {object} Target
 * @property {string} url
 * @property {HttpMethod} method
 * @property {Record<string, string>} headers   Extra `X-*` headers.
 * @property {unknown} [body]
 */

/**
 * @typedef {object} RetryPolicy
 * @property {number} max         Retries after the first attempt (0 = none).
 * @property {number} backoffSec  First delay; doubles per retry, capped by `MAX_BACKOFF_SEC`.
 */

/**
 * @typedef {object} JobRow
 * @property {string} name
 * @property {string} description
 * @property {string} tags          JSON array.
 * @property {number} enabled
 * @property {string} schedule      JSON {@link Schedule}.
 * @property {string} target        JSON {@link Target}.
 * @property {string|null} target_key
 * @property {number} timeout_ms
 * @property {string} retry         JSON {@link RetryPolicy}.
 * @property {number|null} next_run_at
 * @property {number|null} last_run_at
 * @property {string|null} last_status
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/** @typedef {'pending'|'running'|'retrying'|'succeeded'|'failed'|'skipped'|'cancelled'} RunStatus */

/**
 * One firing of a job, through every attempt.
 * @typedef {object} RunRow
 * @property {number} id
 * @property {string} job_name
 * @property {'schedule'|'manual'} trigger
 * @property {RunStatus} status
 * @property {number} scheduled_for
 * @property {number} attempt          Attempts started so far.
 * @property {number} max_attempts
 * @property {number|null} next_attempt_at
 * @property {number|null} started_at
 * @property {number|null} finished_at
 * @property {number|null} duration_ms
 * @property {number|null} http_status
 * @property {string|null} response    First bytes of the last response body.
 * @property {string|null} error
 * @property {string} attempts         JSON array of {@link Attempt}.
 * @property {number} created_at
 * @property {string|null} owner_token The fencing token of whoever currently holds the lease; null when not `running`.
 * @property {number|null} lease_until ms since epoch; null when not `running` (or a pre-Stage-6 leftover row).
 */

/**
 * The shape {@link import('./store/run-store.js').RunStore#finish} takes — an attempt's outcome
 * already reduced to a terminal or retrying decision.
 * @typedef {object} FinishOutcome
 * @property {'succeeded'|'retrying'|'failed'} status
 * @property {number|null} finishedAt
 * @property {number} durationMs
 * @property {number|null} httpStatus
 * @property {string|null} response
 * @property {string|null} error
 * @property {Attempt[]} attempts
 * @property {number|null} nextAttemptAt
 */

/**
 * @typedef {object} Attempt
 * @property {number} n
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {number|null} httpStatus
 * @property {string|null} error
 */

/**
 * Result of one HTTP attempt.
 * @typedef {object} CallResult
 * @property {number} httpStatus
 * @property {string} response
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

/**
 * The subset of a logger every non-HTTP consumer (`Worker`, `Lifecycle`) actually needs —
 * satisfied both by a real Fastify/pino logger and by `ConsoleLogger` (used when there is no
 * Fastify instance to log through, i.e. the worker-only role).
 * @typedef {object} MinimalLogger
 * @property {(o: object|string, m?: string) => void} info
 * @property {(o: object|string, m?: string) => void} warn
 * @property {(o: object|string, m?: string) => void} error
 * @property {(o: object|string, m?: string) => void} fatal
 * @property {(o: object|string, m?: string) => void} debug
 * @property {(o: object|string, m?: string) => void} trace
 * @property {(bindings: object) => MinimalLogger} child
 */

export {};
