/**
 * Five-field cron expressions (`minute hour day-of-month month day-of-week`) evaluated in an IANA
 * timezone. Supports `*`, lists, ranges, steps, month and weekday names, and the `@hourly`,
 * `@daily`, `@weekly`, `@monthly`, `@yearly` aliases. Day-of-month and day-of-week combine with OR
 * when both are restricted, as in Vixie cron. Wall-clock times that do not exist (DST gap) are
 * skipped; times that occur twice (DST overlap) fire once.
 */
export class CronExpression {
  /** @type {Record<string, string>} */
  static ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
  static MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  static DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  /** Search horizon for the next firing. */
  static HORIZON_MS = 5 * 366 * 86_400_000;
  static MINUTE_MS = 60_000;

  /** @param {string} expression */
  constructor(expression) {
    const text = expression.trim().toLowerCase();
    const expanded = CronExpression.ALIASES[text] ?? text;
    const fields = expanded.split(/\s+/);
    if (fields.length !== 5) throw new CronError(`expected 5 fields, got ${fields.length}`);
    this.expression = fields.join(' ');
    this.minutes = CronExpression.#field(fields[0], 0, 59, null);
    this.hours = CronExpression.#field(fields[1], 0, 23, null);
    this.daysOfMonth = CronExpression.#field(fields[2], 1, 31, null);
    this.months = CronExpression.#field(fields[3], 1, 12, CronExpression.MONTHS);
    this.daysOfWeek = CronExpression.#field(fields[4], 0, 7, CronExpression.DAYS);
    if (this.daysOfWeek.values.has(7)) this.daysOfWeek.values.add(0); // 7 = Sunday too
    if (!CronExpression.#monthHasDay(this.months.values, this.daysOfMonth.values)) throw new CronError('day-of-month never occurs in the listed months');
  }

  /** @param {string} tz */
  static isTimezone(tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone.toLowerCase() === tz.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Next firing strictly after `afterMs`, or null when none within the horizon.
   * @param {number} afterMs
   * @param {string} tz
   * @returns {number|null}
   */
  next(afterMs, tz) {
    const M = CronExpression.MINUTE_MS;
    const start = Math.floor(afterMs / M) * M + M;
    let w = WallClock.toWall(start, tz);
    const limit = w + CronExpression.HORIZON_MS;
    while (w <= limit) {
      const d = new Date(w);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth() + 1;
      const dom = d.getUTCDate();
      if (!this.months.values.has(mo)) { w = Date.UTC(y, mo, 1); continue; }
      if (!this.#dayMatches(dom, d.getUTCDay())) { w = Date.UTC(y, mo - 1, dom + 1); continue; }
      const h = d.getUTCHours();
      if (!this.hours.values.has(h)) { w = Date.UTC(y, mo - 1, dom, h + 1); continue; }
      if (!this.minutes.values.has(d.getUTCMinutes())) { w += M; continue; }
      const utc = WallClock.toUtc(w, tz);
      // Non-existent wall time (DST gap) or an instant not after `afterMs`: move on.
      if (WallClock.toWall(utc, tz) !== w || utc <= afterMs) { w += M; continue; }
      return utc;
    }
    return null;
  }

  /**
   * The next `count` firings after `afterMs`.
   * @param {number} afterMs
   * @param {string} tz
   * @param {number} count
   */
  upcoming(afterMs, tz, count) {
    /** @type {number[]} */
    const out = [];
    let t = afterMs;
    while (out.length < count) {
      const n = this.next(t, tz);
      if (n === null) break;
      out.push(n);
      t = n;
    }
    return out;
  }

  /**
   * @param {number} dom
   * @param {number} dow
   */
  #dayMatches(dom, dow) {
    const domOk = this.daysOfMonth.values.has(dom);
    const dowOk = this.daysOfWeek.values.has(dow);
    if (this.daysOfMonth.any && this.daysOfWeek.any) return true;
    if (this.daysOfMonth.any) return dowOk;
    if (this.daysOfWeek.any) return domOk;
    return domOk || dowOk;
  }

  /**
   * @param {string} text
   * @param {number} min
   * @param {number} max
   * @param {string[]|null} names
   * @returns {{ values: Set<number>, any: boolean }}
   */
  static #field(text, min, max, names) {
    /** @type {Set<number>} */
    const values = new Set();
    let any = false;
    for (const part of text.split(',')) {
      const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) throw new CronError(`invalid field "${text}"`);
      const [, range, stepText] = m;
      const step = stepText === undefined ? 1 : Number(stepText);
      if (step < 1) throw new CronError(`invalid step in "${text}"`);
      let lo = min;
      let hi = max;
      if (range === '*') {
        if (step === 1) any = true;
      } else {
        const [a, b] = range.split('-');
        lo = CronExpression.#value(a, min, max, names, text);
        hi = b === undefined ? (stepText === undefined ? lo : max) : CronExpression.#value(b, min, max, names, text);
        if (hi < lo) throw new CronError(`range out of order in "${text}"`);
      }
      for (let v = lo; v <= hi; v += step) values.add(v);
    }
    return { values, any };
  }

  /**
   * @param {string} token
   * @param {number} min
   * @param {number} max
   * @param {string[]|null} names
   * @param {string} field
   */
  static #value(token, min, max, names, field) {
    const named = names ? names.indexOf(token) : -1;
    const n = named !== -1 ? named + (names === CronExpression.MONTHS ? 1 : 0) : /^\d+$/.test(token) ? Number(token) : NaN;
    if (Number.isNaN(n) || n < min || n > max) throw new CronError(`value "${token}" out of range ${min}-${max} in "${field}"`);
    return n;
  }

  /**
   * @param {Set<number>} months
   * @param {Set<number>} days
   */
  static #monthHasDay(months, days) {
    const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (const m of months) for (const d of days) if (d <= lengths[m - 1]) return true;
    return false;
  }
}

export class CronError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CronError';
  }
}

/**
 * Wall-clock arithmetic: a "wall" value is `Date.UTC(...)` of the local calendar fields, so plain
 * Date math on it moves through the local calendar without timezone effects.
 */
export class WallClock {
  /** @type {Map<string, Intl.DateTimeFormat>} */
  static #formatters = new Map();

  /** @param {string} tz */
  static #formatter(tz) {
    let f = WallClock.#formatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      WallClock.#formatters.set(tz, f);
    }
    return f;
  }

  /**
   * Local calendar fields of an instant, encoded as a UTC timestamp.
   * @param {number} utcMs
   * @param {string} tz
   */
  static toWall(utcMs, tz) {
    /** @type {Record<string, number>} */
    const p = {};
    for (const part of WallClock.#formatter(tz).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }

  /**
   * Instant for local calendar fields. For a time inside a DST overlap the earlier instant wins;
   * for a time inside a gap the result is shifted forward by the gap.
   * @param {number} wallMs
   * @param {string} tz
   */
  static toUtc(wallMs, tz) {
    const offset = (/** @type {number} */ utc) => WallClock.toWall(utc, tz) - utc;
    const guess = wallMs - offset(wallMs);
    const utc = wallMs - offset(guess);
    const earlier = utc - 3_600_000;
    return WallClock.toWall(earlier, tz) === wallMs ? earlier : utc;
  }
}
