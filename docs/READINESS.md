# `scheduler` readiness contract

## Purpose

`scheduler` lets the rest of the platform define cron and one-shot jobs that fire signed HTTP
calls into other services' endpoints on a schedule, with retries, timezone-aware timing, one
active run per job, and full run history — so a service that needs "call me at 3am" or "call me
in 20 minutes" does not need to build its own timer, retry logic or SSRF guard.

## Dependencies

- `audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional. Both env vars unset means audit forwarding is
  off entirely (`Config.#parseAudit` returns `null`); both must be set together or `Config.fromEnv`
  refuses to start. When configured, write/security events are buffered in memory and sent in the
  background (`src/net/audit-client.js`) — `audit` being down or slow never blocks or fails the
  triggering API request; events are retried and eventually dropped with a log line (see "Retry
  policy"). Not required at startup beyond the both-or-neither env check.
- Job targets (the URL each job calls, e.g. `flags`, `notify`, any HTTP endpoint named in a job's
  `target.url`): not a startup dependency at all — jobs are arbitrary and validated individually.
  `TARGET_KEYS` (bearer tokens a job can reference by name) is optional and defaults to empty; a
  job referencing an unconfigured key is rejected at creation time (`UNKNOWN_TARGET_KEY`), not at
  call time.
- No other outbound service dependency. `scheduler` does not call `auth`, `gateway`, or any other
  platform service to do its own work.

## Persistence

SQLite via `node:sqlite`'s `DatabaseSync` (built into Node 22.13+, no driver dependency). File
path from `DB_PATH`, default `./data/scheduler.db` (the Docker image overrides this to
`/data/scheduler.db`, a declared `VOLUME`). Opened with `PRAGMA journal_mode = WAL`,
`synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON` (`src/db.js`).

Schema (`Database.MIGRATIONS[0]`):
- `jobs` — one row per job: name (primary key), description, tags (JSON array), enabled flag,
  schedule (JSON), target (JSON), target_key, timeout_ms, retry policy (JSON), next_run_at,
  last_run_at/last_status, created_by/created_at/updated_at. Index `jobs_due` on `next_run_at`
  (partial: enabled jobs with a pointer) for the poll query.
- `runs` — one row per firing/attempt-history: id, job_name (FK to `jobs`, `ON DELETE CASCADE`),
  trigger, status, scheduled_for, attempt, max_attempts, next_attempt_at, started/finished_at,
  duration_ms, http_status, response, error, attempts (JSON array), created_at. Indexes:
  `runs_job` (history lookups), `runs_due` (partial, the claim query), `runs_active` (partial, the
  overlap check), `runs_status`, `runs_created` (retention purge).

Migration mechanism: `Database.MIGRATIONS` is an ordered array of SQL strings; `#migrate()` reads
`PRAGMA user_version`, and for every migration index at or above it, runs the SQL inside
`BEGIN`/`COMMIT` and bumps `user_version`, rolling back on any failure. Today there is exactly one
migration (the full initial schema). A fresh install starts at `user_version = 0` and applies it,
landing on `user_version = 1`. An upgrade (this service redeployed with a newer version that adds
migration entries) would apply only the new entries above the stored `user_version`; that path is
unexercised today since no second migration exists yet.

## Health endpoint

`GET /health` (`src/http/scheduler-api.js`, `#registerProbes`): always `{ "status": "ok" }` with no
dependency check — it answers as long as the HTTP server itself is accepting requests. It cannot
be slow: it does nothing but return a constant.

## Readiness endpoint

`GET /ready`: checks `this.db.ping()` (`SELECT 1`) against the SQLite connection, cached for
`SchedulerApi.READY_CACHE_MS` = 10 seconds (`#readiness()`). On success returns
`{ status: "ok", worker: "running"|"stopped" }`; on failure (the cached probe throws) returns `503
{ status: "unavailable", error }` and logs a warning. The worker-state field is informational only
— it does not affect the status code, so `/ready` can answer `200` even while the worker is
stopped (e.g. before `worker.start()` has been called, as the test suite exercises). The check
itself never mutates state, never touches `jobs`/`runs`, and never discards in-flight work — it is
safe to poll at any frequency; the 10 s cache just means a very tight polling loop will see the
same cached result rather than re-querying SQLite every call.

## Graceful shutdown

`SIGTERM`/`SIGINT` both call `Application#shutdown(reason)` (`src/application.js`), which is
idempotent (`this.shuttingDown` guard) and runs, in order:

1. `this.app?.close()` — Fastify stops accepting new connections and waits for in-flight HTTP
   requests to finish.
2. `this.audit.close()` — stops the flush timer and does one final `flush()` of buffered audit
   events (with its own retry/backoff; see "Retry policy" — this step can itself take up to
   roughly a minute in the worst case if `audit` is unreachable, bounded only by the overall
   force-exit timer below).
3. `this.worker?.stop()` — stops claiming new runs and `await`s every in-flight target call
   (`Promise.allSettled(this.inFlight)`) to finish, so a call to a job's target is never
   interrupted mid-flight by shutdown.
4. `this.db.close()`.

A force-exit timer is armed *before* any of these steps, at `this.config.maxTimeoutMs + 10_000`
ms — default `60_000 + 10_000 = 70_000` ms (70 s) — and calls `process.exit(1)` if the four steps
above have not finished by then; it is cleared on successful completion. `unhandledRejection` runs
the same `shutdown()` path; `uncaughtException` exits immediately with no drain at all.

Compared to PM2: `ecosystem.config.cjs` sets `kill_timeout: 80000` (80 s). The internal force-exit
fires at 70 s, 10 s before PM2 would send `SIGKILL` at 80 s — so under default configuration the
service's own force-exit always wins and PM2's hard kill is never reached in practice. This margin
shrinks or inverts if an operator raises `MAX_TIMEOUT_MS` without also raising `kill_timeout`: at
`MAX_TIMEOUT_MS = 70_000` the force-exit timer (80 s) would equal `kill_timeout` (80 s) exactly, and
above that the two config values would need to be re-checked together — nothing in the code
enforces this relationship automatically.

## Resource limits

- `BODY_LIMIT` (default 65 536 bytes): Fastify's request body cap for the management API (job
  definitions, patches).
