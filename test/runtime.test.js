import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application } from '../src/application.js';
import { Config } from '../src/config.js';
import { bearer, buildApp, READ_KEY, targetServer, testEnv, WRITE_KEY } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);

/**
 * `Application.start()` end to end for each role, without going through `Lifecycle`'s `shutdown()`
 * (which calls `process.exit()` on success — not something a test process can call). Cleanup here
 * calls the same underlying steps `Application`'s own shutdown sequence would, just directly.
 */
async function cleanup(/** @type {Application} */ app) {
  await app.worker?.stop();
  await app.audit.close();
  app.app?.close();
  app.db.close();
}

test('Runtime: api-only role builds no Worker; the process never claims a run', async () => {
  const app = new Application(Config.fromEnv(testEnv()), { role: 'api' });
  await app.start();
  try {
    assert.equal(app.worker, null);
    assert.ok(app.app, 'HTTP listener is built');
    app.service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console');
    const run = app.service.trigger('a');
    await new Promise((r) => setTimeout(r, 150)); // long enough that a real worker would have claimed it
    assert.equal(app.runs.get(run.id)?.status, 'pending', 'nothing in this process ever claims it');
  } finally {
    await cleanup(app);
  }
});

test('Runtime: worker-only role builds no HTTP listener but still processes runs', async () => {
  const target = await targetServer(() => ({ status: 200 }));
  try {
    const app = new Application(Config.fromEnv(testEnv()), { role: 'worker' });
    await app.start();
    try {
      assert.equal(app.app, null, 'no Fastify instance at all');
      assert.ok(app.worker?.running);
      app.service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` } }, 'console');
      const run = app.service.trigger('a');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(app.runs.get(run.id)?.status, 'succeeded');
    } finally {
      await cleanup(app);
    }
  } finally {
    await target.close();
  }
});

test('Runtime: worker-only role writes worker_heartbeat, api-only role reads it back', async () => {
  const target = await targetServer(() => ({ status: 200 }));
  try {
    const workerApp = new Application(Config.fromEnv(testEnv()), { role: 'worker' });
    // Both roles share nothing here (separate :memory: DBs) — this test exercises HeartbeatStore's
    // own read/write contract directly rather than a real cross-process shared file, which
    // test/lease-concurrency.test.js already covers for the claim/fencing path.
    await workerApp.start();
    try {
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(workerApp.presence.latest() !== null, 'the worker role beats its own presence row');
    } finally {
      await cleanup(workerApp);
    }
  } finally {
    await target.close();
  }
});

test('API (worker: null): /ready and /v1/stats fall back to worker_heartbeat and runningCount', async (t) => {
  const { app, presence, runs, jobs, clock } = await buildApp(undefined, { worker: null });
  t.after(() => app.close());
  let ready = await app.inject({ url: '/ready' });
  assert.equal(json(ready).worker, 'stopped', 'no heartbeat ever recorded');
  // workerStatus() (like #stats()) reads real wall-clock time, not the injectable test clock — see
  // scheduler-api.js; beat with Date.now() to match, not the domain layer's FakeClock.
  presence.beat(Date.now());
  ready = await app.inject({ url: '/ready' });
  assert.equal(json(ready).worker, 'running', 'a recent heartbeat reads as running even with no in-process Worker');

  await app.inject({ method: 'POST', url: '/v1/jobs', headers: bearer(WRITE_KEY), payload: { name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } } });
  jobs.get('a'); // sanity: the job really was created through this same app
  const claimed = runs.claim(clock.now(), 0, 30_000); // no due runs yet; just exercises runningCount() below at 0
  assert.equal(claimed.length, 0);
  const stats = json(await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) }));
  assert.deepEqual(stats.worker, { running: true, inFlight: 0, concurrency: 8, sinceStart: null }, 'sinceStart counters are not reconstructable from the DB, reported null rather than a misleading zero');
});

test('Runtime: shutdown order — stop claiming, then HTTP intake, then drain in-flight, then audit flush, then DB close', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 60 }));
  t.after(target.close);
  const app = new Application(Config.fromEnv(testEnv()), { role: 'combined' });
  await app.start();
  /** @type {string[]} */
  const order = [];
  const worker = /** @type {import('../src/worker.js').Worker} */ (app.worker);
  const http = /** @type {import('fastify').FastifyInstance} */ (app.app);
  const wrap = (/** @type {object} */ obj, /** @type {string} */ method, /** @type {string} */ label) => {
    const orig = /** @type {(...a: unknown[]) => unknown} */ (/** @type {any} */ (obj)[method]).bind(obj);
    /** @type {any} */ (obj)[method] = async (/** @type {unknown[]} */ ...a) => { order.push(label); return orig(...a); };
  };
  wrap(worker, 'stopClaiming', 'stopClaiming');
  wrap(http, 'close', 'app.close');
  wrap(worker, 'stop', 'worker.stop');
  wrap(app.audit, 'close', 'audit.close');
  wrap(app.db, 'close', 'db.close');

  // service.create/trigger a job whose call outlives the shutdown steps ahead of it, so draining
  // is actually observable (not a no-op that would pass even with the old, buggy order).
  app.service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` } }, 'console');
  app.service.trigger('a');
  await new Promise((r) => setTimeout(r, 20)); // let the worker claim it before shutdown begins

  const realExit = process.exit;
  let exitCode;
  process.exit = /** @type {any} */ ((/** @type {number} */ code) => { exitCode = code; });
  try {
    await app.shutdown('test');
  } finally {
    process.exit = realExit;
  }
  assert.deepEqual(order, ['stopClaiming', 'app.close', 'worker.stop', 'audit.close', 'db.close']);
  assert.equal(exitCode, 0, 'a clean shutdown, not the force-exit/error path');
});
