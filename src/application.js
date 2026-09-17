import { Config } from './config.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
import { Database } from './db.js';
import { JobService } from './domain/job-service.js';
import { ScheduleRule } from './domain/schedule.js';
import { SchedulerApi } from './http/scheduler-api.js';
import { ConsoleLogger } from '@atc-web/service-core/log';
import { HttpCaller } from './net/http-caller.js';
import { NetGuard } from '@atc-web/service-core/http';
import { readServiceVersion } from '@atc-web/service-core/fastify';
import { Signer } from './net/signer.js';
import { HeartbeatStore } from './store/heartbeat-store.js';
import { JobStore } from './store/job-store.js';
import { RunStore } from './store/run-store.js';
import { Worker } from './worker.js';

/** @typedef {'combined'|'api'|'worker'} Role */

/**
 * Composition root: wires configuration, storage, domain, outbound calls, HTTP and the worker,
 * and owns the process lifecycle.
 *
 * `role` (Stage 6) picks which of the two runtimes this process actually runs:
 *   - `'combined'` (default, what `src/index.js` uses): both — today's behavior, unchanged.
 *   - `'api'` (`src/api-main.js`): HTTP only, no `Worker` — never claims a run. Readiness/stats
 *     read worker liveness from `worker_heartbeat` (`HeartbeatStore`) and in-flight count from
 *     `runs` directly, since there's no in-process `Worker` object to ask.
 *   - `'worker'` (`src/worker-main.js`): `Worker` only, no HTTP listener at all — not even for
 *     health checks; PM2's own process state is the liveness signal for this role.
 * Every role shares the same `Config`, the same database, the same migrations — nothing about the
 * persistence or environment contract differs by role.
 */
export class Application {
  /**
   * @param {Config} config
   * @param {{ role?: Role }} [opts]
   */
  constructor(config, { role = 'combined' } = {}) {
    this.config = config;
    this.role = role;
    this.audit = new AuditClient({ target: config.audit });
    this.version = readServiceVersion(import.meta.url);
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.jobs = new JobStore(this.db);
    this.runs = new RunStore(this.db);
    this.presence = new HeartbeatStore(this.db);
    const guard = new NetGuard({ allowHttp: config.targetAllowHttp, allowPrivate: config.targetAllowPrivate, allowedHosts: config.targetAllowedHosts });
    this.service = new JobService({ db: this.db, jobs: this.jobs, runs: this.runs, guard, schedule: new ScheduleRule({ defaultTimezone: config.defaultTimezone }), options: config });
    this.caller = new HttpCaller({ signer: new Signer(config.signingSecret), guard, targetKeys: config.targetKeys });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /**
   * Build from `process.env`; exits with a readable message on bad configuration.
   * @param {{ role?: Role }} [opts]
   */
  static fromEnv(opts) {
    try {
      return new Application(Config.fromEnv(), opts);
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config, role } = this;
    const runsApi = role !== 'worker';
    const runsWorker = role !== 'api';

    /** @type {import('./types.js').MinimalLogger} */
    let log = new ConsoleLogger({ level: /** @type {any} */ (config.logLevel) });

    if (runsWorker) {
      // Stage 6.1: drainMs bounds the worker's own wait for in-flight calls, strictly less than
      // forceExitMs below (same call-timeout ceiling, smaller margin) so a stuck drain logs and
      // lets the remaining shutdown steps at least attempt to run before the process force-exits.
      this.worker = new Worker({ service: this.service, jobs: this.jobs, runs: this.runs, presence: this.presence, caller: this.caller, log: log.child({ component: 'worker' }), options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.runRetentionDays, maxBackoffSec: config.maxBackoffSec, leaseMs: config.leaseMs, heartbeatMs: config.heartbeatMs, drainMs: config.drainMs } });
    }

    /** @type {(() => (void|Promise<void>))[]} */
    const steps = [];

    if (runsApi) {
      const api = new SchedulerApi({ config, audit: this.audit, service: this.service, jobs: this.jobs, runs: this.runs, presence: this.presence, worker: this.worker, db: this.db, version: this.version });
      const app = await api.build();
      this.app = app;
      log = app.log;
      if (this.worker) this.worker.log = app.log.child({ component: 'worker' });
    }

    // Shutdown order (Stage 6 fix): stop claiming new work first, then stop HTTP intake, THEN
    // drain whatever the worker already had in flight, THEN flush audit, THEN close the DB. Audit
    // used to flush before the worker drained — any event a still-draining run's outcome needed to
    // record could be queued into a buffer that had already been flushed and stopped, and would
    // then sit unflushed until process exit. `worker.stop()` now has its own bounded drain wait
    // (`drainMs` above, Stage 6.1) strictly shorter than `forceExitMs` below, so a stuck drain logs
    // and moves on to the remaining steps before the whole process gets force-killed.
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stopClaiming());
    if (this.app) steps.push(() => this.app?.close());
    if (this.worker) steps.push(() => /** @type {Worker} */ (this.worker).stop());
    steps.push(() => this.audit.close());
    steps.push(() => this.db.close());

    const { shutdown } = Lifecycle.install({ forceExitMs: config.forceExitMs, log, steps });
    this.shutdown = shutdown;
    this.audit.logger = log;
    this.audit.start();

    if (this.app) {
      await this.app.listen({ port: config.port, host: config.host });
      this.app.log.info({ tls: config.tls !== null, role, jobs: this.jobs.counts().total, targetKeys: [...config.targetKeys.keys()] }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    } else {
      log.info({ role }, 'worker-only process: no HTTP listener');
    }
    if (this.worker) this.worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