- `MAX_BODY_BYTES` (default 16 384 bytes): the largest JSON-encoded `target.body` a job may store,
  enforced in `JobService#target` at create/update time, independent of `BODY_LIMIT`.
- `JobService.MAX_HEADERS` = 10: custom `X-*` headers per job target; each header value capped at
  1024 printable-ASCII characters (`Schemas.target`, re-checked in `JobService#target`).
- `RATE_LIMIT_MAX` (default 600): requests per API key per minute (`@fastify/rate-limit`, keyed on
  `request.apiKey.id`).
- List/page sizes: `/v1/jobs` and `/v1/runs*` `limit` query param is capped at 200
  (`Schemas.limit`); `/v1/schedule/preview` `count` capped at 50.
- `JobService.DUE_BATCH` = 200: due jobs picked up per worker poll pass (`jobs.due(now, 200)`) —
  a backlog larger than 200 overdue jobs at once is drained across multiple poll cycles, not one.
- `WORKER_CONCURRENCY` (default 8, max 64): target calls executing at the same time.
- `AuditClient.MAX_BUFFER` = 5000 events held in memory; past that the oldest is dropped (see
  "Retry policy").
- `max_memory_restart: '300M'` in `ecosystem.config.cjs` — PM2 restarts the process if it exceeds
  300 MB RSS.

## Timeouts

- `DEFAULT_TIMEOUT_MS` (default 30 000 ms): per-call timeout used when a job does not set its own
  `timeoutMs`.
- `MAX_TIMEOUT_MS` (default 60 000 ms): the largest `timeoutMs` a job may request (validated in
  `JobService#timeout`); also backs the shutdown force-exit timer above.
