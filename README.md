# scheduler

Cron and one-shot jobs that call HTTP endpoints: timezone-aware schedules, signed requests, bearer tokens by name, retries with exponential backoff, one active run per job, full run history. HTTP only; the worker runs inside the same process.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set SCHEDULER_API_KEYS, SIGNING_SECRET; TARGET_KEYS for the services you call
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-scheduler .
docker run -p 3008:3008 -v scheduler-data:/data --env-file .env atc-scheduler
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A job** has a `name`, a `schedule` (`{ cron, timezone }` or `{ at }`), a `target` (`url`, `method`, custom `X-*` headers, JSON `body`), an optional `targetKey` (bearer token by name from `TARGET_KEYS`), `timeoutMs`, a `retry` policy, tags and an `enabled` bit. The job stores its next firing; pausing clears it, resuming recomputes it from now.
- **A run** is one firing, through all its attempts: `pending` → `running` → `succeeded` / `failed`, or `retrying` between attempts. Overlap is refused: a firing while the previous run is active is recorded as `skipped`. Manual triggers create runs the same way.
- **Every call** carries `X-Scheduler-Job`, `X-Scheduler-Run`, `X-Scheduler-Attempt`, `X-Scheduler-Timestamp` and `X-Scheduler-Signature` (`t=<unix>,v1=HMAC-SHA256(SIGNING_SECRET, "<t>.<body>")`). Only `2xx` is success; redirects are not followed.
- **Retries**: `5xx`, `408`, `425`, `429`, timeouts, connection and DNS errors retry with `backoffSec × 2^(n-1)` (capped); other `4xx`, `3xx` and blocked targets fail at once. Attempts interrupted by a restart are retried.
- **Outbound safety**: `https://` only unless `TARGET_ALLOW_HTTP`; hosts allowlisted with `TARGET_ALLOWED_HOSTS`; private and loopback addresses blocked unless `TARGET_ALLOW_PRIVATE` (which requires the allowlist); the resolved address is pinned for the connection.
- **Missed firings** while the process was down collapse into one catch-up run at start; the run's `scheduledFor` shows the slot.

## Boundaries

**Purpose:** run one HTTP call at a time, on a schedule or once, with retry.

**Responsibilities:** cron and one-off scheduling with timezone awareness; HTTP-target execution with retry/backoff; run history.

**Non-responsibilities:** scheduler ≠ generic queue — one named job triggers one HTTP call; there is no arbitrary task payload, no pub/sub, nothing another service can enqueue work onto beyond calling a pre-registered job's own trigger endpoint. It does not fan a single trigger out to multiple targets.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database, cached 10 s) with worker state; service identity (version, API version, capabilities, schema version, service-core version). |
| POST | `/v1/jobs` | write | `{ name, schedule, target, targetKey?, timeoutMs?, retry?, enabled?, description?, tags? }` → `201 { job }`. |
| GET | `/v1/jobs` | read | Sorted by name; `q`, `tag`, `enabled`, `limit` ≤ 200, `cursor`. |
| GET / PATCH / DELETE | `/v1/jobs/:name` | read / write / write | Read; partial update (any field but `name`); delete with its runs. |
| POST | `/v1/jobs/:name/run` | write | Queue a run now → `202 { run }`; `409 RUN_ACTIVE` while one is active. |
| GET | `/v1/jobs/:name/runs` | read | That job's runs, newest first (`status`, `limit`, `before`). |
| GET | `/v1/runs` | read | All runs (`job`, `status`, `limit`, `before`). |
| GET | `/v1/runs/:id` | read | One run with every attempt. |
| POST | `/v1/runs/:id/cancel` | write | Cancel a `pending` or `retrying` run. |
| GET | `/v1/schedule/preview` | read | `cron`, `timezone?`, `count?` → next firings. |
| GET | `/v1/target-keys`, `/v1/timezones` | read | Configured token names (never values); IANA timezone list. |
| GET | `/v1/stats` | read | Job counts, runs by status (all time and 24 h), top failures, worker state. |
| GET | `/metrics` | read | Prometheus text. |

