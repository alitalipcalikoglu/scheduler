import { setTimeout as sleep } from 'node:timers/promises';
import { JobService } from './domain/job-service.js';

/** @typedef {import('./types.js').RunRow} RunRow */
/** @typedef {import('./types.js').Attempt} Attempt */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * Background loop: fires due jobs into runs, claims due runs up to the concurrency limit, calls
 * the targets and records outcomes with retry scheduling. Also recovers runs interrupted by a
 * previous process and purges old history.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 60_000;

  /**
   * @param {object} deps
   * @param {JobService} deps.service
   * @param {import('./store/job-store.js').JobStore} deps.jobs
   * @param {import('./store/run-store.js').RunStore} deps.runs
   * @param {import('./net/http-caller.js').HttpCaller} deps.caller
   * @param {Logger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number, maxBackoffSec: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ service, jobs, runs, caller, log, options, now = Date.now }) {
    this.service = service;
    this.jobs = jobs;
    this.runs = runs;
    this.caller = caller;
    this.log = log;
    this.options = options;
    this.now = now;
    this.running = false;
    /** @type {Promise<void>|null} */
    this.loop = null;
    this.abort = new AbortController();
    /** @type {Set<Promise<void>>} */
    this.inFlight = new Set();
    this.lastMaintenance = 0;
    this.counters = { succeeded: 0, failed: 0, retried: 0, skipped: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.recover();
    this.lastMaintenance = this.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs }, 'worker started');
  }

  /** Stop claiming and wait for in-flight calls to finish. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop;
    await Promise.allSettled(this.inFlight);
    this.loop = null;
    this.log.info('worker stopped');
  }

  /**
   * Runs left `running` by a crash count as a failed attempt; they retry or fail by the job's policy.
   */
  recover() {
    const now = this.now();
    const interrupted = this.runs.running();
    for (const run of interrupted) this.#settle(run, { startedAt: run.started_at ?? now, error: 'interrupted by restart', httpStatus: null, response: null, retryable: true }, now);
    if (interrupted.length) this.log.warn({ n: interrupted.length }, 'recovered runs interrupted by a previous process');
  }

  /**
   * One pass: fire due jobs, claim due runs into free slots. Awaits the calls it started, so tests
   * see final state; the loop itself does not wait.
   * @param {number} [now]
   */
  async tick(now = this.now()) {
    this.#pass(now);
    await Promise.allSettled([...this.inFlight]);
  }

  /** @param {number} now */
  #pass(now) {
    this.#maintenance(now);
    for (const run of this.service.fireDue(now)) {
      if (run.status === 'skipped') { this.counters.skipped++; this.log.warn({ job: run.job_name, run: run.id }, 'firing skipped, previous run still active'); }
    }
    const free = this.options.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const claimed = this.runs.claim(now, free);
    for (const run of claimed) {
      const p = this.#execute(run).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return claimed.length;
  }

  async #run() {
    while (this.running) {
      try {
        this.#pass(this.now());
      } catch (err) {
        this.log.error({ err }, 'worker iteration failed');
      }
      try {
        await sleep(this.options.pollMs, undefined, { signal: this.abort.signal });
      } catch {
        // aborted by stop()
      }
    }
  }

  /** @param {RunRow} run */
  async #execute(run) {
    const startedAt = this.now();
    const job = this.jobs.get(run.job_name);
    if (!job) { this.#settle(run, { startedAt, error: 'job no longer exists', httpStatus: null, response: null, retryable: false }, this.now()); return; }
    try {
      const target = JSON.parse(job.target);
      const result = await this.caller.call({ job: job.name, run: run.id, attempt: run.attempt, target, targetKey: job.target_key, timeoutMs: job.timeout_ms });
      this.#settle(run, { startedAt, error: null, httpStatus: result.httpStatus, response: result.response, retryable: false }, this.now());
    } catch (err) {
      const e = /** @type {{ message: string, httpStatus?: number|null, response?: string, retryable?: boolean }} */ (err);
      this.#settle(run, { startedAt, error: e.message, httpStatus: e.httpStatus ?? null, response: e.response || null, retryable: e.retryable === true }, this.now());
    }
  }

  /**
   * Persist an attempt's outcome and decide: succeeded, retrying (with backoff) or failed.
   * @param {RunRow} run
   * @param {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} o
   * @param {number} now
   */
  #settle(run, o, now) {
    const job = this.jobs.get(run.job_name);
    const durationMs = Math.max(0, now - o.startedAt);
    /** @type {Attempt[]} */
    const attempts = [...JSON.parse(run.attempts), { n: run.attempt, startedAt: new Date(o.startedAt).toISOString(), durationMs, httpStatus: o.httpStatus, error: o.error }];
    const retry = o.error !== null && o.retryable && run.attempt < run.max_attempts && job !== undefined;
    const status = o.error === null ? 'succeeded' : retry ? 'retrying' : 'failed';
    const nextAttemptAt = retry ? now + JobService.backoffMs(JSON.parse(/** @type {import('./types.js').JobRow} */ (job).retry), run.attempt, this.options.maxBackoffSec) : null;
    const updated = this.runs.finish(run.id, { status, finishedAt: status === 'retrying' ? null : now, durationMs, httpStatus: o.httpStatus, response: o.response, error: o.error, attempts, nextAttemptAt });
    if (status !== 'retrying') this.jobs.recordOutcome(run.job_name, now, status);
    this.counters[status === 'retrying' ? 'retried' : status]++;
    const meta = { job: run.job_name, run: run.id, attempt: run.attempt, status, httpStatus: o.httpStatus, durationMs, nextAttemptAt };
    if (status === 'succeeded') this.log.info(meta, 'run succeeded');
    else this.log[status === 'failed' ? 'error' : 'warn']({ ...meta, error: o.error }, status === 'failed' ? 'run failed' : 'attempt failed, retry scheduled');
    return updated;
  }

  /** @param {number} now */
  #maintenance(now) {
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const purged = this.runs.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged finished runs past retention');
  }
}
