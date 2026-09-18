import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signer } from '../src/net/signer.js';
import { FLAGS_TOKEN, SIGNING, targetServer, testService } from './helpers.js';

const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(t).toISOString());

test('Worker: successful call carries signature, run headers, bearer token and body', async (t) => {
  const target = await targetServer(() => ({ status: 200, body: '{"received":true}' }));
  t.after(target.close);
  const { service, worker, runs, jobs, clock } = testService();
  service.create({ name: 'sync', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/v1/flags/x/envs/prod`, method: 'PATCH', headers: { 'X-Tenant': 'a' }, body: { enabled: true } }, targetKey: 'flags' }, 'console', clock.now());
  const run = service.trigger('sync', clock.now());
  await worker.tick();
  const r = /** @type {import('../src/types.js').RunRow} */ (runs.get(run.id));
  assert.equal(r.status, 'succeeded', r.error ?? '');
  assert.equal(r.http_status, 200);
  assert.equal(r.response, '{"received":true}');
  assert.equal(r.attempt, 1);
  assert.equal(JSON.parse(r.attempts).length, 1);
  assert.ok(r.finished_at !== null && r.duration_ms !== null);
  assert.equal(jobs.get('sync')?.last_status, 'succeeded');
  const [req] = target.received;
  assert.equal(req.method, 'PATCH');
  assert.equal(req.url, '/v1/flags/x/envs/prod');
  assert.equal(req.body, '{"enabled":true}');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers.authorization, `Bearer ${FLAGS_TOKEN}`);
  assert.equal(req.headers['x-tenant'], 'a');
  assert.equal(req.headers['x-scheduler-job'], 'sync');
  assert.equal(req.headers['x-scheduler-run'], String(run.id));
  assert.equal(req.headers['x-scheduler-attempt'], '1');
  // Post-production Phase 5 security regression: a job target is operator-configured external —
  // never receives platform trace/request-id headers.
  assert.equal('traceparent' in req.headers, false);
  assert.equal('x-request-id' in req.headers, false);
  assert.ok(new Signer(SIGNING).verify(req.body, String(req.headers['x-scheduler-signature']), { now: clock.now() }), 'signature verifies against the raw body');
  assert.deepEqual(worker.counters, { succeeded: 1, failed: 0, retried: 0, skipped: 0 });
});

test('Worker: GET without body signs the empty string and sends no token without targetKey', async (t) => {
  const target = await targetServer(() => ({ status: 204, body: '' }));
  t.after(target.close);
  const { service, worker, runs, clock } = testService();
  service.create({ name: 'ping', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/ping?x=1`, method: 'GET' } }, 'console', clock.now());
  const run = service.trigger('ping', clock.now());
  await worker.tick();
  assert.equal(runs.get(run.id)?.status, 'succeeded');
  const [req] = target.received;
  assert.equal(req.method, 'GET');
  assert.equal(req.body, '');
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers['content-length'], '0');
  assert.ok(new Signer(SIGNING).verify('', String(req.headers['x-scheduler-signature']), { now: clock.now() }));
});

