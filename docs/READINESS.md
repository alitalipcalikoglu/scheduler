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
  duration_ms, http_status, response, error, attempts (JSON array), created_at, and, since Stage 6,
  `owner_token` (the fencing token of whoever currently holds the lease; null when not `running`)
  and `lease_until` (ms since epoch; null when not `running`, or a pre-Stage-6 leftover row).
  Indexes: `runs_job` (history lookups), `runs_due` (partial, the claim query), `runs_active`
  (partial, the overlap check), `runs_status`, `runs_created` (retention purge), `runs_lease`
  (partial, the reclaim sweep).
- `worker_heartbeat` — one row per live worker process (`instance` primary key, `seen_at`); written
  on a timer by any process running a `Worker` loop, read by an API-only process's `/ready` and
  `/v1/stats` in place of the in-process `Worker` object it doesn't have.

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

Since Stage 6, `worker` comes from either of two sources depending on process role: the combined
and worker-only roles have an in-process `Worker`, so `worker` is exactly `this.worker.running`; the
API-only role (`src/api-main.js`) has none, so `SchedulerApi#workerStatus()` instead reads the
`worker_heartbeat` table's most recent row and reports `"running"` when it is fresher than
`HEARTBEAT_MS * 4` (`SchedulerApi.PRESENCE_STALE_FACTOR`), `"stopped"` otherwise (including "no
worker has ever reported in this database").

## Graceful shutdown

`SIGTERM`/`SIGINT` both call `Application#shutdown(reason)` (`src/application.js`), which is
idempotent (`Lifecycle.install`'s own `shuttingDown` guard) and runs, in order (Stage 6 fixed this
order — see below for what it was and why):

1. `this.worker?.stopClaiming()` — flips a flag `#pass()` checks before firing due jobs or claiming
   new runs; whatever is already in flight keeps running. Present only when this process runs a
   worker at all (skipped in the API-only role, which has no `Worker`).
2. `this.app?.close()` — Fastify stops accepting new connections and waits for in-flight HTTP
   requests to finish. Present only in the API and combined roles.
3. `this.worker?.stop()` — (redundant `running = false`, in case `stopClaiming` alone wasn't
   called) `await`s every in-flight run (`Promise.allSettled(this.inFlight)`) to finish, so a call
   to a job's target is never interrupted mid-flight by shutdown, and its heartbeat interval is
   cleared as each settles. Stage 6.1: this wait is itself now bounded by `options.drainMs`
   (`config.maxTimeoutMs + 5_000`) — see below.
4. `this.audit.close()` — stops the flush timer and does one final `flush()` of buffered audit
   events (with its own retry/backoff; see "Retry policy" — this step can itself take up to
   roughly a minute in the worst case if `audit` is unreachable, bounded only by the overall
   force-exit timer below).
5. `this.db.close()`.

**Before Stage 6** step 4 (audit flush) ran *before* step 3 (worker drain) — a run that finished
during the drain and needed to record an audit event could queue it into a buffer that had already
been flushed and stopped, leaving it unflushed until process exit. The fix is purely a reordering;
nothing about how audit buffering itself works changed. `test/runtime.test.js`'s shutdown-order
test asserts the exact sequence above by wrapping each step and recording call order.

A force-exit timer is armed *before* any of these steps, at `this.config.maxTimeoutMs + 10_000`
ms — default `60_000 + 10_000 = 70_000` ms (70 s) — and calls `process.exit(1)` if the steps above
have not finished by then; it is cleared on successful completion. `unhandledRejection` runs the
same `shutdown()` path; `uncaughtException` exits immediately with no drain at all.

**Stage 6.1**: `worker.stop()`'s own wait for in-flight runs is now bounded by its own `drainMs`
(`config.maxTimeoutMs + 5_000` — default `65_000` ms), strictly less than the `70_000` ms force-exit
timer above. It races `Promise.allSettled(inFlight)` against a `sleep(drainMs)` cancelled via
`AbortController`, and on timeout logs `'drain timed out; continuing shutdown with runs still in
flight'` then falls through to the remaining steps (audit flush, DB close) rather than hanging —
those get a chance to run even when the drain itself didn't finish, before the outer force-exit
timer is the final backstop that kills the process regardless.

Compared to PM2: `ecosystem.config.cjs` sets `kill_timeout: 630000` (630 s). Stage 6 also bounded
`MAX_TIMEOUT_MS` itself (`config.js`, `max: 600_000`) — previously unbounded, which meant an
operator could configure a job timeout longer than PM2 would ever wait during shutdown, silently
defeating the graceful-drain design; now the worst case the force-exit timer can reach is
`600_000 + 10_000 = 610_000` ms, comfortably under `kill_timeout`'s fixed 630 s ceiling regardless
of how `MAX_TIMEOUT_MS` is configured within its validated range.

The five numbers that matter for shutdown, and how they relate: worker drain timeout (`drainMs =
maxTimeoutMs + 5_000`) fires first and lets audit-flush/db-close still run; the outer force-exit
timer (`maxTimeoutMs + 10_000`) is the hard backstop; `MAX_TIMEOUT_MS` is the external call's own
timeout (one run's ceiling); `HEARTBEAT_MS` is how often an in-flight run renews its lease;
`LEASE_MS` is the lease TTL a stalled/crashed worker's claim expires after. PM2's `kill_timeout`
(630 s) sits above all of them so PM2 never SIGKILLs before the app's own force-exit timer runs.

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
- `MAX_TIMEOUT_MS` (default 60 000 ms, range 1 000–600 000, bounded since Stage 6): the largest
  `timeoutMs` a job may request (validated in `JobService#timeout`); also backs the shutdown
  force-exit timer above. The upper bound exists so `ecosystem.config.cjs`'s static `kill_timeout`
  can be derived once and stay valid for every value config validation allows — see "Graceful
  shutdown".
- `LEASE_MS` (default 30 000 ms, range 2 000–300 000) / `HEARTBEAT_MS` (default 10 000 ms, `min`
  250, must be `<LEASE_MS`): the lease a claimed run holds, and how often an in-flight call renews
  it. Deliberately independent of `MAX_TIMEOUT_MS` — a call can run far longer than `LEASE_MS`
  without losing its lease, as long as its heartbeat keeps succeeding; see "Lease ownership".
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
  file. Since Stage 6 each claim also gets a fencing token (see "Lease ownership") — the run's
  *completion* write, not just its claim, is now idempotent under a lost-and-reclaimed lease too: a
  worker whose lease expired and was reclaimed can no longer overwrite the reclaimed outcome when
  its own late `finish()` call eventually arrives.

## Lease ownership

Stage 6. Every claimed run gets, in addition to `status = 'running'`:
- **`owner_token`** — a fresh random value (`randomUUID()`) generated once per `claim()` call, the
  fencing token. There is no separate generation counter: a fresh random token per claim can never
  collide with a previous one, so the token alone is the whole fencing mechanism.
- **`lease_until`** — set to `now + LEASE_MS` at claim time, renewed to `now + LEASE_MS` again every
  `HEARTBEAT_MS` while the call is in flight (`Worker#execute`'s `setInterval`, cleared in a
  `finally` once the call settles).

Every write that ends a claimed attempt — `RunStore#finish` and `RunStore#heartbeat` — is guarded
by `WHERE id = ? AND owner_token = ? AND status = 'running'`. Two consequences:
- **Heartbeat loss is detected proactively.** If a heartbeat's own guarded `UPDATE` matches zero
  rows, the worker logs a warning immediately — it knows it has lost the lease before the call even
  finishes. This is a fast, non-authoritative signal, not the only safety net.
- **A late-returning owner can never overwrite a reclaimed run.** When the call eventually finishes
  (success or failure), `RunStore#finish`'s own guarded `UPDATE` is the authoritative check: if
  another process's reclaim already changed `owner_token` or `status`, this write matches zero rows
  and is discarded (logged, not thrown) — `test/lease.test.js` and `test/lease-concurrency.test.js`
  cover this with both same-process and real cross-connection scenarios.

**Reclaiming an expired lease** (`RunStore#reclaimExpired`, called both by `Worker#recover()` at
startup, labeled `"interrupted by restart"`, and by the in-loop `#reclaimStale()` on every poll
pass, labeled `"lease expired"`) reads every `status = 'running'` row whose `lease_until` has
passed — strictly `lease_until < now`, so `now == lease_until` is NOT yet expired, the same
invariant used by claim/heartbeat/finish everywhere in this codebase (Stage 6.1 regression test:
`test/lease.test.js` "RunStore: reclaimExpired exact-boundary invariant") — (or is `NULL`, for a
pre-Stage-6 leftover row) and settles each one as a failed attempt —
following the normal retry/backoff decision, so it costs an attempt like any other failure. The
read and every write happen inside ONE transaction (`BEGIN IMMEDIATE`), which is what makes this
race-free against a concurrent heartbeat for the same row: the heartbeat's renewal either commits
entirely before the reclaim transaction starts (the row is no longer expired, so it's simply not
selected) or is attempted entirely after (its own guarded `UPDATE` then matches zero rows, because
the reclaim transaction already moved the row off `'running'`). There is no window in which both
could believe they own the same row.

**What changed from before Stage 6**: `recover()` used to settle *every* `status = 'running'` row
unconditionally, regardless of whether its lease (there was no lease column) had expired — correct
only because it ran once, at this same process's own startup, so every such row was necessarily
orphaned by this process's own prior life. Extending that logic to the in-loop sweep, or to a
second worker process, would have been wrong: it would steal a run a still-live sibling process
genuinely owns. The lease/fencing model is what makes the *same* reclaim logic safe to run
periodically and from more than one process — see "Scaling model".

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
- `scheduler_in_flight` — live snapshot of `worker.inFlight.size` when this process has a `Worker`;
  in the API-only role (no in-process `Worker`), falls back to `runs.runningCount()` (a durable DB
  query), which also correctly reflects runs claimed by a *different* process. Either way,
  inherently instantaneous rather than cumulative.
- `scheduler_worker_up` — Stage 6, `1`/`0`: whether a worker process is currently alive at all (this
  process's own `Worker`, or another one's `worker_heartbeat` row), for the API-only role.
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
`gateway` and `console` (Stage 10). `scheduler`'s own outbound calls — to job targets
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

## API/worker runtime split

Stage 6 adds two more entry points alongside the default combined one — `src/api-main.js` (HTTP
only, no `Worker`, never claims a run) and `src/worker-main.js` (`Worker` only, no HTTP listener at
all, not even for health checks). `Application`'s `role` constructor option (`'combined'` default,
`'api'`, `'worker'`) picks which parts get built; `Config`, the database, and the migrations are
identical across all three — nothing about the persistence or environment contract differs by
role. `ecosystem.config.cjs` ships the split apps commented out, ready to enable in place of the
combined one.

## Scaling model

**B — single-node stateful, but "single-node" now means one HOST, not one PROCESS.**
`ecosystem.config.cjs`'s default (combined) app still pins `instances: 1`, but the commented-out
split `scheduler-worker` app documents raising its own `instances` above 1 as a supported topology
— multiple worker processes (and, separately, multiple API processes) against the same `DB_PATH`
file, all on one host. This is a genuine change from before Stage 6, not just a relaxed warning:
**correctness, throughput, and crash recovery are now all preserved across processes.**
- *Correctness*: unchanged in spirit — the job-firing check (`JobService#fire`) and the run-claiming
  update (`RunStore#claim`) are still guarded by SQLite's own single-writer serialization in WAL
  mode (`BEGIN IMMEDIATE`) plus a conditional re-check of state, proven with real cross-connection
  concurrency (not same-process `Promise.all`) in `test/lease-concurrency.test.js`.
- *Throughput*: **now genuinely improved** by adding worker processes, up to SQLite's own
  single-writer ceiling — multiple workers claim disjoint batches (the claiming transaction is
  atomic per batch) and execute their HTTP calls fully in parallel across processes; only the brief
  claim/finish/heartbeat writes themselves serialize on the file lock, not the calls' own duration.
- *Crash recovery*: **now genuinely shared.** The in-loop `#reclaimStale()` sweep (not just
  `recover()` at startup) means any worker process — not only the one that originally claimed a
  run — can and will reclaim it once its lease expires. Instance A crashing mid-call no longer
  requires instance A itself to restart before its stuck run is noticed; any live instance B's next
  poll pass reclaims it. See "Lease ownership".

## Single-node / multi-node guarantees

Running exactly one process (API+worker combined, the default) is fully correct: no double-firing,
no double-claiming, and a killed-and-restarted process self-heals via `recover()` on its next start
(PM2's `autorestart: true` makes this automatic). Running several worker processes against the same
`DB_PATH` (Stage 6's split-deployment topology) is now a supported configuration, not merely a
tolerated one: it adds real throughput and real shared crash recovery, at the cost of write-lock
contention under very high claim rates (bounded by `busy_timeout = 5000` ms) — still one host,
still one SQLite file; there is no network-shared counter store, so splitting across *hosts* still
means splitting jobs across separate `scheduler` instances with disjoint job sets and separate
databases, exactly as before.

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
  stays `running` and its lease keeps counting down — `RunStore#claim` only selects
  `pending`/`retrying` rows, so a stuck `running` row is invisible to future claiming — and because
  `runs.hasActive` treats `running` as active, that job's *next* scheduled firing is recorded as
  `skipped` (its `next_run_at` pointer still advances) until the stuck run is reclaimed. **Since
  Stage 6, reclaiming no longer requires that same process to restart**: once `lease_until` passes
  (at most `LEASE_MS` after the kill, since nothing was heartbeating it anymore), the in-loop
  `#reclaimStale()` sweep in *any* live worker process against the same file — this one restarting,
  or a sibling process in a multi-worker deployment — reclaims it on its next poll pass. A
  single-instance PM2 deployment still self-heals via `autorestart: true` either way.
- **Heartbeat failure while a call is genuinely still in flight** (event loop stall, a slow/busy DB
  write for the heartbeat `UPDATE` itself): the heartbeat's own guarded write detects the lost lease
  and logs a warning immediately, but cannot cancel the outbound HTTP call already in progress. If
  the lease then expires and another process reclaims the run, the original call's eventual
  `finish()` is rejected by the same `owner_token`/`status` guard (logged, not thrown) — its result
  (success or failure) is discarded, and the reclaim's own "lease expired" failed-attempt outcome
  (with its own retry/backoff) is what stands. This means a genuinely successful call whose
  heartbeat failed can be silently wasted from the target's point of view and retried — see
  "Idempotency"'s `X-Scheduler-Run` discussion for what a target can do about that.
- **Multiple worker processes running against one file** (Stage 6, see "Scaling model"): now a
  supported topology, not a failure mode — listed here only to be explicit that it is no longer one.
  The remaining, expected cost under high contention is intermittent `SQLITE_BUSY`-driven
  `'worker iteration failed'` log lines (`busy_timeout = 5000` ms), the same class of contention a
  single busy instance would also eventually hit.
