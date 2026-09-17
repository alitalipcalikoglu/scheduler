import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database } from '../src/db.js';
import { JobService } from '../src/domain/job-service.js';
import { ScheduleRule } from '../src/domain/schedule.js';
import { HttpCaller } from '../src/net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { Signer } from '../src/net/signer.js';
import { HeartbeatStore } from '../src/store/heartbeat-store.js';
import { JobStore } from '../src/store/job-store.js';
import { RunStore } from '../src/store/run-store.js';
import { Worker } from '../src/worker.js';
import { SIGNING, targetServer, testService } from './helpers.js';

const T = Date.parse('2026-09-17T10:00:00Z');

const silent = /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } });

test('RunStore: claim hands out a fresh owner_token and lease_until per row', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.create({ name: 'b', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/y' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  service.trigger('b', clock.now());
  const [r1, r2] = runs.claim(clock.now(), 2, 30_000);
  assert.ok(r1.owner_token && r2.owner_token && r1.owner_token !== r2.owner_token, 'distinct tokens');
  assert.equal(r1.lease_until, clock.now() + 30_000);
  assert.equal(r2.lease_until, clock.now() + 30_000);
});

test('RunStore: finish is a no-op once the owner_token no longer matches (fencing)', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 30_000);
  const staleToken = /** @type {string} */ (run.owner_token);
  // Simulate a reclaim: someone else finishes it, or claims and finishes it, changing owner_token.
  const finished = runs.finish(run.id, staleToken, { status: 'succeeded', finishedAt: clock.now(), durationMs: 5, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.ok(finished, 'the real owner succeeds');
  const late = runs.finish(run.id, staleToken, { status: 'failed', finishedAt: clock.now(), durationMs: 999, httpStatus: null, response: null, error: 'late', attempts: [], nextAttemptAt: null });
  assert.equal(late, null, 'a second finish with the same (now-stale) token changes nothing');
  assert.equal(runs.get(run.id)?.status, 'succeeded', 'the real outcome stands');
});

test('RunStore: heartbeat renews lease_until only while the token still owns the row', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 30_000);
  const token = /** @type {string} */ (run.owner_token);
  clock.advance(10_000);
  assert.equal(runs.heartbeat(run.id, token, clock.now(), 30_000), true);
  assert.equal(runs.get(run.id)?.lease_until, clock.now() + 30_000, 'renewed forward from the heartbeat instant, not the original claim');
  runs.finish(run.id, token, { status: 'succeeded', finishedAt: clock.now(), durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.equal(runs.heartbeat(run.id, token, clock.now(), 30_000), false, 'no longer running: heartbeat after completion is rejected');
});

test('RunStore: reclaimExpired is atomic against a concurrent heartbeat for the SAME row (no torn reclaim)', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 10_000);
  const token = /** @type {string} */ (run.owner_token);
  clock.advance(20_000); // lease now expired
  const reclaimed = runs.reclaimExpired(clock.now(), (r) => ({ status: 'failed', finishedAt: clock.now(), durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null }));
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].status, 'failed');
  // The original owner's heartbeat, arriving after the reclaim, is rejected — proves the reclaim
  // really did take ownership away, not just relabel the row while leaving it claimable.
  assert.equal(runs.heartbeat(run.id, token, clock.now(), 10_000), false);
});

test('RunStore: reclaimExpired ignores a row whose lease was renewed before the sweep (no false reclaim)', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 10_000);
  const token = /** @type {string} */ (run.owner_token);
  clock.advance(9_000);
  assert.equal(runs.heartbeat(run.id, token, clock.now(), 10_000), true, 'renewed just before the original lease would have expired');
  clock.advance(9_000); // 18s since claim; would be expired under the ORIGINAL lease, not the renewed one
  const reclaimed = runs.reclaimExpired(clock.now(), (r) => ({ status: 'failed', finishedAt: clock.now(), durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null }));
  assert.equal(reclaimed.length, 0, 'the renewed lease is still live');
  assert.equal(runs.get(run.id)?.status, 'running');
});

test('Worker: recover() only reclaims EXPIRED leases, not a lease still within its TTL', () => {
  const { service, runs, worker, clock } = testService({ LEASE_MS: '5000', HEARTBEAT_MS: '1000' });
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 5_000);
  worker.recover(); // lease not expired yet — must not steal a run another live process could still own
  assert.equal(runs.get(run.id)?.status, 'running');
  clock.advance(6_000);
  worker.recover();
  assert.equal(runs.get(run.id)?.status, 'retrying', 'now expired, recovered as a failed attempt');
});

