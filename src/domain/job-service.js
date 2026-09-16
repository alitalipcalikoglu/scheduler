import { CronExpression } from './cron.js';
import { SchedulerError } from './errors.js';
import { ScheduleRule } from './schedule.js';

/** @typedef {import('../types.js').JobRow} JobRow */
/** @typedef {import('../types.js').RunRow} RunRow */
/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').RetryPolicy} RetryPolicy */
/** @typedef {import('../types.js').Schedule} Schedule */

/**
 * @typedef {object} JobInput
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {boolean} [enabled]
 * @property {unknown} schedule
 * @property {{ url: string, method?: string, headers?: Record<string, string>, body?: unknown }} target
 * @property {string|null} [targetKey]
 * @property {number} [timeoutMs]
 * @property {Partial<RetryPolicy>} [retry]
 */

/**
 * Job lifecycle and validation. Firing (turning a due job into a run) also lives here so the
 * worker and manual triggers share one rule set.
 */
export class JobService {
  static METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  static MAX_HEADERS = 10;
  static DEFAULT_RETRY = /** @type {RetryPolicy} */ ({ max: 3, backoffSec: 30 });
  static DUE_BATCH = 200;

  /**
   * @param {object} deps
   * @param {import('../db.js').Database} deps.db
   * @param {import('../store/job-store.js').JobStore} deps.jobs
   * @param {import('../store/run-store.js').RunStore} deps.runs
   * @param {import('../net/net-guard.js').NetGuard} deps.guard
   * @param {ScheduleRule} deps.schedule
   * @param {{ targetKeys: Map<string, string>, defaultTimeoutMs: number, maxTimeoutMs: number, maxRetries: number, maxBackoffSec: number, maxBodyBytes: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ db, jobs, runs, guard, schedule, options, now = Date.now }) {
    this.now = now;
    this.db = db;
    this.jobs = jobs;
    this.runs = runs;
    this.guard = guard;
    this.schedule = schedule;
    this.options = options;
  }

  /**
   * @param {JobInput} input
   * @param {string} actor
   * @param {number} [now]
   */
  create(input, actor, now = this.now()) {
    if (this.jobs.get(input.name)) throw new SchedulerError('JOB_EXISTS', `job "${input.name}" already exists`);
    const schedule = this.schedule.normalize(input.schedule, now);
    const enabled = input.enabled !== false;
    /** @type {JobRow} */
    const row = {
      name: input.name,
      description: input.description ?? '',
      tags: JobService.#tags(input.tags),
      enabled: enabled ? 1 : 0,
      schedule: JSON.stringify(schedule),
      target: JSON.stringify(this.#target(input.target)),
      target_key: this.#targetKey(input.targetKey),
      timeout_ms: this.#timeout(input.timeoutMs),
      retry: JSON.stringify(this.#retry(input.retry)),
      next_run_at: enabled ? ScheduleRule.next(schedule, now) : null,
      last_run_at: null,
      last_status: null,
      created_by: actor,
      created_at: now,
      updated_at: now,
    };
    return this.jobs.insert(row);
  }

  /** @param {string} name */
  get(name) {
    return this.jobs.require(name);
  }

  /**
   * @param {{ q?: string, tag?: string, enabled?: boolean }} filter
   * @param {{ limit: number, cursor?: string }} page
   */
  list(filter, { limit, cursor }) {
    const rows = this.jobs.list(filter, { limit: limit + 1, after: cursor });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].name : null };
  }

