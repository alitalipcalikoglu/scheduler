import { createServer } from 'node:http';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { JobService } from '../src/domain/job-service.js';
import { ScheduleRule } from '../src/domain/schedule.js';
import { SchedulerApi } from '../src/http/scheduler-api.js';
import { HttpCaller } from '../src/net/http-caller.js';
import { NetGuard } from '../src/net/net-guard.js';
import { Signer } from '../src/net/signer.js';
import { JobStore } from '../src/store/job-store.js';
import { RunStore } from '../src/store/run-store.js';
import { Worker } from '../src/worker.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const SIGNING = 's'.repeat(40);
export const FLAGS_TOKEN = 'f'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    SCHEDULER_API_KEYS: `console:${RW_KEY},dashboard:${READ_KEY}:read,deployer:${WRITE_KEY}:write`,
    SIGNING_SECRET: SIGNING,
    TARGET_KEYS: `flags:${FLAGS_TOKEN}`,
    TARGET_ALLOW_HTTP: 'true',
    TARGET_ALLOW_PRIVATE: 'true',
    TARGET_ALLOWED_HOSTS: '127.0.0.1,api.example',
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    POLL_MS: '100',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/** A settable clock so tests control time. */
export class FakeClock {
  /** @param {number} start */
  constructor(start) {
    this.t = start;
  }

  now = () => this.t;

  /** @param {number} ms */
  advance(ms) {
    this.t += ms;
    return this.t;
  }
}

const silent = /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } });

/** Wired domain objects over an in-memory database. @param {Record<string, string>} [overrides] */
export function testService(overrides) {
  const config = testConfig(overrides);
  const clock = new FakeClock(Date.parse('2026-09-17T10:00:00Z'));
  const db = new Database(':memory:');
  const jobs = new JobStore(db);
  const runs = new RunStore(db);
  const guard = new NetGuard({ allowHttp: config.targetAllowHttp, allowPrivate: config.targetAllowPrivate, allowedHosts: config.targetAllowedHosts });
  const service = new JobService({ db, jobs, runs, guard, schedule: new ScheduleRule({ defaultTimezone: config.defaultTimezone }), options: config, now: clock.now });
  const caller = new HttpCaller({ signer: new Signer(config.signingSecret), guard, targetKeys: config.targetKeys, now: clock.now });
  const worker = new Worker({ service, jobs, runs, caller, log: silent, options: { concurrency: config.workerConcurrency, pollMs: config.pollMs, retentionDays: config.runRetentionDays, maxBackoffSec: config.maxBackoffSec }, now: clock.now });
  return { config, clock, db, jobs, runs, guard, service, caller, worker };
}

/** Fully wired Fastify app. @param {Record<string, string>} [overrides] */
export async function buildApp(overrides) {
  const t = testService(overrides);
  const app = await new SchedulerApi({ ...t, logger: silent }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

/**
 * @typedef {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string }} Received
 */

/**
 * Local HTTP target that records what it receives and answers as told.
 * @param {(req: Received) => { status: number, body?: string, delayMs?: number }} answer
 */
export async function targetServer(answer) {
  /** @type {Received[]} */
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      received.push(r);
      const a = answer(r);
      setTimeout(() => { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body ?? '{"ok":true}'); }, a.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