- The configured `timeoutMs` is passed as Node's `http(s).request({ timeout })` option
  (`src/net/http-caller.js`); on firing it destroys the request with a retryable `CallError` coded
  `TIMEOUT`, which the worker turns into a retry or a failure per the job's retry policy.
- **Gap**: DNS resolution (`NetGuard#resolve`, via `dns/promises.lookup`) happens *before* the
  timed HTTP request is constructed and has no timeout of its own — a hostname that resolves
  slowly is not bounded by the job's `timeoutMs` at all; only Node/OS resolver behavior limits it.
- `AuditClient` per-request timeout: `timeoutMs` option, default 5000 ms, via
  `AbortSignal.timeout(...)` on the fetch to `audit`.
- No explicit Fastify/Node HTTP server timeouts (keep-alive, headers timeout) are configured
  anywhere in `src/http/scheduler-api.js`; Node's built-in server defaults apply unmodified.

## Retry policy

- **Job target calls** (`src/worker.js` `#settle`, formula in `JobService.backoffMs`):
  `delayMs = min(retry.backoffSec * 2^(attempt - 1), maxBackoffSec) * 1000`, pure exponential, **no
  jitter**. `attempt` is 1-based (the delay computed after attempt 1 uses `2^0`). Maximum attempts
  is `retry.max + 1` (`JobService.maxAttempts`); `retry.max` defaults to 3 and is capped by
  `MAX_RETRIES` (default 10); `backoffSec` defaults to 30 and is capped by `MAX_BACKOFF_SEC`
  (default 3600). A run is only retried when the failure is marked retryable (timeouts, DNS
  failures, `408`/`425`/`429`/`5xx`, connection errors) — other failures (e.g. missing target key,
  blocked target, non-retryable HTTP status) fail on the first attempt regardless of `retry.max`.
- **Audit events** (`src/net/audit-client.js` `#send`): `delayMs = min(30_000, 500 * 2^attempt)`,
  also pure exponential with **no jitter**, up to `AuditClient.MAX_ATTEMPTS` = 6 attempts per batch
  send. A `4xx` other than `429` is treated as permanent (event dropped, logged, not retried); a
  batch that still fails after 6 attempts is left in the buffer for the *next* scheduled flush
  (every `flushMs`, default 2000 ms) rather than retried immediately again.

## Idempotency

- `POST /v1/jobs` (create): not idempotent by design — a repeat with the same `name` gets
  `409 JOB_EXISTS` rather than silently succeeding again, so retries are conflict-safe (no
  duplicate job) but not literally idempotent.
- `PATCH /v1/jobs/:name`: safe to retry for most fields. One caveat: sending the same `schedule`
  value twice is not fully idempotent — any presence of `patch.schedule` recomputes `next_run_at`
  from the request's own `now` (`JobService#update`), so two identical schedule patches minutes
  apart can each push `next_run_at` forward, not just the first one.
- `DELETE /v1/jobs/:name`: safe to retry — first call `204`s, a repeat `404`s; no duplicate
  side effect either way.
- `POST /v1/jobs/:name/run` (manual trigger): **not safe to retry blindly.** While the triggered
  run is still active a repeat correctly gets `409 RUN_ACTIVE` (no duplicate). But once that run
  finishes, there is no idempotency key on this endpoint — a client that times out waiting for the
  first response and retries after the run has already completed will queue a *second*, genuinely
  duplicate run. This is a real risk, not a theoretical one: nothing in `JobService#trigger` or the
  route guards against it.
- `POST /v1/runs/:id/cancel`: naturally close to idempotent but not silent — cancelling an
  already-cancelled (or otherwise terminal) run returns `409 RUN_NOT_CANCELLABLE` instead of a
  successful no-op; no double side effect either way.
- **Job target calls**: scheduler sends `X-Scheduler-Run` and `X-Scheduler-Attempt` headers a
  receiver *could* use as a dedup key, but scheduler does not require or enforce that — whether a
  retried call is safe depends entirely on whether the receiving service's endpoint is itself
  idempotent. State this plainly: scheduler provides no delivery-exactly-once guarantee, only
  at-least-once delivery with a retryable/non-retryable classification of failures.
