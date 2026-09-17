import { Config } from './config.js';
import { AuditClient } from './net/audit-client.js';
import { Database } from './db.js';
import { JobService } from './domain/job-service.js';
import { ScheduleRule } from './domain/schedule.js';
import { SchedulerApi } from './http/scheduler-api.js';
import { HttpCaller } from './net/http-caller.js';
import { NetGuard } from './net/net-guard.js';
import { Signer } from './net/signer.js';
import { JobStore } from './store/job-store.js';
import { RunStore } from './store/run-store.js';
import { Worker } from './worker.js';

/**
 * Composition root: wires configuration, storage, domain, outbound calls, HTTP and the worker,
 * and owns the process lifecycle.
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath);
    this.jobs = new JobStore(this.db);
    this.runs = new RunStore(this.db);
    const guard = new NetGuard({ allowHttp: config.targetAllowHttp, allowPrivate: config.targetAllowPrivate, allowedHosts: config.targetAllowedHosts });
    this.service = new JobService({ db: this.db, jobs: this.jobs, runs: this.runs, guard, schedule: new ScheduleRule({ defaultTimezone: config.defaultTimezone }), options: config });
    this.caller = new HttpCaller({ signer: new Signer(config.signingSecret), guard, targetKeys: config.targetKeys });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Worker|null} */
    this.worker = null;
    this.shuttingDown = false;
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const worker = new Worker({ service: this.service, jobs: this.jobs, runs: this.runs, caller: this.caller, log: /** @type {any} */ (console), options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.runRetentionDays, maxBackoffSec: config.maxBackoffSec } });
    this.worker = worker;
    const api = new SchedulerApi({ config, audit: this.audit, service: this.service, jobs: this.jobs, runs: this.runs, worker, db: this.db });
    const app = await api.build();
    this.app = app;
    worker.log = app.log.child({ component: 'worker' });
    this.#installSignalHandlers(app.log);
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, jobs: this.jobs.counts().total, targetKeys: [...config.targetKeys.keys()] }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, this.config.maxTimeoutMs + 10_000).unref();
    try {
      await this.app?.close();
      await this.audit.close();
      await this.worker?.stop();
      this.db.close();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
