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

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready` | none | Liveness; readiness (database, cached 10 s) with worker state. |
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
- Multi-node execution: one process per database; scale by splitting jobs across instances.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

Single-node stateful: one process owns the SQLite file at `DB_PATH` (`instances: 1` in
`ecosystem.config.cjs`, "one process per SQLite file"), with the worker loop and the database
connection living in that one process. Two instances against the same file would not double-fire a
job or double-claim a run — the firing and claiming updates are guarded by SQLite's own write-lock
serialization plus a conditional re-check of state — but a second instance adds no throughput
(both poll and contend for the same due rows) and does not improve crash recovery, since a killed
instance's stuck runs are only reaped by a process's own startup, not observed by a sibling
process. See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

Every request already gets a `reqId` (Fastify's `requestIdHeader: 'x-request-id'`, generated when
the caller sends none), redacted `Authorization` headers in logs, and structured run-outcome log
lines from the worker (`job`, `run`, `attempt`, `status`, `httpStatus`, `durationMs`,
`nextAttemptAt`). `scheduler` does not parse or forward a `traceparent` header — that is
implemented in `gateway` only so far — and its own outbound calls (to job targets and to `audit`)
do not propagate `X-Request-Id` or `traceparent` onward. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## Backup / restore

The only state that needs to survive a disk loss is the SQLite file at `DB_PATH` (jobs and run
history), including its `-wal`/`-shm` sidecars while the process is live. There is no backup
mechanism built into this codebase today; capture it with the `sqlite3` CLI's `.backup` (or
`VACUUM INTO`) against the live file, or stop the process and copy the file directly. Restoring
means stopping the process, replacing the file, and starting again — `Database` runs its migration
check on open, so a slightly older backup catches up automatically. `scheduler`'s tables are
self-contained; there is no cross-service data-ordering constraint to restoring it. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
