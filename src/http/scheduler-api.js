import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/service-core/audit';
import { createErrorHandler, jsonParser, registerInfo, registerProbes } from '@atc-web/service-core/fastify';
import { SchedulerError } from '../domain/errors.js';
import { RunStore } from '../store/run-store.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/**
 * HTTP surface: job management (write role), runs, previews and stats (read role).
 *
 * `worker` is `null` in the API-only role (Stage 6, `src/api-main.js`) — there is no in-process
 * `Worker` to read `.running`/`.inFlight`/`.counters` from, so readiness and stats fall back to
 * `presence` (`worker_heartbeat`, is ANY worker process alive right now) and `runs.runningCount()`
 * (how many runs are in flight, durable and true regardless of which process is running them).
 * `counters` (succeeded/failed/retried/skipped *since this process started*) has no DB-backed
 * equivalent by design — it is inherently per-process — so it reports `null` from an API-only
 * process rather than a misleading always-zero.
 */
export class SchedulerApi {
  static READY_CACHE_MS = 10_000;
  static STATS_WINDOW_MS = 86_400_000;
  /** A worker_heartbeat row older than this many worker heartbeat intervals is considered dead. */
  static PRESENCE_STALE_FACTOR = 4;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/job-service.js').JobService} deps.service
   * @param {import('../store/job-store.js').JobStore} deps.jobs
   * @param {import('../store/run-store.js').RunStore} deps.runs
   * @param {import('../store/heartbeat-store.js').HeartbeatStore} deps.presence
   * @param {import('../worker.js').Worker|null} deps.worker
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, jobs, runs, presence, worker, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.jobs = jobs;
    this.runs = runs;
    this.presence = presence;
    this.worker = worker;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** `'running'`/`'stopped'`, from the in-process `Worker` when there is one, else from `worker_heartbeat`. @param {number} [now] */
  workerStatus(now = Date.now()) {
    if (this.worker) return this.worker.running ? 'running' : 'stopped';
    const seenAt = this.presence.latest();
    return seenAt !== null && now - seenAt < this.config.heartbeatMs * SchedulerApi.PRESENCE_STALE_FACTOR ? 'running' : 'stopped';
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    // Action endpoints (run, cancel) take no body; clients that always send a JSON content type must not get a parse error.
    jsonParser(app);
    app.setErrorHandler(createErrorHandler(SchedulerError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), { cacheMs: SchedulerApi.READY_CACHE_MS, extra: () => ({ worker: this.workerStatus() }) });
    registerInfo(app, {
      service: 'scheduler',
      version: this.version,
      capabilities: ['cron-schedule', 'one-off-schedule', 'retry-backoff', 'http-target'],
      schemaVersion: this.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }


  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    // Role checks run before body validation so a wrong role gets 403, not a schema error.
    const read = { preValidation: ApiKeyAuth.require('read') };
    const write = { preValidation: ApiKeyAuth.require('write') };
    const name = (/** @type {FastifyRequest} */ r) => /** @type {{ name: string }} */ (r.params).name;
    const id = (/** @type {FastifyRequest} */ r) => Number(/** @type {{ id: string }} */ (r.params).id);
    const query = (/** @type {FastifyRequest} */ r) => /** @type {Record<string, string|undefined>} */ (r.query);

    // ---- jobs
    api.post('/jobs', { config: { audit: AuditClient.route('scheduler.job.create', (_r, b) => ({ type: 'job', id: b.job.name })) }, ...write, schema: { body: Schemas.create } }, async (request, reply) => {
      const row = s.create(/** @type {any} */ (request.body), request.apiKey.id);
      reply.header('location', `/v1/jobs/${row.name}`);
      return reply.code(201).send({ job: Views.job(row) });
    });

    api.get('/jobs', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = query(request);
      const { items, nextCursor } = s.list({ q: q.q, tag: q.tag, enabled: q.enabled === undefined ? undefined : q.enabled === 'true' }, { limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor });
      return { items: items.map(Views.job), nextCursor };
    });

    api.get('/jobs/:name', { ...read, schema: { params: Schemas.nameParams } }, async (request) => ({ job: Views.job(s.get(name(request))) }));

    api.patch('/jobs/:name', { config: { audit: AuditClient.route('scheduler.job.update', (r) => ({ type: 'job', id: /** @type {any} */ (r.params).name }), (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.nameParams, body: Schemas.patch } }, async (request) => ({ job: Views.job(s.update(name(request), /** @type {any} */ (request.body))) }));

    api.delete('/jobs/:name', { config: { audit: AuditClient.route('scheduler.job.delete', (r) => ({ type: 'job', id: /** @type {any} */ (r.params).name })) }, ...write, schema: { params: Schemas.nameParams } }, async (request, reply) => {
      s.remove(name(request));
      return reply.code(204).send();
    });

    api.post('/jobs/:name/run', { config: { audit: AuditClient.route('scheduler.job.run', (r) => ({ type: 'job', id: /** @type {any} */ (r.params).name }), (_r, b) => ({ run: b?.run?.id })) }, ...write, schema: { params: Schemas.nameParams } }, async (request, reply) => reply.code(202).send({ run: Views.run(s.trigger(name(request))) }));

    api.get('/jobs/:name/runs', { ...read, schema: { params: Schemas.nameParams, querystring: Schemas.runsQuery } }, async (request) => {
      s.get(name(request));
      return this.#runs({ ...query(request), job: name(request) });
    });

    // ---- runs
    api.get('/runs', { ...read, schema: { querystring: Schemas.runsQuery } }, async (request) => this.#runs(query(request)));
    api.get('/runs/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => ({ run: Views.run(s.run(id(request))) }));
    api.post('/runs/:id/cancel', { config: { audit: AuditClient.route('scheduler.run.cancel', (r) => ({ type: 'run', id: /** @type {any} */ (r.params).id })) }, ...write, schema: { params: Schemas.idParams } }, async (request) => ({ run: Views.run(s.cancelRun(id(request))) }));

    // ---- helpers for operators and consoles
    api.get('/schedule/preview', { ...read, schema: { querystring: Schemas.previewQuery } }, async (request) => {
      const q = query(request);
      const p = s.preview(/** @type {string} */ (q.cron), q.timezone, q.count ? Number(q.count) : 5);
      return { ...p, next: p.next.map((t) => new Date(t).toISOString()) };
    });
    api.get('/target-keys', read, async () => ({ items: [...this.config.targetKeys.keys()].sort() }));
    api.get('/timezones', read, async () => ({ items: Intl.supportedValuesOf('timeZone') }));

    api.get('/stats', read, async () => this.#stats());
  }

  /** @param {Record<string, string|undefined>} q */
  #runs(q) {
    const limit = q.limit ? Number(q.limit) : 50;
    const rows = this.runs.list({ jobName: q.job, status: /** @type {any} */ (q.status) }, { limit: limit + 1, beforeId: q.before ? Number(q.before) : undefined });
    const items = rows.slice(0, limit);
    return { items: items.map(Views.run), nextBefore: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  #stats() {
    const now = Date.now();
    const j = this.jobs.counts();
    const r = this.runs.stats(now - SchedulerApi.STATS_WINDOW_MS);
    return {
      jobs: { total: j.total, enabled: j.enabled, scheduled: j.scheduled, nextDueAt: Views.iso(j.nextDueAt) },
      runs: { byStatus: r.byStatus, last24h: r.recentByStatus, avgDurationMs24h: r.recentAvgDurationMs, topFailures24h: r.recentFailures },
      worker: this.worker
        ? { running: this.worker.running, inFlight: this.worker.inFlight.size, concurrency: this.config.workerConcurrency, sinceStart: { ...this.worker.counters } }
        : { running: this.workerStatus(now) === 'running', inFlight: this.runs.runningCount(), concurrency: this.config.workerConcurrency, sinceStart: null },
    };
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preValidation: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const j = this.jobs.counts();
      const r = this.runs.stats(Date.now() - SchedulerApi.STATS_WINDOW_MS);
      // Process-local since-start counters: zero (not omitted) from an API-only process — honest,
      // since this process itself never finished a run, rather than a gap a scraper has to explain.
      const c = this.worker?.counters ?? { succeeded: 0, failed: 0, retried: 0, skipped: 0 };
      const inFlight = this.worker ? this.worker.inFlight.size : this.runs.runningCount();
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP scheduler_jobs Jobs by state.',
        '# TYPE scheduler_jobs gauge',
        `scheduler_jobs{state="enabled"} ${j.enabled}`,
        `scheduler_jobs{state="disabled"} ${j.total - j.enabled}`,
        '# HELP scheduler_runs Stored runs by status.',
        '# TYPE scheduler_runs gauge',
        ...RunStore.STATUSES.map((s) => `scheduler_runs{status="${s}"} ${r.byStatus[s]}`),
        '# HELP scheduler_runs_finished_total Run outcomes since process start. Zero from an API-only process (this role never finishes a run itself).',
        '# TYPE scheduler_runs_finished_total counter',
        `scheduler_runs_finished_total{status="succeeded"} ${c.succeeded}`,
        `scheduler_runs_finished_total{status="failed"} ${c.failed}`,
        `scheduler_runs_finished_total{status="skipped"} ${c.skipped}`,
        '# HELP scheduler_attempts_retried_total Attempts that failed and were rescheduled since process start. Zero from an API-only process.',
        '# TYPE scheduler_attempts_retried_total counter',
        `scheduler_attempts_retried_total ${c.retried}`,
        '# HELP scheduler_in_flight Calls currently executing (durable, from the runs table, when this process has no worker of its own).',
        '# TYPE scheduler_in_flight gauge',
        `scheduler_in_flight ${inFlight}`,
        '# HELP scheduler_worker_up 1 if a worker process is currently alive (this process itself, or another one reporting through worker_heartbeat), else 0.',
        '# TYPE scheduler_worker_up gauge',
        `scheduler_worker_up ${this.workerStatus() === 'running' ? 1 : 0}`,
        '# HELP scheduler_next_due_seconds Seconds until the next scheduled firing (negative = overdue), -1 when nothing is scheduled.',
        '# TYPE scheduler_next_due_seconds gauge',
        `scheduler_next_due_seconds ${j.nextDueAt === null ? -1 : ((j.nextDueAt - Date.now()) / 1000).toFixed(0)}`,
        '# HELP scheduler_process_uptime_seconds Process uptime.',
        '# TYPE scheduler_process_uptime_seconds gauge',
        `scheduler_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
