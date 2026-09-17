import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { JobStore } from '../src/store/job-store.js';
import { RunStore } from '../src/store/run-store.js';

const CLAIM_WORKER = fileURLToPath(new URL('./helpers/claim-worker.js', import.meta.url));
const FINISH_WORKER = fileURLToPath(new URL('./helpers/finish-worker.js', import.meta.url));

/** @param {string} path @param {object} workerData */
function run(path, workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path, { workerData });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

/** @param {string} dir */
function tempDb(dir) {
  const path = join(dir, 'scheduler.db');
  const db = new Database(path);
  const jobs = new JobStore(db);
  const runs = new RunStore(db);
  return { path, db, jobs, runs };
}

// The single most important claim invariant, proven with REAL cross-connection concurrency (not
// same-process Promise.all): several OS threads, each with its own SQLite connection to the same
// file, racing to claim the same small set of due runs must never both succeed for one row.
test('Concurrency: several real connections racing for the same due runs never double-claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-claim-'));
  try {
    const { path, db, jobs, runs } = tempDb(dir);
    const now = Date.now();
    jobs.insert({ name: 'a', description: '', tags: '[]', enabled: 1, schedule: '{}', target: '{}', target_key: null, timeout_ms: 1000, retry: '{}', next_run_at: null, last_run_at: null, last_status: null, created_by: 'test', created_at: now, updated_at: now });
    const N_RUNS = 12;
    for (let i = 0; i < N_RUNS; i++) runs.insert({ jobName: 'a', trigger: 'manual', status: 'pending', scheduledFor: now, maxAttempts: 3, nextAttemptAt: now }, now);
    db.close();

    const THREADS = 6;
    const results = await Promise.all(Array.from({ length: THREADS }, () => run(CLAIM_WORKER, { path, now, leaseMs: 30_000, batch: 3, attempts: 4 })));
    const allClaimed = results.flatMap((r) => /** @type {{ claimed: number[] }} */ (r).claimed);
    assert.equal(allClaimed.length, N_RUNS, 'every run claimed exactly once across all threads combined');
    assert.equal(new Set(allClaimed).size, N_RUNS, 'no run id claimed twice');

    const verify = new Database(path);
    const check = new RunStore(verify);
    const byStatus = check.stats(0).byStatus;
    assert.equal(byStatus.running, N_RUNS, 'every run moved to running exactly once');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Concurrency: a reclaim from one connection fences out a finish() from another, real connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-fence-'));
  try {
    const { path, db, jobs, runs } = tempDb(dir);
    const now = Date.now();
    jobs.insert({ name: 'a', description: '', tags: '[]', enabled: 1, schedule: '{}', target: '{}', target_key: null, timeout_ms: 1000, retry: '{}', next_run_at: null, last_run_at: null, last_status: null, created_by: 'test', created_at: now, updated_at: now });
    const inserted = runs.insert({ jobName: 'a', trigger: 'manual', status: 'pending', scheduledFor: now, maxAttempts: 3, nextAttemptAt: now }, now);
    const [claimed] = runs.claim(now, 1, 1_000); // 1s lease
    const staleToken = /** @type {string} */ (claimed.owner_token);
    db.close();

    const later = now + 5_000; // well past the 1s lease
    const reclaimResult = /** @type {{ reclaimed: number[] }} */ (await run(FINISH_WORKER, { path, id: inserted.id, now: later, reclaim: true }));
    assert.deepEqual(reclaimResult.reclaimed, [inserted.id], 'a separate connection reclaimed the expired lease');

    const lateFinish = /** @type {{ ok: boolean }} */ (await run(FINISH_WORKER, { path, id: inserted.id, ownerToken: staleToken, now: later + 1 }));
    assert.equal(lateFinish.ok, false, 'the original (stale-token) owner cannot finish it from a separate connection after the reclaim');

    const verify = new Database(path);
    const check = new RunStore(verify);
    assert.equal(check.get(inserted.id)?.status, 'failed', 'the reclaim outcome stands');
    verify.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