- **Run claiming** (`RunStore#claim`): idempotent by construction — the claiming `UPDATE` is
  conditioned on `status IN ('pending', 'retrying')` inside one write transaction, so the same run
  row can never be claimed twice, in-process or (see "Scaling model") across processes on the same
  file.

## Backup

State that must survive a disk loss: the SQLite file at `DB_PATH` (jobs + their schedules, and the
full run history), together with its `-wal` and `-shm` sidecar files while the process is running
(WAL mode). There is no backup mechanism built into this codebase today — no script, no scheduled
job, no use of SQLite's online backup API from `node:sqlite`. What to do today: stop the process
(so WAL content is checkpointed back into the main file on close) and copy `DB_PATH`, or use the
`sqlite3` CLI's `.backup` command (or `VACUUM INTO`) against the live file, which is
WAL-safe without stopping the process. A raw `cp` of the main file *without* its `-wal`/`-shm`
siblings while the process is live can capture a state that is missing recently-committed writes.

## Restore

1. Stop the `scheduler` process (`pm2 stop scheduler`, or take the container down).
2. Replace the file at `DB_PATH` (and remove any stale `-wal`/`-shm` files from the *new* location
   if the restored file was checkpointed cleanly, i.e. taken with the process stopped or via
   `.backup`/`VACUUM INTO`).
3. Start the process; `Database`'s constructor runs `#migrate()` on open, applying any migrations
   newer than the restored file's `PRAGMA user_version` — restoring an older backup onto a newer
   service version is expected to work through this path (assuming no migration since removed a
   column another migration depended on, which is not something this codebase's tooling checks
   for).
4. No ordering constraint with other services' data: `scheduler` does not share database rows or
   foreign keys with `audit` or any job target — its own `jobs`/`runs` tables are self-contained.
   The one soft coupling is semantic, not enforced: restoring `scheduler` to an older point can
   replay firings whose targets have since changed behavior, which is a job-design concern, not a
   data-integrity one.

## Metrics

`GET /metrics` (Prometheus text, `#registerMetrics`):
- `scheduler_jobs{state="enabled"|"disabled"}` — **durable**, computed live from `jobs.counts()`
  (a DB query), reflects current stored state regardless of process age.
- `scheduler_runs{status=...}` — **durable**, from `runs.stats()` (all-time `byStatus` counts from
  the `runs` table), also DB-backed.
- `scheduler_runs_finished_total{status="succeeded"|"failed"|"skipped"}` — **per-process, resets on
  restart.** Backed by `worker.counters`, an in-memory object initialized to zeros in the `Worker`
  constructor; it is not persisted and does not reconcile against the `runs` table.
- `scheduler_attempts_retried_total` — **per-process, resets on restart** (same `worker.counters`
  source as above).
- `scheduler_in_flight` — live snapshot of `worker.inFlight.size`, inherently instantaneous rather
  than durable or cumulative.
- `scheduler_next_due_seconds` — **durable**, derived from `jobs.counts().nextDueAt` (DB query);
  `-1` when nothing is scheduled.
- `scheduler_process_uptime_seconds` — `process.uptime()`, process-scoped by definition.

## Logging

Fastify's default structured request logging applies, with `reqId` on every request log line
(`requestIdHeader: 'x-request-id'`, falling back to `genReqId: () => randomUUID()` when the caller
sends none) and `req.headers.authorization` redacted (`redact: ['req.headers.authorization']`).
Worker and audit-client log lines are hand-built structured objects, not tied to a per-request
`reqId`: run outcomes carry `{ job, run, attempt, status, httpStatus, durationMs, nextAttemptAt }`
(plus `error` on failure/retry); the audit client logs `{ buffered }` on a full-buffer drop and
`{ status, body, events }` / `{ err, events }` on send failures.

