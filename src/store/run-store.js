/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').RunRow} RunRow */
/** @typedef {import('../types.js').RunStatus} RunStatus */
/** @typedef {import('../types.js').Attempt} Attempt */

/** Persistence for runs: the work queue (pending/retrying) and the history (everything else). */
export class RunStore {
  static COLUMNS = 'id, job_name, trigger, status, scheduled_for, attempt, max_attempts, next_attempt_at, started_at, finished_at, duration_ms, http_status, response, error, attempts, created_at';
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
      start: db.prepare(`UPDATE runs SET status = 'running', attempt = attempt + 1, started_at = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      finish: db.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, response = ?, error = ?, attempts = ?, next_attempt_at = ? WHERE id = ?`),
      cancel: db.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ?, error = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying')`),
      running: db.prepare(`SELECT ${C} FROM runs WHERE status = 'running'`),
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
   * Move due runs to `running` and return them. One transaction, so two loops never claim the same row.
   * @param {number} now
   * @param {number} limit
   */
  claim(now, limit) {
    return this.db.transaction(() => {
      const rows = /** @type {RunRow[]} */ (this.stmt.due.all(now, limit));
      return rows.map((r) => { this.stmt.start.run(now, r.id); return /** @type {RunRow} */ (this.get(r.id)); });
    });
  }

  /**
   * @param {number} id
   * @param {{ status: 'succeeded'|'failed'|'retrying', finishedAt: number|null, durationMs: number, httpStatus: number|null, response: string|null, error: string|null, attempts: Attempt[], nextAttemptAt: number|null }} o
   */
  finish(id, o) {
    this.stmt.finish.run(o.status, o.finishedAt, o.durationMs, o.httpStatus, o.response, o.error, JSON.stringify(o.attempts), o.nextAttemptAt, id);
    return /** @type {RunRow} */ (this.get(id));
  }

  /** @param {number} id @param {string} reason @param {number} [now] */
  cancel(id, reason, now = Date.now()) {
    return Number(this.stmt.cancel.run(now, reason, id).changes) > 0;
  }

  /** Runs left `running` by a previous process. */
  running() {
    return /** @type {RunRow[]} */ (this.stmt.running.all());
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