Error codes: `JOB_NOT_FOUND`, `JOB_EXISTS`, `RUN_NOT_FOUND`, `RUN_ACTIVE`, `RUN_NOT_CANCELLABLE`, `INVALID_SCHEDULE`, `INVALID_TARGET`, `UNKNOWN_TARGET_KEY`, `BODY_TOO_LARGE`, `VALIDATION_FAILED`, `INVALID_JSON`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`.

### A job in one request

```bash
curl -s -X POST http://localhost:3008/v1/jobs \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "name": "nightly.report", "schedule": { "cron": "0 3 * * *", "timezone": "Europe/Istanbul" },
        "target": { "url": "https://api.example/reports/daily", "body": { "full": true } }, "targetKey": "reports" }'
```

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md), including [scheduling a feature-flag change](examples/flags-scheduled-change.md) through the flags service.

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example). Required: `SCHEDULER_API_KEYS`, `SIGNING_SECRET`.

## Security notes

- **At-least-once execution, not exactly-once.** If the target returns `2xx` but this process dies before the run's local `succeeded` state commits, the same run is retried and the target gets the same request again — do not assume the target sees each run only once. `X-Scheduler-Run` is the run row's own id and stays identical across every retry attempt of that run (only `X-Scheduler-Attempt` changes); a target can use it as an idempotency/deduplication key, but nothing in this service verifies a target actually does so. Each separate firing of a job (a new scheduled tick or a manual `POST /v1/jobs/:name/run`) creates a new run with its own new `X-Scheduler-Run` — distinct from a retry of an existing run.
- API keys compared in constant time; per-key rate limit; read/write roles checked before body validation.
- Bearer tokens for targets live only in `TARGET_KEYS`; jobs reference them by name and the API never returns them. Job headers may not set `Authorization`.
- SSRF guard on every call: scheme, host allowlist, credentials in URL, private/special address ranges (IPv4 and IPv6 including mapped and NAT64 forms), pinned address, no redirects, bounded response capture (1 KiB).
- Every call is signed; receivers can verify origin without a shared API key.
- Job definitions are validated when saved (schedule, target, headers, body size) so failures do not wait for the schedule.
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every response; `Authorization` redacted from logs.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment, key roles, target keys |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `JobStore`, `RunStore` | `src/store/` | Jobs with next-run pointers; run queue and history |
| `CronExpression`, `WallClock` | `src/domain/cron.js` | Cron parsing and timezone-aware next-firing search |
| `ScheduleRule` | `src/domain/schedule.js` | Cron or one-shot normalisation |
| `JobService`, `SchedulerError` | `src/domain/` | Validation, lifecycle, firing, overlap, cancel, preview |
| `NetGuard`, `Signer`, `HttpCaller` | `src/net/` | SSRF guard, HMAC signatures, the outbound call |
| `Worker` | `src/worker.js` | Firing loop, concurrency, retries, recovery, retention |
| `SchedulerApi`, `ApiKeyAuth`, `Schemas`, `Views` | `src/http/` | Fastify routes, roles, shapes |

## Out of scope by design

- Job chains and dependencies ("run B after A"): have A's receiver trigger B (`POST /v1/jobs/b/run`).
- Sub-minute schedules: the smallest cron unit is a minute; a receiver that needs a tighter loop should own it.
- Payload templating (dates in the body): receivers know the time from `X-Scheduler-Timestamp` and the run's `scheduledFor`.
- Push notifications on failure: poll `/v1/stats` or scrape `/metrics`; a notify job can be a receiver's responsibility.
- True multi-host distribution: every process (API or worker, however many) must reach the same `DB_PATH` file on one host — there is no network-shared counter store. Splitting a workload across hosts still means splitting jobs across separate `scheduler` instances, each with its own database.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## API/worker runtime split

`src/index.js` (default) runs both the HTTP API and the worker loop in one process — nothing about
existing single-process deployments changes. Two more entry points exist for a split deployment:
`src/api-main.js` (HTTP only, never claims a run) and `src/worker-main.js` (worker only, no HTTP
listener at all, not even for health checks — PM2's own process state is the liveness signal). All
three share the same `Config`, the same database, the same migrations. `npm run api` / `npm run
worker` run them directly; `ecosystem.config.cjs` has the split apps ready to uncomment. An
API-only process's `/ready` and `/v1/stats` report worker liveness and in-flight count from the
database (`worker_heartbeat`, `runs.status = 'running'`) instead of an in-process `Worker` object —
the `sinceStart` counters, being inherently per-process, report `null` there rather than a
misleading zero.

## Lease ownership and scaling model

Every claimed run gets a fencing token (`owner_token`) and a lease (`lease_until`), not just a
status column. A worker renews the lease every `HEARTBEAT_MS` while a call is in flight
(`LEASE_MS`, default 30s; `HEARTBEAT_MS`, default 10s — must be well under `LEASE_MS`), so a call
taking longer than `LEASE_MS` never loses its lease on its own. If a worker crashes or hangs long
enough that its lease genuinely expires, another worker (or the same one, restarted) reclaims the
run as a failed attempt — following the same retry/backoff policy as an ordinary failure, labeled
`"lease expired"` or `"interrupted by restart"` — and the fencing token means the original worker,
if it later finishes the call it no longer owns, cannot overwrite that outcome: its write is
rejected (`owner_token`/`status` no longer match), not silently accepted.

Scaling class **B — single-node stateful**, but since Stage 6 "single-node" means one HOST, not
one PROCESS: **multiple worker processes against the same `DB_PATH` are a supported topology**, not
just a configuration that happens not to corrupt data: `ecosystem.config.cjs`'s split
`scheduler-worker` app can run with `instances` > 1. Claiming is atomic across processes (`BEGIN IMMEDIATE` around the whole
read-decide-write), proven with real cross-connection concurrency in
`test/lease-concurrency.test.js`, not just same-process `Promise.all`. See
[docs/READINESS.md](docs/READINESS.md) for the full contract, including exactly what a Redis-style
distributed lease would still need on top of this (nothing — SQLite's file lock already gives
every guarantee this design needs; the topology limit is one host, not one process).

## Observability

Every request already gets a `reqId` (Fastify's `requestIdHeader: 'x-request-id'`, generated when
the caller sends none), redacted `Authorization` headers in logs, and structured run-outcome log
lines from the worker (`job`, `run`, `attempt`, `status`, `httpStatus`, `durationMs`,
`nextAttemptAt`). `scheduler` also parses an inbound `traceparent`, trusted only when
`TRUST_PROXY=true` — the caller's trace-id is continued with a fresh span-id, both logged as
`traceId`/`spanId` via `@atc-web/service-core`'s `registerRequestContext`. Its own outbound calls
(to job targets and to `audit`) remain external/operator-configured and do not propagate
`X-Request-Id` or `traceparent` onward — see [OBSERVABILITY.md](../stack/docs/OBSERVABILITY.md).
See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## Backup / restore

The only state that needs to survive a disk loss is the SQLite file at `DB_PATH` (jobs and run
history), including its `-wal`/`-shm` sidecars while the process is live. Use `stack backup`/
`stack restore` from the workspace root (see `stack/docs/UPGRADE.md`) to snapshot and restore this
consistently alongside the rest of the stack — it uses `VACUUM INTO` against the live file, so
stopping the process first is not required. Restoring means stopping the process, replacing the
file, and starting again — `Database` runs its migration check on open, so a slightly older backup
catches up automatically. On every start, before applying a pending migration to an existing
database, the service itself also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>` (directory
overridable with `DB_BACKUP_DIR`) — a manual last resort if `stack restore` is unavailable.
`scheduler`'s tables are self-contained; there is no cross-service data-ordering constraint to
restoring it.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it. See [docs/READINESS.md](docs/READINESS.md) for the full
contract.

## License

MIT, see [LICENSE](LICENSE).
