# Operations

## Probes

```bash
curl -s $SCHED/health   # {"status":"ok"}
curl -s $SCHED/ready    # {"status":"ok","worker":"running"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
scurl $SCHED/metrics
```

```
scheduler_jobs{state="enabled"} 10
scheduler_jobs{state="disabled"} 2
scheduler_runs{status="succeeded"} 4210
scheduler_runs{status="failed"} 17
scheduler_runs_finished_total{status="succeeded"} 288
scheduler_runs_finished_total{status="failed"} 2
scheduler_runs_finished_total{status="skipped"} 0
scheduler_attempts_retried_total 5
scheduler_in_flight 1
scheduler_next_due_seconds 3120
scheduler_process_uptime_seconds 86400
```

Alert on `scheduler_next_due_seconds` staying negative (the worker is not firing) and on `scheduler_runs_finished_total{status="failed"}` increasing.

## Environment

Required: `SCHEDULER_API_KEYS`, `SIGNING_SECRET`. Full list with defaults: [.env.example](../.env.example).

One process per database file. The worker lives inside the API process; there is no separate worker binary. Two instances on one database would both fire jobs (claims are transactional, so a run executes once, but the pointer advance is per process and the fired run may be marked `skipped` by the other); run exactly one.

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload scheduler
```

`kill_timeout` is 80 s: SIGTERM stops accepting connections, stops claiming, waits for in-flight calls (at most `MAX_TIMEOUT_MS`), closes the database. Raise `kill_timeout` if you raise `MAX_TIMEOUT_MS`.

## Docker

```bash
docker build -t atc-scheduler .
docker run -d -p 3008:3008 -v scheduler-data:/data --env-file .env atc-scheduler
```

## Logs

JSON lines. `Authorization` is redacted. Every run outcome is one line (`run succeeded`, `attempt failed, retry scheduled`, `run failed`) with job, run id, attempt, HTTP status and duration.

## Backups

```bash
sqlite3 data/scheduler.db ".backup 'scheduler-$(date +%F).db'"
```

Jobs and run history are the whole state. Secrets are not in the database.

## Clock

Schedules are computed from the system clock in the configured timezone. Run the host on NTP; a clock jump forward fires due jobs at once, a jump backward delays them.
