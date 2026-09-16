import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { SchedulerError } from '../domain/errors.js';
import { RunStore } from '../store/run-store.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/** HTTP surface: job management (write role), runs, previews and stats (read role). */
export class SchedulerApi {
  static READY_CACHE_MS = 10_000;
  static STATS_WINDOW_MS = 86_400_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/job-service.js').JobService} deps.service
   * @param {import('../store/job-store.js').JobStore} deps.jobs
   * @param {import('../store/run-store.js').RunStore} deps.runs
   * @param {import('../worker.js').Worker} deps.worker
   * @param {import('../db.js').Database} deps.db
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, service, jobs, runs, worker, db, logger }) {
    this.config = config;
    this.service = service;
    this.jobs = jobs;
    this.runs = runs;
    this.worker = worker;
    this.db = db;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.readyCache = { at: 0, ok: false, error: '' };
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
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      if (body === '') return done(null, undefined);
      try {
        done(null, JSON.parse(/** @type {string} */ (body)));
      } catch {
        done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
      }
    });
    app.setErrorHandler(this.#errorHandler);
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
    });
    this.#registerProbes(app);
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err instanceof SchedulerError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {FastifyInstance} app */
  #registerProbes(app) {
    app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
    app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
      const ready = this.#readiness();
      if (!ready.ok) {
        app.log.warn({ error: ready.error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', error: ready.error });
      }
      return { status: 'ok', worker: this.worker.running ? 'running' : 'stopped' };
    });
  }

  #readiness() {
    const now = Date.now();
    if (now - this.readyCache.at > SchedulerApi.READY_CACHE_MS) {
      try {
        this.db.ping();
        this.readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        this.readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.readyCache;
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
    api.post('/jobs', { ...write, schema: { body: Schemas.create } }, async (request, reply) => {
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

    api.patch('/jobs/:name', { ...write, schema: { params: Schemas.nameParams, body: Schemas.patch } }, async (request) => ({ job: Views.job(s.update(name(request), /** @type {any} */ (request.body))) }));

    api.delete('/jobs/:name', { ...write, schema: { params: Schemas.nameParams } }, async (request, reply) => {
      s.remove(name(request));
      return reply.code(204).send();
    });

    api.post('/jobs/:name/run', { ...write, schema: { params: Schemas.nameParams } }, async (request, reply) => reply.code(202).send({ run: Views.run(s.trigger(name(request))) }));

    api.get('/jobs/:name/runs', { ...read, schema: { params: Schemas.nameParams, querystring: Schemas.runsQuery } }, async (request) => {
      s.get(name(request));
      return this.#runs({ ...query(request), job: name(request) });
    });

    // ---- runs
    api.get('/runs', { ...read, schema: { querystring: Schemas.runsQuery } }, async (request) => this.#runs(query(request)));
    api.get('/runs/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => ({ run: Views.run(s.run(id(request))) }));
    api.post('/runs/:id/cancel', { ...write, schema: { params: Schemas.idParams } }, async (request) => ({ run: Views.run(s.cancelRun(id(request))) }));

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
      worker: { running: this.worker.running, inFlight: this.worker.inFlight.size, concurrency: this.config.workerConcurrency, sinceStart: { ...this.worker.counters } },
    };
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preValidation: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const j = this.jobs.counts();
      const r = this.runs.stats(Date.now() - SchedulerApi.STATS_WINDOW_MS);
      const c = this.worker.counters;
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP scheduler_jobs Jobs by state.',
        '# TYPE scheduler_jobs gauge',
        `scheduler_jobs{state="enabled"} ${j.enabled}`,
        `scheduler_jobs{state="disabled"} ${j.total - j.enabled}`,
        '# HELP scheduler_runs Stored runs by status.',
        '# TYPE scheduler_runs gauge',
        ...RunStore.STATUSES.map((s) => `scheduler_runs{status="${s}"} ${r.byStatus[s]}`),
        '# HELP scheduler_runs_finished_total Run outcomes since process start.',
        '# TYPE scheduler_runs_finished_total counter',
        `scheduler_runs_finished_total{status="succeeded"} ${c.succeeded}`,
        `scheduler_runs_finished_total{status="failed"} ${c.failed}`,
        `scheduler_runs_finished_total{status="skipped"} ${c.skipped}`,
        '# HELP scheduler_attempts_retried_total Attempts that failed and were rescheduled since process start.',
        '# TYPE scheduler_attempts_retried_total counter',
        `scheduler_attempts_retried_total ${c.retried}`,
        '# HELP scheduler_in_flight Calls currently executing.',
        '# TYPE scheduler_in_flight gauge',
        `scheduler_in_flight ${this.worker.inFlight.size}`,
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
