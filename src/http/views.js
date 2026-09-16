/** @typedef {import('../types.js').JobRow} JobRow */
/** @typedef {import('../types.js').RunRow} RunRow */

/** Response shapes. */
export class Views {
  /** @param {number|null} t */
  static iso(t) {
    return t === null ? null : new Date(Number(t)).toISOString();
  }

  /** @param {JobRow} j */
  static job(j) {
    return {
      name: j.name, description: j.description, tags: /** @type {string[]} */ (JSON.parse(j.tags)), enabled: j.enabled === 1,
      schedule: JSON.parse(j.schedule), target: JSON.parse(j.target), targetKey: j.target_key, timeoutMs: Number(j.timeout_ms), retry: JSON.parse(j.retry),
      nextRunAt: Views.iso(j.next_run_at), lastRunAt: Views.iso(j.last_run_at), lastStatus: j.last_status,
      createdBy: j.created_by, createdAt: Views.iso(j.created_at), updatedAt: Views.iso(j.updated_at),
    };
  }

  /** @param {RunRow} r */
  static run(r) {
    return {
      id: Number(r.id), job: r.job_name, trigger: r.trigger, status: r.status, scheduledFor: Views.iso(r.scheduled_for),
      attempt: Number(r.attempt), maxAttempts: Number(r.max_attempts), nextAttemptAt: Views.iso(r.next_attempt_at),
      startedAt: Views.iso(r.started_at), finishedAt: Views.iso(r.finished_at), durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      httpStatus: r.http_status === null ? null : Number(r.http_status), response: r.response, error: r.error,
      attempts: JSON.parse(r.attempts), createdAt: Views.iso(r.created_at),
    };
  }
}
