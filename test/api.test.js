import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp, targetServer } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);

test('API: probes, auth and roles', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  const ready = await app.inject({ url: '/ready' });
  assert.equal(ready.statusCode, 200);
  assert.equal(json(ready).worker, 'stopped');
  assert.equal((await app.inject({ url: '/v1/jobs' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/jobs', headers: bearer('nope'.repeat(10)) })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/jobs', headers: bearer(WRITE_KEY) })).statusCode, 403, 'write-only key cannot list');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(READ_KEY), payload: {} })).statusCode, 403, 'read key cannot create');
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/nope', headers: bearer(RW_KEY) })).statusCode, 404);
  const res = await app.inject({ url: '/v1/jobs', headers: bearer(READ_KEY) });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('API: job lifecycle, listing, validation', async (t) => {
  const { app, clock } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'nightly.report', description: 'Nightly report', tags: ['reports'], schedule: { cron: '0 3 * * *', timezone: 'Europe/Istanbul' }, target: { url: 'https://api.example/reports', body: { full: true } }, targetKey: 'flags', retry: { max: 1, backoffSec: 10 } } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers.location, '/v1/jobs/nightly.report');
  let { job } = json(res);
  assert.equal(job.createdBy, 'deployer');
  assert.deepEqual(job.schedule, { cron: '0 3 * * *', timezone: 'Europe/Istanbul' });
  assert.deepEqual(job.target, { url: 'https://api.example/reports', method: 'POST', headers: {}, body: { full: true } });
  assert.deepEqual(job.retry, { max: 1, backoffSec: 10 });
  assert.equal(job.timeoutMs, 30_000);
  assert.equal(job.nextRunAt, '2026-09-18T00:00:00.000Z');
  assert.equal(job.lastRunAt, null);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'nightly.report', schedule: { cron: '@daily' }, target: { url: 'https://api.example/x' } } })).statusCode, 409);
  res = await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'Bad Name', schedule: { cron: '@daily' }, target: { url: 'https://api.example/x' } } });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'VALIDATION_FAILED');
  res = await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'x', schedule: { cron: '5 4 * * 9' }, target: { url: 'https://api.example/x' } } });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'INVALID_SCHEDULE');
  res = await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'x', schedule: { cron: '@daily' }, target: { url: 'https://api.example/x' }, targetKey: 'notify' } });
  assert.equal(json(res).error.code, 'UNKNOWN_TARGET_KEY');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'x', schedule: { cron: '@daily' }, target: { url: 'https://api.example/x' }, extra: 1 } })).statusCode, 400, 'unknown field');

  await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'cleanup', tags: ['ops'], enabled: false, schedule: { cron: '@hourly' }, target: { url: 'https://api.example/cleanup', method: 'DELETE' } } });
  await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'once', schedule: { at: '2026-09-17T12:00:00Z' }, target: { url: 'https://api.example/once' } } });
  let list = json(await app.inject({ url: '/v1/jobs', headers: bearer(READ_KEY) }));
  assert.deepEqual(list.items.map((/** @type {any} */ j) => j.name), ['cleanup', 'nightly.report', 'once']);
  assert.deepEqual(json(await app.inject({ url: '/v1/jobs?tag=ops', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ j) => j.name), ['cleanup']);
  assert.deepEqual(json(await app.inject({ url: '/v1/jobs?enabled=false', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ j) => j.name), ['cleanup']);
  assert.deepEqual(json(await app.inject({ url: '/v1/jobs?q=report', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ j) => j.name), ['nightly.report']);
  list = json(await app.inject({ url: '/v1/jobs?limit=2', headers: bearer(READ_KEY) }));
  assert.equal(list.nextCursor, 'nightly.report');
  list = json(await app.inject({ url: `/v1/jobs?limit=2&cursor=${list.nextCursor}`, headers: bearer(READ_KEY) }));
  assert.deepEqual([list.items.map((/** @type {any} */ j) => j.name), list.nextCursor], [['once'], null]);

  res = await app.inject({ method: 'PATCH', url: '/v1/jobs/cleanup', headers: bearer(WRITE_KEY), payload: { enabled: true } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).job.nextRunAt, new Date(clock.now() + 3_600_000).toISOString());
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/jobs/cleanup', headers: bearer(WRITE_KEY), payload: {} })).statusCode, 400, 'empty patch');
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/jobs/nope', headers: bearer(WRITE_KEY), payload: { enabled: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/jobs/once', headers: bearer(WRITE_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/jobs/once', headers: bearer(READ_KEY) })).statusCode, 404);
});

test('API: manual runs, run listing, cancel, and the worker end to end', async (t) => {
  const target = await targetServer((req) => ({ status: req.url === '/fail' ? 500 : 200, body: '{"done":1}' }));
  t.after(target.close);
  const { app, worker, clock } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(RW_KEY), payload: { name: 'ok', schedule: { cron: '@daily' }, target: { url: `${target.url}/ok` } } });
  await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(RW_KEY), payload: { name: 'bad', schedule: { cron: '@daily' }, target: { url: `${target.url}/fail` }, retry: { max: 3, backoffSec: 60 } } });
  let res = await app.inject({ method: 'POST', url: '/v1/jobs/ok/run', headers: { ...bearer(WRITE_KEY), 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 202, `empty JSON body accepted: ${res.body}`);
  const okRun = json(res).run;
  assert.deepEqual([okRun.job, okRun.trigger, okRun.status, okRun.attempt, okRun.maxAttempts], ['ok', 'manual', 'pending', 0, 4]);
  res = await app.inject({ method: 'POST', url: '/v1/jobs/ok/run', headers: bearer(WRITE_KEY) });
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).error.code, 'RUN_ACTIVE');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs/ok/run', headers: bearer(READ_KEY) })).statusCode, 403);
  res = await app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...bearer(WRITE_KEY), 'content-type': 'application/json' }, payload: '{bad' });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'INVALID_JSON');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...bearer(WRITE_KEY), 'content-type': 'application/json' }, payload: '' })).statusCode, 400, 'empty body on a route that needs one');
  const badRun = json(await app.inject({ method: 'POST', url: '/v1/jobs/bad/run', headers: bearer(WRITE_KEY) })).run;

  await worker.tick();
  res = await app.inject({ url: `/v1/runs/${okRun.id}`, headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200);
  let { run } = json(res);
  assert.deepEqual([run.status, run.httpStatus, run.response, run.attempt, run.attempts.length], ['succeeded', 200, '{"done":1}', 1, 1]);
  assert.equal(json(await app.inject({ url: '/v1/jobs/ok', headers: bearer(READ_KEY) })).job.lastStatus, 'succeeded');
  run = json(await app.inject({ url: `/v1/runs/${badRun.id}`, headers: bearer(READ_KEY) })).run;
  assert.equal(run.status, 'retrying');
  assert.equal(run.nextAttemptAt, new Date(clock.now() + 60_000).toISOString());

  let runs = json(await app.inject({ url: '/v1/runs', headers: bearer(READ_KEY) }));
  assert.deepEqual(runs.items.map((/** @type {any} */ r) => [r.job, r.status]), [['bad', 'retrying'], ['ok', 'succeeded']], 'newest first');
  assert.deepEqual(json(await app.inject({ url: '/v1/runs?status=succeeded', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ r) => r.job), ['ok']);
  assert.deepEqual(json(await app.inject({ url: '/v1/jobs/bad/runs', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ r) => r.id), [badRun.id]);
  runs = json(await app.inject({ url: '/v1/runs?limit=1', headers: bearer(READ_KEY) }));
  assert.equal(runs.nextBefore, String(badRun.id));
  assert.deepEqual(json(await app.inject({ url: `/v1/runs?limit=1&before=${runs.nextBefore}`, headers: bearer(READ_KEY) })).items.map((/** @type {any} */ r) => r.id), [okRun.id]);
  assert.equal((await app.inject({ url: '/v1/jobs/nope/runs', headers: bearer(READ_KEY) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/v1/runs/999', headers: bearer(READ_KEY) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/v1/runs/0', headers: bearer(READ_KEY) })).statusCode, 400);

  res = await app.inject({ method: 'POST', url: `/v1/runs/${badRun.id}/cancel`, headers: bearer(WRITE_KEY) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).run.status, 'cancelled');
  res = await app.inject({ method: 'POST', url: `/v1/runs/${okRun.id}/cancel`, headers: bearer(WRITE_KEY) });
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).error.code, 'RUN_NOT_CANCELLABLE');
  clock.advance(60_000);
  await worker.tick();
  assert.equal(target.received.filter((r) => r.url === '/fail').length, 1, 'cancelled run is not retried');

  const stats = json(await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) }));
  assert.deepEqual(stats.jobs, { total: 2, enabled: 2, scheduled: 2, nextDueAt: '2026-09-18T00:00:00.000Z' });
  assert.deepEqual(stats.runs.byStatus, { pending: 0, running: 0, retrying: 0, succeeded: 1, failed: 0, skipped: 0, cancelled: 1 });
  assert.equal(stats.runs.last24h.succeeded, 1);
  assert.equal(typeof stats.runs.avgDurationMs24h, 'number');
  assert.deepEqual(stats.worker.sinceStart, { succeeded: 1, failed: 0, retried: 1, skipped: 0 });
  const metrics = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(metrics.body, /scheduler_runs\{status="succeeded"\} 1\n/);
  assert.match(metrics.body, /scheduler_runs_finished_total\{status="succeeded"\} 1\n/);
  assert.match(metrics.body, /scheduler_attempts_retried_total 1\n/);
  assert.match(metrics.body, /scheduler_jobs\{state="enabled"\} 2\n/);
});

test('API: schedule preview, target keys, timezones', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ url: '/v1/schedule/preview?cron=0%209%20*%20*%20mon-fri&timezone=Europe/Istanbul&count=2', headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(json(res), { cron: '0 9 * * mon-fri', timezone: 'Europe/Istanbul', next: ['2026-09-18T06:00:00.000Z', '2026-09-21T06:00:00.000Z'] });
  res = await app.inject({ url: '/v1/schedule/preview?cron=bogus', headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'INVALID_SCHEDULE');
  assert.equal(json(await app.inject({ url: '/v1/schedule/preview?cron=@daily', headers: bearer(READ_KEY) })).next.length, 5);
  assert.deepEqual(json(await app.inject({ url: '/v1/target-keys', headers: bearer(READ_KEY) })), { items: ['flags'] });
  assert.ok(json(await app.inject({ url: '/v1/timezones', headers: bearer(READ_KEY) })).items.includes('Europe/Istanbul'));
});