test('Worker: a late-returning owner cannot overwrite a run another worker already reclaimed and re-executed', async (t) => {
  const target = await targetServer(() => ({ status: 200 }));
  t.after(target.close);
  const { service, runs, clock } = testService({ LEASE_MS: '5000', HEARTBEAT_MS: '1000' });
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` } }, 'console', clock.now());
  const triggered = service.trigger('a', clock.now());
  const [claimed] = runs.claim(clock.now(), 1, 5_000);
  const staleToken = /** @type {string} */ (claimed.owner_token);
  clock.advance(6_000); // this worker's lease is now expired; it is still "about to" finish, unaware
  // A second worker reclaims the run (in-loop sweep) as a failed/retrying attempt.
  const worker2 = new Worker({ service, jobs: service.jobs, runs, presence: new HeartbeatStore(new Database(':memory:')), caller: new HttpCaller({ signer: new Signer(SIGNING), guard: new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: [] }), targetKeys: new Map() }), log: silent, options: { concurrency: 1, pollMs: 100, retentionDays: 30, maxBackoffSec: 3600, leaseMs: 5_000, heartbeatMs: 1_000, drainMs: 5_000 }, now: clock.now });
  worker2.recover();
  const afterReclaim = runs.get(triggered.id);
  assert.equal(afterReclaim?.status, 'retrying');
  const reclaimedToken = afterReclaim?.owner_token;
  assert.notEqual(reclaimedToken, staleToken);
  // The ORIGINAL (now-stale) worker finally finishes its long-dead call and tries to record success.
  const late = runs.finish(triggered.id, staleToken, { status: 'succeeded', finishedAt: clock.now(), durationMs: 6_500, httpStatus: 200, response: '{}', error: null, attempts: [], nextAttemptAt: null });
  assert.equal(late, null, 'rejected: the stale token no longer owns this row');
  assert.equal(runs.get(triggered.id)?.status, 'retrying', 'the reclaim outcome stands, not the late success');
});

test('Worker: heartbeat keeps a long in-flight call owned across the original lease window', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 260 }));
  t.after(target.close);
  // Real wall-clock time here (not the FakeClock) — the heartbeat interval is a real timer and
  // needs real elapsed time to fire more than once during the delayed call.
  const db = new Database(':memory:');
  const jobs = new JobStore(db);
  const runs = new RunStore(db);
  const presence = new HeartbeatStore(db);
  const guard = new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: [] });
  const service = new JobService({ db, jobs, runs, guard, schedule: new ScheduleRule({ defaultTimezone: 'UTC' }), options: { targetKeys: new Map(), defaultTimeoutMs: 5000, maxTimeoutMs: 10000, maxRetries: 5, maxBackoffSec: 60, maxBodyBytes: 16384 } });
  const caller = new HttpCaller({ signer: new Signer(SIGNING), guard, targetKeys: new Map() });
  const worker = new Worker({ service, jobs, runs, presence, caller, log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, maxBackoffSec: 60, leaseMs: 120, heartbeatMs: 40, drainMs: 5_000 } });
  service.create({ name: 'slow', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` }, timeoutMs: 2000 }, 'console');
  const run = service.trigger('slow');
  await worker.tick();
  const r = runs.get(run.id);
  assert.equal(r?.status, 'succeeded', r?.error ?? 'should have succeeded, not lost the lease to its own dead heartbeat');
  assert.equal(r?.attempt, 1, 'exactly one attempt — nothing reclaimed it out from under the still-heartbeating worker');
});