  /**
   * Partial update. Changing the schedule or enabling recomputes the next firing; a paused job
   * keeps no next firing.
   * @param {string} name
   * @param {Partial<Omit<JobInput, 'name'>>} patch
   * @param {number} [now]
   */
  update(name, patch, now = this.now()) {
    const row = this.jobs.require(name);
    /** @type {Schedule} */
    let schedule = JSON.parse(row.schedule);
    let scheduleChanged = false;
    if (patch.schedule !== undefined) { schedule = this.schedule.normalize(patch.schedule, now); scheduleChanged = true; }
    const enabled = patch.enabled ?? row.enabled === 1;
    const next = !enabled ? null : scheduleChanged || row.enabled === 0 ? ScheduleRule.next(schedule, now) : row.next_run_at;
    return this.jobs.update({
      ...row,
      description: patch.description ?? row.description,
      tags: patch.tags === undefined ? row.tags : JobService.#tags(patch.tags),
      enabled: enabled ? 1 : 0,
      schedule: JSON.stringify(schedule),
      target: patch.target === undefined ? row.target : JSON.stringify(this.#target(patch.target)),
      target_key: patch.targetKey === undefined ? row.target_key : this.#targetKey(patch.targetKey),
      timeout_ms: patch.timeoutMs === undefined ? row.timeout_ms : this.#timeout(patch.timeoutMs),
      retry: patch.retry === undefined ? row.retry : JSON.stringify(this.#retry(patch.retry)),
      next_run_at: next,
      updated_at: now,
    });
  }

  /** Deletes the job and, by cascade, its runs. @param {string} name */
  remove(name) {
    if (!this.jobs.delete(name)) throw new SchedulerError('JOB_NOT_FOUND', `job "${name}" not found`);
  }

  /**
   * Queue a run now, regardless of the schedule or the enabled bit. Refused while a run is active.
   * @param {string} name
   * @param {number} [now]
   */
  trigger(name, now = this.now()) {
    const job = this.jobs.require(name);
    return this.db.transaction(() => {
      if (this.runs.hasActive(name)) throw new SchedulerError('RUN_ACTIVE', `job "${name}" already has a queued or running run`);
      return this.runs.insert({ jobName: name, trigger: 'manual', status: 'pending', scheduledFor: now, maxAttempts: JobService.maxAttempts(job), nextAttemptAt: now }, now);
    });
  }

  /**
   * Turn one due job into a run and advance its pointer. Overlap is refused: when the previous run
   * is still active the firing is recorded as `skipped`. Returns null when the job was changed
   * between being read and being fired (paused, deleted, rescheduled or already fired).
   * @param {JobRow} job
   * @param {number} now
   */
  fire(job, now) {
    return this.db.transaction(() => {
      const fresh = this.jobs.get(job.name);
      if (!fresh || fresh.enabled !== 1 || fresh.next_run_at !== job.next_run_at) return null;
      const scheduledFor = /** @type {number} */ (job.next_run_at);
      const active = this.runs.hasActive(job.name);
      const run = this.runs.insert({
        jobName: job.name, trigger: 'schedule', status: active ? 'skipped' : 'pending', scheduledFor, maxAttempts: JobService.maxAttempts(job),
        nextAttemptAt: active ? null : now, error: active ? 'previous run still active' : null,
      }, now);
      this.jobs.setNext(job.name, ScheduleRule.next(JSON.parse(job.schedule), now));
      if (active) this.jobs.recordOutcome(job.name, now, 'skipped');
      return run;
    });
  }

  /**
   * Fire every job whose next run has passed. Missed firings while the process was down collapse
   * into one, because the pointer only ever holds the next instant.
   * @param {number} now
   */
  fireDue(now) {
    const due = this.jobs.due(now, JobService.DUE_BATCH);
    return due.map((job) => this.fire(job, now)).filter((run) => run !== null);
  }

  /** @param {number} id */
  run(id) {
    const row = this.runs.get(id);
    if (!row) throw new SchedulerError('RUN_NOT_FOUND', `run ${id} not found`);
    return row;
  }

  /**
   * Cancel a queued or retrying run. A running attempt cannot be interrupted.
   * @param {number} id
   * @param {number} [now]
   */
  cancelRun(id, now = this.now()) {
    const row = this.run(id);
    if (!this.runs.cancel(id, 'cancelled by operator', now)) throw new SchedulerError('RUN_NOT_CANCELLABLE', `run ${id} is ${row.status}; only pending and retrying runs can be cancelled`);
    return /** @type {RunRow} */ (this.runs.get(id));
  }

  /**
   * @param {string} cron
   * @param {string|undefined} timezone
   * @param {number} count
   * @param {number} [now]
   */
  preview(cron, timezone, count, now = this.now()) {
    const s = /** @type {{ cron: string, timezone: string }} */ (this.schedule.normalize({ cron, timezone }, now));
    return { cron: s.cron, timezone: s.timezone, next: new CronExpression(s.cron).upcoming(now, s.timezone, count) };
  }

  /** @param {JobRow} job */
  static maxAttempts(job) {
    return /** @type {RetryPolicy} */ (JSON.parse(job.retry)).max + 1;
  }

  /**
   * Delay before the retry that follows attempt number `attempt` (1-based).
   * @param {RetryPolicy} retry
   * @param {number} attempt
   * @param {number} maxBackoffSec
   */
  static backoffMs(retry, attempt, maxBackoffSec) {
    return Math.min(retry.backoffSec * 2 ** (attempt - 1), maxBackoffSec) * 1000;
  }

  /**
   * @param {JobInput['target']} t
   * @returns {Target}
   */
  #target(t) {
    const method = /** @type {Target['method']} */ ((t.method ?? 'POST').toUpperCase());
    if (!JobService.METHODS.has(method)) throw new SchedulerError('INVALID_TARGET', `method must be one of ${[...JobService.METHODS].join(', ')}`);
    try {
      this.guard.check(t.url);
    } catch (err) {
      throw new SchedulerError('INVALID_TARGET', /** @type {Error} */ (err).message);
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(t.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!/^x-[a-z0-9-]{1,60}$/.test(lower) || lower.startsWith('x-scheduler-')) throw new SchedulerError('INVALID_TARGET', `header "${name}" is not allowed; only custom X-* headers can be set (use targetKey for Authorization)`);
      if (typeof value !== 'string' || value.length > 1024 || !/^[\x20-\x7e]*$/.test(value)) throw new SchedulerError('INVALID_TARGET', `header "${name}" must be printable ASCII up to 1024 characters`);
      headers[lower] = value;
    }
    if (Object.keys(headers).length > JobService.MAX_HEADERS) throw new SchedulerError('INVALID_TARGET', `at most ${JobService.MAX_HEADERS} headers`);
    if (t.body !== undefined && (method === 'GET' || method === 'DELETE')) throw new SchedulerError('INVALID_TARGET', `${method} requests cannot carry a body`);
    if (t.body !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(t.body));
      if (bytes > this.options.maxBodyBytes) throw new SchedulerError('BODY_TOO_LARGE', `body is ${bytes} bytes, limit ${this.options.maxBodyBytes}`);
    }
    return { url: t.url, method, headers, ...(t.body === undefined ? {} : { body: t.body }) };
  }

