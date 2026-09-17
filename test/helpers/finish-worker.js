import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { RunStore } from '../../src/store/run-store.js';

/**
 * Attempts one `finish()` (or, when `reclaim` is set, one `reclaimExpired()`) from its own
 * connection — real cross-connection concurrency for `test/lease-concurrency.test.js`.
 * @type {{ path: string, id: number, ownerToken?: string, now: number, reclaim?: boolean }}
 */
const { path, id, ownerToken, now, reclaim } = workerData;

/** See claim-worker.js's identical helper for why this retry exists. @returns {Database} */
function openWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return new Database(path);
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test(/** @type {Error} */ (err).message)) throw err;
      const until = Date.now() + 10;
      while (Date.now() < until);
    }
  }
}

const db = openWithRetry();
const runs = new RunStore(db);
if (reclaim) {
  const rows = runs.reclaimExpired(now, (run) => ({ status: 'failed', finishedAt: now, durationMs: 0, httpStatus: null, response: null, error: 'lease expired', attempts: JSON.parse(run.attempts), nextAttemptAt: null }));
  db.close();
  parentPort?.postMessage({ reclaimed: rows.map((r) => r.id) });
} else {
  const updated = runs.finish(id, /** @type {string} */ (ownerToken), { status: 'succeeded', finishedAt: now, durationMs: 1, httpStatus: 200, response: null, error: null, attempts: [], nextAttemptAt: null });
  db.close();
  parentPort?.postMessage({ ok: updated !== null });
}