test('Worker: without a heartbeat, a call longer than the lease is reclaimable mid-flight by a sweep', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 200 }));
  t.after(target.close);
  const db = new Database(':memory:');
  const jobs = new JobStore(db);
  const runs = new RunStore(db);
  const presence = new HeartbeatStore(db);
  const guard = new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: [] });
  const service = new JobService({ db, jobs, runs, guard, schedule: new ScheduleRule({ defaultTimezone: 'UTC' }), options: { targetKeys: new Map(), defaultTimeoutMs: 5000, maxTimeoutMs: 10000, maxRetries: 5, maxBackoffSec: 60, maxBodyBytes: 16384 } });
  const caller = new HttpCaller({ signer: new Signer(SIGNING), guard, targetKeys: new Map() });
  // heartbeatMs longer than the whole call: the lease will lapse before any renewal fires.
  const worker = new Worker({ service, jobs, runs, presence, caller, log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, maxBackoffSec: 60, leaseMs: 60, heartbeatMs: 10_000, drainMs: 5_000 } });
  service.create({ name: 'slow', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/x` }, timeoutMs: 2000 }, 'console');
  const run = service.trigger('slow');
  const executing = worker.tick(); // fire the claim + call, don't await yet
  await new Promise((resolve) => setTimeout(resolve, 90)); // past the 60ms lease, call still in flight
  const sweep = new Worker({ service, jobs, runs, presence: new HeartbeatStore(new Database(':memory:')), caller, log: silent, options: { concurrency: 1, pollMs: 50, retentionDays: 30, maxBackoffSec: 60, leaseMs: 60, heartbeatMs: 10_000, drainMs: 5_000 } });
  sweep.recover();
  const mid = runs.get(run.id);
  assert.equal(mid?.status, 'retrying', 'reclaimed while the original call was still outstanding');
  await executing; // let the original call's late finish() attempt run — must not overwrite
  const final = runs.get(run.id);
  assert.equal(final?.status, 'retrying', 'the late, fenced-out completion did not overwrite the reclaim');
});

test('Worker: completion arriving exactly at the lease boundary is accepted (boundary is inclusive of a live owner)', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 1_000);
  const token = /** @type {string} */ (run.owner_token);
  clock.advance(1_000); // now === lease_until exactly
  const finished = runs.finish(run.id, token, { status: 'succeeded', finishedAt: clock.now(), durationMs: 1000, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  assert.ok(finished, 'finish is guarded by owner_token + status only, never by lease_until — a completion race with a concurrent reclaim at this instant is resolved by whichever transaction commits first, not by an off-by-one on the boundary itself');
});

test('RunStore: reclaimExpired exact-boundary invariant — now == lease_until is NOT yet expired (Stage 6.1)', () => {
  const { service, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  const [run] = runs.claim(clock.now(), 1, 1_000);
  const leaseUntil = /** @type {number} */ (run.lease_until);
  const decide = (/** @type {any} */ r) => ({ status: /** @type {const} */ ('failed'), finishedAt: leaseUntil, durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(r.attempts), nextAttemptAt: null });
  assert.deepEqual(runs.reclaimExpired(leaseUntil, decide), [], 'now === lease_until: still valid, same invariant as claim/heartbeat/finish');
  assert.equal(runs.get(run.id)?.status, 'running');
  const reclaimed = runs.reclaimExpired(leaseUntil + 1, decide);
  assert.equal(reclaimed.length, 1, 'one ms later: now expired');
});

test('Worker: stopClaiming() stops new claims but lets in-flight work finish, drained by stop()', async (t) => {
  const target = await targetServer(() => ({ status: 200, delayMs: 150 }));
  t.after(target.close);
  const { service, worker, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/a` } }, 'console', clock.now());
  service.create({ name: 'b', schedule: { cron: '* * * * *' }, target: { url: `${target.url}/b` } }, 'console', clock.now());
  const runA = service.trigger('a', clock.now());
  worker.start(); // claims run A synchronously, before start() even returns (see worker.js's #run)
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs.get(runA.id)?.status, 'running', 'claimed and in flight (the target sleeps 150ms)');
  worker.stopClaiming();
  const runB = service.trigger('b', clock.now()); // queued, but claiming is stopped
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs.get(runB.id)?.status, 'pending', 'never claimed after stopClaiming()');
  await worker.stop();
  assert.equal(runs.get(runA.id)?.status, 'succeeded', 'work claimed before stopClaiming() still finished');
  assert.equal(runs.get(runB.id)?.status, 'pending', 'still untouched after full stop');
});

test('Worker: stop() is bounded by drainMs even if an in-flight call never resolves (Stage 6.1)', async () => {
  const { service, jobs, runs, clock } = testService();
  service.create({ name: 'a', schedule: { cron: '* * * * *' }, target: { url: 'https://api.example/x' } }, 'console', clock.now());
  service.trigger('a', clock.now());
  /** @type {[object, string][]} */
  const errors = [];
  const log = /** @type {any} */ ({
    info() {}, warn() {}, debug() {}, fatal() {}, child() { return this; },
    error(/** @type {object} */ obj, /** @type {string} */ msg) { errors.push([obj, msg]); },
  });
  const stuckCaller = { call: () => new Promise(() => {}) };
  const worker = new Worker({ service, jobs, runs, presence: new HeartbeatStore(new Database(':memory:')), caller: /** @type {any} */ (stuckCaller), log, options: { concurrency: 1, pollMs: 20, retentionDays: 30, maxBackoffSec: 60, leaseMs: 30_000, heartbeatMs: 1_000, drainMs: 100 }, now: clock.now });
  worker.start();
  const deadline = Date.now() + 2_000;
  while (runs.list({}, { limit: 1 })[0]?.status !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  const startedStop = Date.now();
  await worker.stop();
  const elapsed = Date.now() - startedStop;
  assert.ok(elapsed < 1_000, `stop() must not hang forever; took ${elapsed}ms with drainMs=100`);
  assert.equal(errors.length, 1, 'logs exactly the drain-timeout error');
  assert.match(errors[0][1], /drain timed out/);
});