Against the vocabulary in [OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md): `scheduler` emits
`reqId` (via Fastify's default logging) but does **not** emit `traceId`, `spanId`, `route`/`op`,
`upstream`, `upstreamMs`, `service`, or `version` — none of these fields appear anywhere in this
codebase. `durationMs` is emitted, but only on worker run-outcome log lines, not as the vocabulary
document's per-HTTP-request field (Fastify's own default `responseTime` covers that role for API
requests, under its own field name).

## Tracing

`scheduler` sits behind the gateway/console/peer-service trust boundary (it is never reached
directly by an untrusted client), so it already unconditionally accepts and logs whatever
`X-Request-Id` a caller sends via `requestIdHeader: 'x-request-id'` in `src/http/scheduler-api.js`
— this predates the current architecture review and is not new. It does **not** parse, validate,
or forward a `traceparent` header; per
[OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md), `traceparent` handling is implemented in
`gateway` only, as of this review's Stage 1. `scheduler`'s own outbound calls — to job targets
(`src/net/http-caller.js`) and to `audit` (`src/net/audit-client.js`) — send neither
`X-Request-Id` nor `traceparent` onward; the outbound headers to a job target are exactly
`X-Scheduler-Job`, `X-Scheduler-Run`, `X-Scheduler-Attempt`, `X-Scheduler-Timestamp`,
`X-Scheduler-Signature`, plus the job's own custom `X-*` headers, `accept`, `user-agent`, and,
where applicable, `authorization`/`content-type`/`content-length` — no request-id or trace-context
propagation of any kind.

## Security model

- **Authentication**: Bearer API keys (`SCHEDULER_API_KEYS`, `id:secret[:role]`), compared in
  constant time (`ApiKeyAuth#identify` hashes both sides with SHA-256 and uses `timingSafeEqual`,
  so timing does not reveal whether or which key matched). Roles: `read`, `write`, `readwrite`;
  route-level `ApiKeyAuth.require(role)` runs in `preValidation`, before body-schema validation, so
  a wrong-role request gets `403` rather than a schema error.
- **Secret rotation**: no built-in support. Rotating `SCHEDULER_API_KEYS`, `SIGNING_SECRET`, or
  `TARGET_KEYS` means editing `.env` and restarting the process; there is no overlap window (e.g.
  accepting both an old and new `SIGNING_SECRET` during a staged rollout) — `Signer` holds exactly
  one secret, so a receiver validating signed calls against a not-yet-rotated secret will reject
  calls made right after a `SIGNING_SECRET` change until that receiver is updated too.
- **Boundary validation**: request bodies validated by JSON Schema (ajv, `removeAdditional: false`,
  `additionalProperties: false` — unknown fields are rejected, not silently dropped); job targets
  independently re-validated in the domain layer (`JobService#target`) for scheme, credentials,
  host allowlist, header shape, body size — the HTTP schema layer alone is not trusted as the only
  gate. Outbound SSRF guard (`NetGuard`) is applied twice: `check()` at save time (no network
  access) and `resolve()` again at call time (DNS lookup, public-address check, address pinned for
  the actual connection to close the DNS-rebinding gap between the two checks).
- **Explicitly out of scope**: no mTLS between services (Bearer token + HMAC signature only); no
  verification of *inbound* signed requests (the `Signer`/`X-Scheduler-Signature` mechanism is
  one-directional — scheduler signs its own outbound calls for receivers to verify; it does not
  itself accept or check a signature on incoming API requests, only the Bearer API key).

## Scaling model

**B — single-node stateful.** `ecosystem.config.cjs` sets `instances: 1` with the comment "one
process per SQLite file"; the worker loop, job/run claiming, and the single `DatabaseSync`
connection all live in one process, with no external queue or coordinator.

