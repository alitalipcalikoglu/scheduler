import { randomUUID } from 'node:crypto';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').RunRow} RunRow */
/** @typedef {import('../types.js').RunStatus} RunStatus */
/** @typedef {import('../types.js').Attempt} Attempt */
/** @typedef {import('../types.js').FinishOutcome} FinishOutcome */

/**
 * Persistence for runs: the work queue (pending/retrying) and the history (everything else).
 *
 * Lease ownership (Stage 6): `claim()` hands each row a fresh random `owner_token` (the fencing
 * token) and a `lease_until`. Every write that ends a claimed attempt — {@link finish} and
 * {@link heartbeat} — is guarded by `WHERE owner_token = ? AND status = 'running'`, so it can only
 * ever affect the row it thinks it owns: a worker that claimed a run, then hung long enough for
 * another process to reclaim it (see {@link reclaimExpired}), can no longer overwrite that row when
 * it eventually returns — its `owner_token` no longer matches, and by then `status` isn't
 * `'running'` under it either. The token itself is the whole fencing mechanism; there is no
 * separate generation counter because a fresh random token per claim already can never collide
 * with a previous one.
 */
export class RunStore {
  static COLUMNS = 'id, job_name, trigger, status, scheduled_for, attempt, max_attempts, next_attempt_at, started_at, finished_at, duration_ms, http_status, response, error, attempts, created_at, owner_token, lease_until';
  static ACTIVE = /** @type {const} */ (['pending', 'running', 'retrying']);
  static STATUSES = /** @type {const} */ (['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'cancelled']);

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = RunStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO runs (job_name, trigger, status, scheduled_for, attempt, max_attempts, next_attempt_at, error, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM runs WHERE id = ?`),
      active: db.prepare(`SELECT id FROM runs WHERE job_name = ? AND status IN ('pending', 'running', 'retrying') LIMIT 1`),
      due: db.prepare(`SELECT ${C} FROM runs WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`),
      start: db.prepare(`UPDATE runs SET status = 'running', attempt = attempt + 1, started_at = ?, next_attempt_at = NULL, owner_token = ?, lease_until = ? WHERE id = ? AND status IN ('pending', 'retrying')`),
      finish: db.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, response = ?, error = ?, attempts = ?, next_attempt_at = ?, owner_token = NULL, lease_until = NULL WHERE id = ? AND owner_token = ? AND status = 'running'`),
      heartbeat: db.prepare(`UPDATE runs SET lease_until = ? WHERE id = ? AND owner_token = ? AND status = 'running'`),
      cancel: db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ?, error = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      expiredLeases: db.prepare(`SELECT ${C} FROM runs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)`),
      runningCount: db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`),
      purge: db.prepare(`DELETE FROM runs WHERE created_at < ? AND status IN ('succeeded', 'failed', 'skipped', 'cancelled')`),
      byStatus: db.prepare(`SELECT status, COUNT(*) AS n FROM runs GROUP BY status`),
      recentByStatus: db.prepare(`SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY status`),
      recentFailures: db.prepare(`SELECT job_name, COUNT(*) AS n FROM runs WHERE created_at >= ? AND status = 'failed' GROUP BY job_name ORDER BY n DESC, job_name LIMIT ?`),
      avgDuration: db.prepare(`SELECT AVG(duration_ms) AS avg FROM runs WHERE created_at >= ? AND status = 'succeeded'`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /**
   * Queue a run (`pending`, due at `nextAttemptAt`) or record a terminal one (`skipped`).
   * @param {{ jobName: string, trigger: 'schedule'|'manual', status: 'pending'|'skipped', scheduledFor: number, maxAttempts: number, nextAttemptAt?: number|null, error?: string|null }} r
   * @param {number} [now]
   */
  insert({ jobName, trigger, status, scheduledFor, maxAttempts, nextAttemptAt = null, error = null }, now = Date.now()) {
    const id = Number(this.stmt.insert.run(jobName, trigger, status, scheduledFor, maxAttempts, nextAttemptAt, error, now).lastInsertRowid);
    return /** @type {RunRow} */ (this.get(id));
  }

  /** @param {number} id */
  get(id) {
    return /** @type {RunRow|undefined} */ (this.stmt.get.get(id));
  }

  /** True while the job has a queued, running or retrying run. @param {string} jobName */
  hasActive(jobName) {
    return this.stmt.active.get(jobName) !== undefined;
  }

  /**
   * Move due runs to `running`, each with a fresh lease, and return them. One transaction, so two
   * loops (in this process or another sharing the file) never claim the same row.
   * @param {number} now
   * @param {number} limit
   * @param {number} leaseMs
   */
  claim(now, limit, leaseMs) {
    return this.db.transaction(() => {
      const rows = /** @type {RunRow[]} */ (this.stmt.due.all(now, limit));
      return rows.map((r) => { this.stmt.start.run(now, randomUUID(), now + leaseMs, r.id); return /** @type {RunRow} */ (this.get(r.id)); });
    });
  }

  /**
   * Record an attempt's outcome, but only while `ownerToken` still holds the lease. Returns the
   * updated row, or `null` if the lease had already moved on (see {@link reclaimExpired}) — in
   * which case nothing was written and the caller must not treat this as a normal completion.
   * @param {number} id
   * @param {string} ownerToken
   * @param {FinishOutcome} o
   */
  finish(id, ownerToken, o) {
    const { changes } = this.stmt.finish.run(o.status, o.finishedAt, o.durationMs, o.httpStatus, o.response, o.error, JSON.stringify(o.attempts), o.nextAttemptAt, id, ownerToken);
    return Number(changes) > 0 ? /** @type {RunRow} */ (this.get(id)) : null;
  }

  /**
   * Renew the lease while a call is still in flight. Returns whether `ownerToken` still holds it —
   * `false` means another process already reclaimed this run; the caller must stop treating it as
   * owned (its eventual {@link finish} call will itself be rejected the same way, so this is a
   * faster, proactive detection, not the only safety net).
   * @param {number} id @param {string} ownerToken @param {number} now @param {number} leaseMs
   */
  heartbeat(id, ownerToken, now, leaseMs) {
    return Number(this.stmt.heartbeat.run(now + leaseMs, id, ownerToken).changes) > 0;
  }

  /**
   * Atomically find every run whose lease has expired (or predates leases) and, in the SAME
   * transaction, finish each one via `decide(run)` — a pure function computing the same shape
   * {@link finish} takes. Running the read and every write inside one transaction is what makes
   * this race-free: a concurrent {@link heartbeat} for one of these rows either commits entirely
   * before this call (the row is no longer expired, so it's simply not selected) or is attempted
   * entirely after (its own guarded `UPDATE` then matches zero rows, because this transaction has
   * already moved the row off `'running'`) — there is no window in which both could believe they
   * own the same row.
   * @param {number} now
   * @param {(run: RunRow) => FinishOutcome} decide
   * @returns {RunRow[]}
   */
  reclaimExpired(now, decide) {
    return this.db.transaction(() => {
      const stale = /** @type {RunRow[]} */ (this.stmt.expiredLeases.all(now));
      return stale.map((run) => /** @type {RunRow} */ (this.finish(run.id, /** @type {string} */ (run.owner_token), decide(run))));
    });
  }

  /** Live in-flight count, for an API-only process that has no in-process Worker to ask. */
  runningCount() {
    return Number(/** @type {{ n: number }} */ (this.stmt.runningCount.get()).n);
  }

  /** @param {number} id @param {string} reason @param {number} [now] */
  cancel(id, reason, now = Date.now()) {
    return Number(this.stmt.cancel.run(now, reason, id).changes) > 0;
  }

  /** @param {number} before */
  purge(before) {
    return Number(this.stmt.purge.run(before).changes);
  }

  /**
   * Newest first. `beforeId` for keyset paging.
   * @param {{ jobName?: string, status?: RunStatus }} f
   * @param {{ limit: number, beforeId?: number }} page
   * @returns {RunRow[]}
   */
  list(f, { limit, beforeId }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (f.jobName !== undefined) { where.push('job_name = ?'); params.push(f.jobName); }
    if (f.status !== undefined) { where.push('status = ?'); params.push(f.status); }
    if (beforeId !== undefined) { where.push('id < ?'); params.push(beforeId); }
    const sql = `SELECT ${RunStore.COLUMNS} FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {RunRow[]} */ (stmt.all(...params, limit));
  }

  /** @param {number} since @param {number} [topN] */
  stats(since, topN = 10) {
    const count = (/** @type {{ status: string, n: number }[]} */ rows) => Object.fromEntries(RunStore.STATUSES.map((s) => [s, Number(rows.find((r) => r.status === s)?.n ?? 0)]));
    return {
      byStatus: count(/** @type {any} */ (this.stmt.byStatus.all())),
      recentByStatus: count(/** @type {any} */ (this.stmt.recentByStatus.all(since))),
      recentFailures: /** @type {{ job_name: string, n: number }[]} */ (this.stmt.recentFailures.all(since, topN)).map((r) => ({ job: r.job_name, failed: Number(r.n) })),
      recentAvgDurationMs: (() => { const r = /** @type {{ avg: number|null }} */ (this.stmt.avgDuration.get(since)); return r.avg === null ? null : Math.round(Number(r.avg)); })(),
    };
  }
}