  /** @param {string|null|undefined} key */
  #targetKey(key) {
    if (key === undefined || key === null || key === '') return null;
    if (!this.options.targetKeys.has(key)) throw new SchedulerError('UNKNOWN_TARGET_KEY', `target key "${key}" is not configured (TARGET_KEYS)`);
    return key;
  }

  /** @param {number|undefined} ms */
  #timeout(ms) {
    if (ms === undefined) return this.options.defaultTimeoutMs;
    if (ms < 1000 || ms > this.options.maxTimeoutMs) throw new SchedulerError('INVALID_TARGET', `timeoutMs must be between 1000 and ${this.options.maxTimeoutMs}`);
    return ms;
  }

  /** @param {Partial<RetryPolicy>|undefined} r @returns {RetryPolicy} */
  #retry(r) {
    const policy = { ...JobService.DEFAULT_RETRY, ...r };
    if (policy.max < 0 || policy.max > this.options.maxRetries) throw new SchedulerError('INVALID_TARGET', `retry.max must be between 0 and ${this.options.maxRetries}`);
    if (policy.backoffSec < 1 || policy.backoffSec > this.options.maxBackoffSec) throw new SchedulerError('INVALID_TARGET', `retry.backoffSec must be between 1 and ${this.options.maxBackoffSec}`);
    return policy;
  }

  /** @param {string[]|undefined} tags */
  static #tags(tags) {
    return JSON.stringify([...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].sort());
  }
}