Whether two instances on the *same* SQLite file would be safe, precisely: **correctness is
preserved, throughput is not, and crash recovery is not.**
- *Correctness*: both the job-firing check (`JobService#fire`, which re-reads the job row inside a
  transaction and compares `next_run_at` before firing) and the run-claiming update
  (`RunStore#claim`, an `UPDATE ... WHERE status IN ('pending','retrying')` inside one write
  transaction) are guarded by SQLite's own single-writer serialization in WAL mode (`BEGIN
  IMMEDIATE` inside `Database#transaction`) plus a conditional re-check of state — so two processes
  racing to fire the same due job, or claim the same due run, cannot both succeed; one transaction
  commits and the other's re-check sees the already-advanced state and no-ops.
- *Throughput*: a second instance provides no additional capacity — both instances poll for and
  attempt to claim the exact same due jobs/runs, so they compete for SQLite's write lock
  (`busy_timeout = 5000` ms; a transaction that cannot acquire the lock within that window throws,
  which the worker's poll loop catches and logs as `'worker iteration failed'`, retrying next
  `pollMs`) rather than dividing the work.
- *Crash recovery*: `Worker#recover()` — which finds runs stuck at `status = 'running'` from a
  killed process and turns them into a retryable failed attempt — runs exactly once, at that
  process's own `start()`. It is not a periodic sweep and it is not triggered by another process's
  activity. If instance A is killed mid-call and never restarts, instance B (still running against
  the same file) will never observe or reap A's stuck `running` row on its own — see "Known failure
  modes".

## Single-node / multi-node guarantees

Running exactly one instance (the deployed configuration) is fully correct: no double-firing, no
double-claiming, and a killed-and-restarted process self-heals via `recover()` on its next start
(PM2's `autorestart: true` makes this automatic). Running more than one instance against the same
`DB_PATH` today is *not unsafe* in the sense of duplicate job execution — the transactional checks
above hold across processes, not just within one — but it provides none of the benefits normally
expected from running multiple instances: no added throughput, increased write contention under
load, and a crash in one instance is not automatically recovered by the other. There is no
supported configuration for two instances against two different files that still means "one
logical scheduler" — that would simply be two independent schedulers with disjoint job sets.

## Known failure modes

- **Disk full**: not specifically detected or handled anywhere in `Config`, `Database`, or the
  worker. A write that fails because the disk is full throws inside whatever SQLite call triggered
  it; inside `Database#transaction` this is caught, rolled back, and rethrown, surfacing as a
  `500 INTERNAL_ERROR` on an API request or a logged `'worker iteration failed'` on a poll pass.
  There is no proactive disk-space check or early warning.
- **A job target times out mid-request**: handled correctly and boundedly — `HttpCaller`'s
  `timeout` option fires, the request is destroyed, and the run is retried per the job's backoff
  policy (see "Retry policy"). The unbounded case is DNS resolution *before* that timeout window
  starts (see "Timeouts" gap) — a hostname whose resolution hangs is not bounded by `timeoutMs`.
- **The process is killed without a graceful shutdown** (`SIGKILL`, OOM kill past
  `max_memory_restart`, a hard container stop): `shutdown()` only ever runs for `SIGTERM`/`SIGINT`;
  a `SIGKILL` bypasses it entirely. Any run that was `status = 'running'` at the moment of death
  stays `running` — `RunStore#claim` only selects `pending`/`retrying` rows, so a stuck `running`
  row is invisible to future claiming — and because `runs.hasActive` treats `running` as active,
  that job's *next* scheduled firing is recorded as `skipped` (its `next_run_at` pointer still
  advances) on every tick until the stuck run is recovered. Recovery only happens when some
  process calls `Worker#start()` (i.e. `recover()` runs once, at startup) against that same
  database file — in the normal single-instance PM2 deployment this self-heals automatically via
  `autorestart: true`, but there is no periodic sweep independent of a process actually restarting.
- **Two instances running against one file** (see "Scaling model" for the safety argument): the
  concrete, currently-true consequence of doing this anyway is wasted duplicate polling effort,
  intermittent `SQLITE_BUSY`-driven `'worker iteration failed'` log lines under contention, and —
  per the previous point — a crash in one instance is never reaped by the other, since `recover()`
  is a startup-time action tied to a specific process's own `start()` call, not a fact about the
  shared database.
