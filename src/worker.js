import { setTimeout as sleep } from 'node:timers/promises';
import { JobService } from './domain/job-service.js';

/** @typedef {import('./types.js').RunRow} RunRow */
/** @typedef {import('./types.js').Attempt} Attempt */
/** @typedef {import('./types.js').FinishOutcome} FinishOutcome */
/** @typedef {import('./types.js').MinimalLogger} MinimalLogger */

/**
 * Background loop: fires due jobs into runs, claims due runs up to the concurrency limit, calls
 * the targets and records outcomes with retry scheduling. Also reclaims runs whose lease expired
 * (a previous process's crash, or this process's own hung call) and purges old history.
 *
 * Lease ownership: `claim()` (`store/run-store.js`) hands each run a fresh `owner_token` and a
 * `lease_until`. While a call is in flight, `#startHeartbeat` renews `lease_until` every
 * `heartbeatMs` — well inside `leaseMs`, so a normal call, however long, never loses its lease on
 * its own. Every write that ends an attempt (`finish`) is guarded by that same `owner_token`, so a
 * worker that hung long enough to be reclaimed by someone else can never overwrite the row when it
 * eventually returns: its `finish` call simply matches zero rows and is discarded (logged, not
 * thrown) rather than committed. Heartbeat failure is the same story one step earlier — it detects
 * the lost lease proactively, before the call even finishes, but it is not the only thing standing
 * between a stale worker and a bad write; `finish`'s own guard is.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 60_000;

  /**
   * @param {object} deps
   * @param {JobService} deps.service
   * @param {import('./store/job-store.js').JobStore} deps.jobs
   * @param {import('./store/run-store.js').RunStore} deps.runs
   * @param {import('./store/heartbeat-store.js').HeartbeatStore} deps.presence
   * @param {import('./net/http-caller.js').HttpCaller} deps.caller
   * @param {MinimalLogger} deps.log
   * @param {{ concurrency: number, pollMs: number, retentionDays: number, maxBackoffSec: number, leaseMs: number, heartbeatMs: number, drainMs: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ service, jobs, runs, presence, caller, log, options, now = Date.now }) {
    this.service = service;
    this.jobs = jobs;
    this.runs = runs;
    this.presence = presence;
    this.caller = caller;
    this.log = log;
    this.options = options;
    this.now = now;
    this.running = false;
    /**
     * Guards claiming/firing specifically, so shutdown can stop taking new work before it starts
     * draining. Defaults true (not gated behind `start()`) so `tick()` — the single-pass helper
     * tests drive directly, without ever calling `start()` — claims normally.
     */
    this.claiming = true;
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
    this.claiming = true;
    this.abort = new AbortController();
    this.recover();
    this.lastMaintenance = this.now();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs, leaseMs: this.options.leaseMs, heartbeatMs: this.options.heartbeatMs }, 'worker started');
  }

  /** Stop claiming and firing new work; in-flight calls keep running until {@link stop} drains them. */
  stopClaiming() {
    this.claiming = false;
  }

  /**
   * Stop claiming (if not already) and wait for in-flight calls to finish, bounded by
   * `options.drainMs` (Stage 6.1) — under ordinary operation every in-flight call already has its
   * own real timeout (`timeoutMs`, capped by `MAX_TIMEOUT_MS`), so the drain finishes well within
   * `drainMs`. If it doesn't (a call somehow bypassed its own timeout), this stops waiting and
   * logs loudly rather than hanging the whole shutdown sequence forever.
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.claiming = false;
    this.abort.abort();
    await this.loop;
    // The losing side of this race must be cancelled explicitly: node:timers/promises' sleep()
    // otherwise keeps its timer alive for the full drainMs even after in-flight draining already
    // won the race — harmless in production (process.exit() doesn't wait on pending timers) but it
    // visibly hangs anything that inspects the event loop (tests included) for up to drainMs.
    const drainAbort = new AbortController();
    const outcome = await Promise.race([
      Promise.allSettled(this.inFlight).then(() => /** @type {const} */ ('drained')),
      sleep(this.options.drainMs, undefined, { signal: drainAbort.signal }).then(() => /** @type {const} */ ('timed-out')).catch(() => /** @type {const} */ ('timed-out')),
    ]);
    drainAbort.abort();
    if (outcome === 'timed-out') this.log.error({ inFlight: this.inFlight.size, drainMs: this.options.drainMs }, 'drain timed out; continuing shutdown with runs still in flight');
    this.loop = null;
    this.log.info('worker stopped');
  }

  /**
   * Runs left `running` by a crash count as a failed attempt; they retry or fail by the job's
   * policy. Called once at startup — every `running` row at that point is necessarily from a
   * previous life of this same process (nothing this process claimed can be older than itself) —
   * and also reachable, with a different label, from the in-loop stale sweep (`#reclaimStale`).
   */
  recover() {
    const recovered = this.#reclaim('interrupted by restart');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'recovered runs interrupted by a previous process');
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
    this.presence.beat(now);
    this.#reclaimStale();
    this.#maintenance(now);
    if (!this.claiming) return 0;
    for (const run of this.service.fireDue(now)) {
      if (run.status === 'skipped') { this.counters.skipped++; this.log.warn({ job: run.job_name, run: run.id }, 'firing skipped, previous run still active'); }
    }
    const free = this.options.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const claimed = this.runs.claim(now, free, this.options.leaseMs);
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
    const ownerToken = /** @type {string} */ (run.owner_token);
    const heartbeat = setInterval(() => {
      const ok = this.runs.heartbeat(run.id, ownerToken, this.now(), this.options.leaseMs);
      if (!ok) this.log.warn({ job: run.job_name, run: run.id }, 'heartbeat found the lease already reassigned; ownership lost mid-call');
    }, this.options.heartbeatMs).unref();
    try {
      const job = this.jobs.get(run.job_name);
      /** @type {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} */
      let outcome;
      if (!job) {
        outcome = { startedAt, error: 'job no longer exists', httpStatus: null, response: null, retryable: false };
      } else {
        try {
          const target = JSON.parse(job.target);
          const result = await this.caller.call({ job: job.name, run: run.id, attempt: run.attempt, target, targetKey: job.target_key, timeoutMs: job.timeout_ms });
          outcome = { startedAt, error: null, httpStatus: result.httpStatus, response: result.response, retryable: false };
        } catch (err) {
          const e = /** @type {{ message: string, httpStatus?: number|null, response?: string, retryable?: boolean }} */ (err);
          outcome = { startedAt, error: e.message, httpStatus: e.httpStatus ?? null, response: e.response || null, retryable: e.retryable === true };
        }
      }
      const now = this.now();
      const decision = this.#decide(run, outcome, now);
      const updated = this.runs.finish(run.id, ownerToken, decision);
      if (updated === null) {
        this.log.warn({ job: run.job_name, run: run.id }, 'lease lost before this attempt could be recorded; result discarded, another worker already reclaimed it');
        return;
      }
      this.#applyOutcome(updated, decision.status, now);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Pure: an attempt's outcome reduced to the shape `RunStore.finish` takes. No I/O.
   * @param {RunRow} run
   * @param {{ startedAt: number, error: string|null, httpStatus: number|null, response: string|null, retryable: boolean }} o
   * @param {number} now
   * @returns {FinishOutcome}
   */
  #decide(run, o, now) {
    const job = this.jobs.get(run.job_name);
    const durationMs = Math.max(0, now - o.startedAt);
    /** @type {Attempt[]} */
    const attempts = [...JSON.parse(run.attempts), { n: run.attempt, startedAt: new Date(o.startedAt).toISOString(), durationMs, httpStatus: o.httpStatus, error: o.error }];
    const retry = o.error !== null && o.retryable && run.attempt < run.max_attempts && job !== undefined;
    const status = o.error === null ? 'succeeded' : retry ? 'retrying' : 'failed';
    const nextAttemptAt = retry ? now + JobService.backoffMs(JSON.parse(/** @type {import('./types.js').JobRow} */ (job).retry), run.attempt, this.options.maxBackoffSec) : null;
    return { status, finishedAt: status === 'retrying' ? null : now, durationMs, httpStatus: o.httpStatus, response: o.response, error: o.error, attempts, nextAttemptAt };
  }

  /**
   * Side effects once an outcome is durably written: the job's `last_status` (terminal only),
   * in-process counters and logging.
   * @param {RunRow} run The row as `finish` returned it.
   * @param {'succeeded'|'retrying'|'failed'} status
   * @param {number} now
   */
  #applyOutcome(run, status, now) {
    if (status !== 'retrying') this.jobs.recordOutcome(run.job_name, now, status);
    this.counters[status === 'retrying' ? 'retried' : status]++;
    const meta = { job: run.job_name, run: run.id, attempt: run.attempt, status, httpStatus: run.http_status, durationMs: run.duration_ms, nextAttemptAt: run.next_attempt_at };
    if (status === 'succeeded') this.log.info(meta, 'run succeeded');
    else this.log[status === 'failed' ? 'error' : 'warn']({ ...meta, error: run.error }, status === 'failed' ? 'run failed' : 'attempt failed, retry scheduled');
  }

  /**
   * Atomically reclaim every run whose lease has expired, labeling the reason `error`, and apply
   * each outcome. Shared by {@link recover} (startup, label "interrupted by restart") and
   * {@link #reclaimStale} (in-loop, label "lease expired").
   * @param {string} error
   */
  #reclaim(error) {
    const now = this.now();
    const recovered = this.runs.reclaimExpired(now, (run) => this.#decide(run, { startedAt: run.started_at ?? now, error, httpStatus: null, response: null, retryable: true }, now));
    for (const run of recovered) this.#applyOutcome(run, /** @type {'retrying'|'failed'} */ (run.status), now);
    return recovered;
  }

  /**
   * In-loop counterpart to {@link recover}: catches a run whose lease expired without a heartbeat
   * (this process's own hung call, or — once multi-process is a supported topology — another
   * process's crash) without waiting for a restart.
   */
  #reclaimStale() {
    const recovered = this.#reclaim('lease expired');
    if (recovered.length) this.log.warn({ n: recovered.length }, 'reclaimed runs whose lease expired without a heartbeat');
  }

  /** @param {number} now */
  #maintenance(now) {
    if (now - this.lastMaintenance < Worker.MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenance = now;
    const purged = this.runs.purge(now - this.options.retentionDays * 86_400_000);
    if (purged) this.log.info({ purged }, 'purged finished runs past retention');
    const staleHeartbeats = this.presence.purgeStale(now, Worker.MAINTENANCE_INTERVAL_MS * 5);
    if (staleHeartbeats) this.log.debug({ staleHeartbeats }, 'purged stale worker_heartbeat rows');
  }
}