test('Worker: retryable failures back off exponentially, then succeed', async (t) => {
  let calls = 0;
  const target = await targetServer(() => (++calls < 3 ? { status: 503, body: 'busy' } : { status: 200 }));
  t.after(target.close);
  const { service, worker, runs, jobs, clock } = testService();
  service.create({ name: 'flaky', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` }, retry: { max: 2, backoffSec: 5 } }, 'console', clock.now());
  const run = service.trigger('flaky', clock.now());
  await worker.tick();
  let r = /** @type {import('../src/types.js').RunRow} */ (runs.get(run.id));
  assert.equal(r.status, 'retrying');
  assert.match(String(r.error), /responded 503: busy/);
  assert.equal(r.http_status, 503);
  assert.equal(iso(r.next_attempt_at), iso(clock.now() + 5_000));
  assert.equal(jobs.get('flaky')?.last_status, null, 'no outcome recorded until the run finishes');
  await worker.tick();
  assert.equal(runs.get(run.id)?.attempt, 1, 'not due yet, not claimed');
  clock.advance(5_000);
  await worker.tick();
  r = /** @type {import('../src/types.js').RunRow} */ (runs.get(run.id));
  assert.equal(r.status, 'retrying');
  assert.equal(r.attempt, 2);
  assert.equal(iso(r.next_attempt_at), iso(clock.now() + 10_000), 'doubled');
  clock.advance(10_000);
  await worker.tick();
  r = /** @type {import('../src/types.js').RunRow} */ (runs.get(run.id));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.attempt, 3);
  assert.deepEqual(JSON.parse(r.attempts).map((/** @type {any} */ a) => [a.n, a.httpStatus, a.error === null]), [[1, 503, false], [2, 503, false], [3, 200, true]]);
  assert.equal(r.error, null, 'error cleared on success');
  assert.equal(jobs.get('flaky')?.last_status, 'succeeded');
  assert.deepEqual(worker.counters, { succeeded: 1, failed: 0, retried: 2, skipped: 0 });
});

test('Worker: non-retryable status fails at once; exhausted retries fail', async (t) => {
  const target = await targetServer((req) => ({ status: req.url === '/gone' ? 404 : 500 }));
  t.after(target.close);
  const { service, worker, runs, jobs, clock } = testService();
  service.create({ name: 'gone', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/gone` }, retry: { max: 5 } }, 'console', clock.now());
  service.create({ name: 'broken', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/broken` }, retry: { max: 1, backoffSec: 1 } }, 'console', clock.now());
  const gone = service.trigger('gone', clock.now());
  const broken = service.trigger('broken', clock.now());
  await worker.tick();
  assert.equal(runs.get(gone.id)?.status, 'failed');
  assert.equal(runs.get(gone.id)?.attempt, 1);
  assert.equal(runs.get(broken.id)?.status, 'retrying');
  clock.advance(1_000);
  await worker.tick();
  assert.equal(runs.get(broken.id)?.status, 'failed');
  assert.equal(runs.get(broken.id)?.attempt, 2);
  assert.equal(jobs.get('broken')?.last_status, 'failed');
  assert.equal(target.received.length, 3);
  assert.deepEqual(worker.counters, { succeeded: 0, failed: 2, retried: 1, skipped: 0 });
});

test('Worker: timeouts and unreachable hosts are retryable; blocked targets are not', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 400 }));
  t.after(target.close);
  const { service, worker, runs, clock, config } = testService();
  service.create({ name: 'slow', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/slow` }, timeoutMs: 1000 }, 'console', clock.now());
  // Shorten the stored timeout below the server delay; the API minimum is 1000 ms.
  service.jobs.update({ .../** @type {any} */ (service.jobs.get('slow')), timeout_ms: 100 });
  service.create({ name: 'down', schedule: { cron: '* * * * *' }, target: { url: 'http://127.0.0.1:9/x' } }, 'console', clock.now());
  service.create({ name: 'blocked', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` }, targetKey: 'flags' }, 'console', clock.now());
  config.targetKeys.delete('flags'); // key removed from the environment after the job was saved
  const slow = service.trigger('slow', clock.now());
  const down = service.trigger('down', clock.now());
  const blocked = service.trigger('blocked', clock.now());
  await worker.tick();
  assert.equal(runs.get(slow.id)?.status, 'retrying');
  assert.match(String(runs.get(slow.id)?.error), /timed out after 100ms/);
  assert.equal(runs.get(down.id)?.status, 'retrying');
  assert.match(String(runs.get(down.id)?.error), /ECONNREFUSED/);
  assert.equal(runs.get(blocked.id)?.status, 'failed', 'missing target key cannot heal by retrying');
  assert.match(String(runs.get(blocked.id)?.error), /target key "flags" is not configured/);
});

test('Worker: scheduled firings, overlap skip, concurrency and recovery after a crash', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 300 }));
  t.after(target.close);
  const { service, worker, runs, jobs, clock } = testService({ WORKER_CONCURRENCY: '1' });
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/a` } }, 'console', clock.now());
  service.create({ name: 'b', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/b` } }, 'console', clock.now());
  clock.advance(60_000);
  await worker.tick();
  const list = runs.list({}, { limit: 10 });
  assert.deepEqual(list.map((r) => [r.job_name, r.status]).sort(), [['a', 'succeeded'], ['b', 'pending']], 'one slot: a ran, b waits');
  await worker.tick();
  assert.deepEqual(runs.list({}, { limit: 10 }).map((r) => r.status), ['succeeded', 'succeeded']);
  assert.equal(iso(jobs.get('a')?.next_run_at ?? null), iso(clock.now() + 60_000));

  // Simulate a crash: claim without executing, then recover with a fresh worker on the same store.
  clock.advance(60_000);
  service.fireDue(clock.now());
  const [claimed] = runs.claim(clock.now(), 1, 30_000); // default LEASE_MS
  assert.equal(claimed.status, 'running');
  clock.advance(60_000);
  const [skipped] = service.fireDue(clock.now()).filter((r) => r.job_name === claimed.job_name);
  assert.equal(skipped.status, 'skipped', 'a running run blocks the next firing');
  worker.recover();
  const recovered = /** @type {import('../src/types.js').RunRow} */ (runs.get(claimed.id));
  assert.equal(recovered.status, 'retrying');
  assert.equal(recovered.error, 'interrupted by restart');
  assert.equal(recovered.attempt, 1);
  assert.equal(iso(recovered.next_attempt_at), iso(clock.now() + 30_000));
});

test('Worker: maintenance purges finished runs past retention', async () => {
  const { service, worker, runs, clock } = testService({ RUN_RETENTION_DAYS: '7' });
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  const old = clock.now() - 8 * 86_400_000;
  runs.insert({ jobName: 'a', trigger: 'schedule', status: 'skipped', scheduledFor: old, maxAttempts: 1, error: 'x' }, old);
  runs.insert({ jobName: 'a', trigger: 'schedule', status: 'pending', scheduledFor: old, maxAttempts: 1, nextAttemptAt: clock.now() + 3_600_000 }, old);
  runs.insert({ jobName: 'a', trigger: 'schedule', status: 'skipped', scheduledFor: clock.now(), maxAttempts: 1, error: 'x' }, clock.now());
  worker.lastMaintenance = 0;
  await worker.tick();
  assert.deepEqual(runs.list({}, { limit: 10 }).map((r) => r.status), ['skipped', 'pending'], 'old skipped purged; queued and recent kept');
});
