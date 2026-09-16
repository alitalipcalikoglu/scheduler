import { CronExpression, CronError } from './cron.js';
import { SchedulerError } from './errors.js';

/** @typedef {import('../types.js').Schedule} Schedule */

/** Validation and next-firing computation for job schedules. */
export class ScheduleRule {
  /** @param {{ defaultTimezone: string }} options */
  constructor({ defaultTimezone }) {
    this.defaultTimezone = defaultTimezone;
  }

  /**
   * Normalise user input into a stored schedule. Throws `INVALID_SCHEDULE`.
   * @param {unknown} input
   * @param {number} now
   * @returns {Schedule}
   */
  normalize(input, now) {
    const s = /** @type {Record<string, unknown>} */ (input);
    if (typeof s.cron === 'string') {
      const timezone = typeof s.timezone === 'string' && s.timezone ? s.timezone : this.defaultTimezone;
      if (!CronExpression.isTimezone(timezone)) throw new SchedulerError('INVALID_SCHEDULE', `unknown timezone "${timezone}"`);
      let cron;
      try {
        cron = new CronExpression(s.cron);
      } catch (err) {
        if (err instanceof CronError) throw new SchedulerError('INVALID_SCHEDULE', `invalid cron expression: ${err.message}`);
        throw err;
      }
      if (cron.next(now, timezone) === null) throw new SchedulerError('INVALID_SCHEDULE', 'cron expression never fires within the next five years');
      return { cron: cron.expression, timezone };
    }
    if (typeof s.at === 'string') {
      const t = Date.parse(s.at);
      if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(s.at)) throw new SchedulerError('INVALID_SCHEDULE', 'at must be an ISO 8601 date-time');
      if (t <= now) throw new SchedulerError('INVALID_SCHEDULE', 'at must be in the future');
      return { at: new Date(t).toISOString() };
    }
    throw new SchedulerError('INVALID_SCHEDULE', 'schedule needs either cron (with optional timezone) or at');
  }

  /**
   * Next firing after `afterMs`, null when the schedule is exhausted.
   * @param {Schedule} schedule
   * @param {number} afterMs
   */
  static next(schedule, afterMs) {
    if ('at' in schedule) {
      const t = Date.parse(schedule.at);
      return t > afterMs ? t : null;
    }
    return new CronExpression(schedule.cron).next(afterMs, schedule.timezone);
  }

  /** @param {Schedule} schedule */
  static isOneShot(schedule) {
    return 'at' in schedule;
  }
}
