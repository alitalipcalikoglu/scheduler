import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { RunStore } from '../../src/store/run-store.js';

/**
 * Runs inside its own OS thread with its own SQLite connection to the SAME database file every
 * sibling thread points at — real cross-connection concurrency for `test/lease-concurrency.test.js`.
 * @type {{ path: string, now: number, leaseMs: number, batch: number, attempts: number }}
 */
const { path, now, leaseMs, batch, attempts } = workerData;

/**
 * `new Database(path)` runs a `CREATE TABLE IF NOT EXISTS schema_migrations` on every open; many
 * threads opening their first connection to the same file at once can occasionally hit
 * `SQLITE_LOCKED` (not `SQLITE_BUSY` — `busy_timeout` doesn't cover it) during that bootstrap DDL.
 * A short retry here is about tolerating that connection-open race, not the claim logic under test.
 * @returns {Database}
 */
function openWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return new Database(path);
    } catch (err) {
      if (attempt >= 20 || !/locked|busy/i.test(/** @type {Error} */ (err).message)) throw err;
      const until = Date.now() + 10;
      while (Date.now() < until); // node:sqlite is synchronous; a real sleep would need worker_threads' Atomics.wait
    }
  }
}

const db = openWithRetry();
const runs = new RunStore(db);
/** @type {number[]} */
const claimed = [];
for (let i = 0; i < attempts; i++) {
  for (const r of runs.claim(now, batch, leaseMs)) claimed.push(r.id);
}
db.close();
parentPort?.postMessage({ claimed });
