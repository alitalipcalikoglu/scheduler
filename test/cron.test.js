import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CronExpression, CronError, WallClock } from '../src/domain/cron.js';

const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(t).toISOString());
const at = (/** @type {string} */ s) => Date.parse(s);

test('cron: parsing lists, ranges, steps, names, aliases and errors', () => {
  const c = new CronExpression('*/15 9-17 1,15 jan-mar,dec mon-fri');
  assert.deepEqual([...c.minutes.values], [0, 15, 30, 45]);
  assert.deepEqual([...c.hours.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.daysOfMonth.values], [1, 15]);
  assert.deepEqual([...c.months.values], [1, 2, 3, 12]);
  assert.deepEqual([...c.daysOfWeek.values], [1, 2, 3, 4, 5]);
  assert.equal(new CronExpression('@daily').expression, '0 0 * * *');
  assert.ok(new CronExpression('0 0 * * 7').daysOfWeek.values.has(0), '7 means Sunday');
  assert.deepEqual([...new CronExpression('5/20 * * * *').minutes.values], [5, 25, 45], 'value/step runs to the end of the range');
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '1-0 * * *  *', '*/0 * * * *', 'a * * * *', '0 0 31 feb *', '0 0 30 2 *']) {
    assert.throws(() => new CronExpression(bad), CronError, bad);
  }
  assert.ok(new CronExpression('0 0 29 2 *'), 'leap day is a valid schedule');
});

test('cron: next firing in UTC, month and day rollover', () => {
  const c = new CronExpression('30 4 1 * *');
  assert.equal(iso(c.next(at('2026-09-17T12:00:00Z'), 'UTC')), '2026-10-01T04:30:00.000Z');
  assert.equal(iso(c.next(at('2026-10-01T04:30:00Z'), 'UTC')), '2026-11-01T04:30:00.000Z', 'strictly after');
  assert.equal(iso(new CronExpression('0 0 29 2 *').next(at('2026-01-01T00:00:00Z'), 'UTC')), '2028-02-29T00:00:00.000Z');
  assert.equal(iso(new CronExpression('* * * * *').next(at('2026-09-17T12:00:30.500Z'), 'UTC')), '2026-09-17T12:01:00.000Z');
  assert.equal(iso(new CronExpression('0 9 * * 1-5').next(at('2026-09-18T10:00:00Z'), 'UTC')), '2026-09-21T09:00:00.000Z', 'Friday after 9 → Monday');
  assert.equal(iso(new CronExpression('0 12 13 * fri').next(at('2026-09-17T00:00:00Z'), 'UTC')), '2026-09-18T12:00:00.000Z', 'dom OR dow when both restricted');
  assert.equal(iso(new CronExpression('0 12 13 * fri').next(at('2026-11-07T00:00:00Z'), 'UTC')), '2026-11-13T12:00:00.000Z');
  assert.deepEqual(new CronExpression('0 0 1 1 *').upcoming(at('2026-01-01T00:00:00Z'), 'UTC', 3).map(iso), ['2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z']);
});

test('cron: timezones and daylight saving', () => {
  assert.equal(iso(new CronExpression('0 9 * * *').next(at('2026-09-17T05:00:00Z'), 'Europe/Istanbul')), '2026-09-17T06:00:00.000Z', 'UTC+3');
  assert.equal(iso(new CronExpression('0 9 * * *').next(at('2026-09-17T07:00:00Z'), 'America/New_York')), '2026-09-17T13:00:00.000Z', 'EDT');
  // Spring forward in Berlin on 2026-03-29: 02:00 → 03:00; 02:30 does not exist and is skipped.
  assert.equal(iso(new CronExpression('30 2 * * *').next(at('2026-03-28T12:00:00Z'), 'Europe/Berlin')), '2026-03-30T00:30:00.000Z');
  // Fall back on 2026-10-25: 02:30 occurs twice (00:30Z and 01:30Z); it fires once, at the first.
  const c = new CronExpression('30 2 * * *');
  const first = c.next(at('2026-10-24T12:00:00Z'), 'Europe/Berlin');
  assert.equal(iso(first), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(c.next(/** @type {number} */ (first), 'Europe/Berlin')), '2026-10-26T01:30:00.000Z', 'next day, now CET');
  assert.ok(CronExpression.isTimezone('Europe/Istanbul'));
  assert.ok(!CronExpression.isTimezone('Mars/Olympus'));
  assert.equal(WallClock.toWall(at('2026-09-17T06:00:00Z'), 'Europe/Istanbul'), at('2026-09-17T09:00:00Z'));
  assert.equal(WallClock.toUtc(at('2026-09-17T09:00:00Z'), 'Europe/Istanbul'), at('2026-09-17T06:00:00Z'));
});
