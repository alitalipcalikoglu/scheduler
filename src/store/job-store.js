import { SchedulerError } from '../domain/errors.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').JobRow} JobRow */

/** Persistence for jobs and their next-run pointers. */
export class JobStore {
  static COLUMNS = 'name, description, tags, enabled, schedule, target, target_key, timeout_ms, retry, next_run_at, last_run_at, last_status, created_by, created_at, updated_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = JobStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO jobs (${C}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM jobs WHERE name = ?`),
      update: db.prepare(`UPDATE jobs SET description = ?, tags = ?, enabled = ?, schedule = ?, target = ?, target_key = ?, timeout_ms = ?, retry = ?, next_run_at = ?, updated_at = ? WHERE name = ?`),
      delete: db.prepare(`DELETE FROM jobs WHERE name = ?`),
      due: db.prepare(`SELECT ${C} FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`),
      setNext: db.prepare(`UPDATE jobs SET next_run_at = ? WHERE name = ?`),
      outcome: db.prepare(`UPDATE jobs SET last_run_at = ?, last_status = ? WHERE name = ?`),
      counts: db.prepare(`SELECT COUNT(*) AS total, SUM(enabled) AS enabled, SUM(CASE WHEN enabled = 1 AND next_run_at IS NOT NULL THEN 1 ELSE 0 END) AS scheduled FROM jobs`),
      nextDue: db.prepare(`SELECT MIN(next_run_at) AS at FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /** @param {JobRow} row */
  insert(row) {
    this.stmt.insert.run(row.name, row.description, row.tags, row.enabled, row.schedule, row.target, row.target_key, row.timeout_ms, row.retry, row.next_run_at, row.last_run_at, row.last_status, row.created_by, row.created_at, row.updated_at);
    return row;
  }

  /** @param {string} name */
  get(name) {
    return /** @type {JobRow|undefined} */ (this.stmt.get.get(name));
  }

  /** @param {JobRow} row */
  update(row) {
    this.stmt.update.run(row.description, row.tags, row.enabled, row.schedule, row.target, row.target_key, row.timeout_ms, row.retry, row.next_run_at, row.updated_at, row.name);
    return row;
  }

  /** @param {string} name */
  delete(name) {
    return Number(this.stmt.delete.run(name).changes) > 0;
  }

  /**
   * Enabled jobs whose next firing has passed.
   * @param {number} now
   * @param {number} limit
   */
  due(now, limit) {
    return /** @type {JobRow[]} */ (this.stmt.due.all(now, limit));
  }

  /** @param {string} name @param {number|null} nextRunAt */
  setNext(name, nextRunAt) {
    this.stmt.setNext.run(nextRunAt, name);
  }

  /** @param {string} name @param {number} at @param {string} status */
  recordOutcome(name, at, status) {
    this.stmt.outcome.run(at, status, name);
  }

  counts() {
    const r = /** @type {{ total: number, enabled: number|null, scheduled: number }} */ (this.stmt.counts.get());
    const n = /** @type {{ at: number|null }} */ (this.stmt.nextDue.get());
    return { total: Number(r.total), enabled: Number(r.enabled ?? 0), scheduled: Number(r.scheduled), nextDueAt: n.at === null ? null : Number(n.at) };
  }

  /**
   * Sorted by name; keyset pagination on the name.
   * @param {{ q?: string, tag?: string, enabled?: boolean }} f
   * @param {{ limit: number, after?: string }} page
   * @returns {JobRow[]}
   */
  list(f, { limit, after }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (f.q !== undefined) { where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"); const like = `%${JobStore.escapeLike(f.q)}%`; params.push(like, like); }
    if (f.tag !== undefined) { where.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)'); params.push(f.tag); }
    if (f.enabled !== undefined) { where.push('enabled = ?'); params.push(f.enabled ? 1 : 0); }
    if (after !== undefined) { where.push('name > ?'); params.push(after); }
    const sql = `SELECT ${JobStore.COLUMNS} FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {JobRow[]} */ (stmt.all(...params, limit));
  }

  /** @param {string} s */
  static escapeLike(s) {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  /** @param {string} name */
  require(name) {
    const row = this.get(name);
    if (!row) throw new SchedulerError('JOB_NOT_FOUND', `job "${name}" not found`);
    return row;
  }
}
