import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SchedulerError } from '../src/domain/errors.js';
import { JobService } from '../src/domain/job-service.js';
import { Signer } from '../src/net/signer.js';
import { NetGuard } from '../src/net/net-guard.js';
import { testService } from './helpers.js';

const T0 = Date.parse('2026-09-17T10:00:00Z');
const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(t).toISOString());

test('JobService: create computes the next firing; validation', () => {
  const { service, clock } = testService();
  const job = service.create({ name: 'nightly', schedule: { cron: '0 3 * * *', timezone: 'Europe/Istanbul' }, target: { url: 'https://api.example/report', method: 'post', headers: { 'X-Tenant': 'a' }, body: { full: true } }, targetKey: 'flags', tags: ['Reports', 'reports', ' ops '] }, 'console', T0);
  assert.equal(iso(job.next_run_at), '2026-09-18T00:00:00.000Z', '03:00 Istanbul = 00:00Z');
  assert.deepEqual(JSON.parse(job.target), { url: 'https://api.example/report', method: 'POST', headers: { 'x-tenant': 'a' }, body: { full: true } });
  assert.deepEqual(JSON.parse(job.tags), ['ops', 'reports']);
  assert.deepEqual(JSON.parse(job.retry), JobService.DEFAULT_RETRY);
  assert.equal(job.timeout_ms, 30_000);
  const at = service.create({ name: 'once', schedule: { at: '2026-09-17T12:00:00Z' }, target: { url: 'https://api.example/x' } }, 'console', T0);
  assert.equal(iso(at.next_run_at), '2026-09-17T12:00:00.000Z');
  const paused = service.create({ name: 'paused', enabled: false, schedule: { cron: '@hourly' }, target: { url: 'https://api.example/x' } }, 'console', T0);
  assert.equal(paused.next_run_at, null);

  const fails = (/** @type {any} */ input, /** @type {string} */ code, /** @type {RegExp} */ re) => assert.throws(() => service.create({ name: 'bad', ...input }, 'console', clock.now()), (e) => e instanceof SchedulerError && e.code === code && re.test(e.message), `${code}: ${re}`);
  const ok = { schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } };
  fails({ schedule: { cron: '0 3 * * *' }, target: { url: 'https://api.example/x' }, name: 'nightly' }, 'JOB_EXISTS', /already exists/);
  fails({ ...ok, schedule: { cron: '61 * * * *' } }, 'INVALID_SCHEDULE', /out of range/);
  fails({ ...ok, schedule: { cron: '* * * * *', timezone: 'Nowhere/City' } }, 'INVALID_SCHEDULE', /unknown timezone/);
  fails({ ...ok, schedule: { at: '2020-01-01T00:00:00Z' } }, 'INVALID_SCHEDULE', /in the future/);
  fails({ ...ok, schedule: { at: 'tomorrow' } }, 'INVALID_SCHEDULE', /ISO 8601/);
  fails({ ...ok, schedule: {} }, 'INVALID_SCHEDULE', /either cron/);
  fails({ ...ok, target: { url: 'ftp://api.example/x' } }, 'INVALID_TARGET', /scheme/);
  fails({ ...ok, target: { url: 'https://user:pw@api.example/x' } }, 'INVALID_TARGET', /credentials/);
  fails({ ...ok, target: { url: 'https://other.example/x' } }, 'INVALID_TARGET', /TARGET_ALLOWED_HOSTS/);
  fails({ ...ok, target: { url: 'https://api.example/x', method: 'HEAD' } }, 'INVALID_TARGET', /method/);
  fails({ ...ok, target: { url: 'https://api.example/x', headers: { Authorization: 'Bearer x' } } }, 'INVALID_TARGET', /use targetKey/);
  fails({ ...ok, target: { url: 'https://api.example/x', headers: { 'X-Scheduler-Run': '1' } } }, 'INVALID_TARGET', /not allowed/);
  fails({ ...ok, target: { url: 'https://api.example/x', headers: { 'X-A': 'ünïcode' } } }, 'INVALID_TARGET', /printable ASCII/);
  fails({ ...ok, target: { url: 'https://api.example/x', method: 'GET', body: {} } }, 'INVALID_TARGET', /cannot carry a body/);
  fails({ ...ok, target: { url: 'https://api.example/x', body: 'x'.repeat(20_000) } }, 'BODY_TOO_LARGE', /limit/);
  fails({ ...ok, targetKey: 'notify' }, 'UNKNOWN_TARGET_KEY', /TARGET_KEYS/);
  fails({ ...ok, timeoutMs: 500 }, 'INVALID_TARGET', /timeoutMs/);
  fails({ ...ok, retry: { max: 50 } }, 'INVALID_TARGET', /retry.max/);
  fails({ ...ok, retry: { backoffSec: 0 } }, 'INVALID_TARGET', /backoffSec/);
});

test('JobService: update, pause and resume keep the next firing consistent', () => {
  const { service, clock } = testService();
  service.create({ name: 'j', schedule: { cron: '0 * * * *' }, target: { url: 'https://api.example/x' } }, 'console', T0);
  assert.equal(iso(service.get('j').next_run_at), '2026-09-17T11:00:00.000Z');
  clock.advance(30 * 60_000);
  assert.equal(iso(service.update('j', { description: 'd' }, clock.now()).next_run_at), '2026-09-17T11:00:00.000Z', 'unrelated patch keeps the pointer');
  assert.equal(service.update('j', { enabled: false }, clock.now()).next_run_at, null, 'paused → no next firing');
  clock.advance(60 * 60_000); // 11:30
  assert.equal(iso(service.update('j', { enabled: true }, clock.now()).next_run_at, ), '2026-09-17T12:00:00.000Z', 'resumed → recomputed from now, the missed 11:00 is not fired');
  assert.equal(iso(service.update('j', { schedule: { cron: '*/10 * * * *' } }, clock.now()).next_run_at), '2026-09-17T11:40:00.000Z', 'new schedule → recomputed');
  assert.equal(JSON.parse(service.update('j', { retry: { max: 0 } }, clock.now()).retry).backoffSec, 30, 'partial retry patch keeps the other field');
  assert.throws(() => service.update('nope', { enabled: true }), (e) => e instanceof SchedulerError && e.code === 'JOB_NOT_FOUND');
  service.remove('j');
  assert.throws(() => service.get('j'), (e) => e instanceof SchedulerError && e.code === 'JOB_NOT_FOUND');
});

test('JobService: firing, overlap, manual trigger and cancel', () => {
  const { service, runs, jobs, clock } = testService();
  service.create({ name: 'j', schedule: { cron: '0 * * * *' }, target: { url: 'https://api.example/x' }, retry: { max: 2 } }, 'console', T0);
  service.create({ name: 'once', schedule: { at: '2026-09-17T11:00:00Z' }, target: { url: 'https://api.example/x' } }, 'console', T0);
  assert.deepEqual(service.fireDue(clock.now()), [], 'nothing due yet');
  clock.advance(61 * 60_000); // 11:01
  const fired = service.fireDue(clock.now());
  assert.deepEqual(fired.map((r) => [r.job_name, r.status, r.max_attempts]), [['j', 'pending', 3], ['once', 'pending', 4]]);
  assert.equal(iso(jobs.get('j')?.next_run_at ?? null), '2026-09-17T12:00:00.000Z');
  assert.equal(jobs.get('once')?.next_run_at, null, 'one-shot job has no next firing');
  assert.equal(iso(fired[0].scheduled_for), '2026-09-17T11:00:00.000Z');
  assert.throws(() => service.trigger('j', clock.now()), (e) => e instanceof SchedulerError && e.code === 'RUN_ACTIVE');

  clock.advance(60 * 60_000); // 12:01, the 11:00 run is still pending (no worker)
  const [skipped] = service.fireDue(clock.now());
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.error, 'previous run still active');
  assert.equal(jobs.get('j')?.last_status, 'skipped');
  assert.equal(iso(jobs.get('j')?.next_run_at ?? null), '2026-09-17T13:00:00.000Z', 'pointer advanced even when skipped');

  const cancelled = service.cancelRun(fired[0].id, clock.now());
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => service.cancelRun(skipped.id), (e) => e instanceof SchedulerError && e.code === 'RUN_NOT_CANCELLABLE');
  const manual = service.trigger('j', clock.now());
  assert.deepEqual([manual.trigger, manual.status, iso(manual.next_attempt_at)], ['manual', 'pending', iso(clock.now())]);
  assert.equal(runs.list({ jobName: 'j' }, { limit: 10 }).length, 3);
  service.remove('j');
  assert.equal(runs.list({ jobName: 'j' }, { limit: 10 }).length, 0, 'runs deleted with the job');
  assert.throws(() => service.run(manual.id), (e) => e instanceof SchedulerError && e.code === 'RUN_NOT_FOUND');
});

test('JobService: preview and backoff', () => {
  const { service } = testService();
  const p = service.preview('0 9 * * mon-fri', 'Europe/Istanbul', 3, T0);
  assert.deepEqual(p.next.map(iso), ['2026-09-18T06:00:00.000Z', '2026-09-21T06:00:00.000Z', '2026-09-22T06:00:00.000Z']);
  assert.equal(p.timezone, 'Europe/Istanbul');
  assert.equal(service.preview('@daily', undefined, 1, T0).timezone, 'UTC');
  assert.deepEqual([1, 2, 3, 4, 10].map((n) => JobService.backoffMs({ max: 10, backoffSec: 30 }, n, 3600)), [30_000, 60_000, 120_000, 240_000, 3_600_000]);
});

test('Signer and NetGuard', async () => {
  const s = new Signer('secret'.repeat(6));
  const header = s.sign('{"a":1}', 1_758_000_000);
  assert.match(header, /^t=1758000000,v1=[0-9a-f]{64}$/);
  assert.ok(s.verify('{"a":1}', header, { now: 1_758_000_100_000 }));
  assert.ok(!s.verify('{"a":2}', header, { now: 1_758_000_100_000 }), 'body mismatch');
  assert.ok(!s.verify('{"a":1}', header, { now: 1_758_001_000_000 }), 'too old');
  const g = new NetGuard({ allowHttp: false, allowedHosts: ['api.example'] });
  assert.equal(g.check('https://sub.api.example/x').hostname, 'sub.api.example');
  assert.throws(() => g.check('http://api.example/x'), /scheme/);
  assert.throws(() => g.check('https://api.example.evil/x'), /TARGET_ALLOWED_HOSTS/);
  await assert.rejects(new NetGuard().resolve('https://127.0.0.1/x'), /non-public/);
  assert.equal((await new NetGuard({ allowPrivate: true }).resolve('https://10.0.0.5/x')).address, '10.0.0.5');
  assert.ok(NetGuard.isPublicAddress('93.184.216.34'));
  assert.ok(!NetGuard.isPublicAddress('::ffff:10.0.0.1'));
});
