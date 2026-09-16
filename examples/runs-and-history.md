# Runs and history

Every firing is a run row, whatever happened to it: `succeeded`, `failed`, `skipped` (previous run still active), `cancelled`, or still `pending` / `running` / `retrying`.

## Per job

```bash
scurl "$SCHED/v1/jobs/nightly.report/runs?limit=20"
```

## Across jobs

```bash
scurl "$SCHED/v1/runs?status=failed&limit=50"
scurl "$SCHED/v1/runs?job=nightly.report&status=skipped"
```

Filters: `status`, `job`. Newest first. Pagination is keyset: the response carries `nextBefore` (a run id) while more rows exist; pass it as `before`:

```bash
scurl "$SCHED/v1/runs?limit=50&before=8360"
```

`limit` ≤ 200.

## The job's own summary

Each job carries `lastRunAt` and `lastStatus` (`succeeded`, `failed`, `skipped`), updated when a run finishes. `GET /v1/jobs?enabled=true` plus these two fields is enough for an overview table; open the runs only when something is red.

## Stats

```bash
scurl $SCHED/v1/stats
```

```json
{
  "jobs": { "total": 12, "enabled": 10, "scheduled": 9, "nextDueAt": "2026-09-18T00:00:00.000Z" },
  "runs": {
    "byStatus": { "pending": 0, "running": 1, "retrying": 1, "succeeded": 4210, "failed": 17, "skipped": 3, "cancelled": 2 },
    "last24h": { "pending": 0, "running": 1, "retrying": 1, "succeeded": 288, "failed": 2, "skipped": 0, "cancelled": 0 },
    "avgDurationMs24h": 412,
    "topFailures24h": [{ "job": "sync.crm", "failed": 2 }]
  },
  "worker": { "running": true, "inFlight": 1, "concurrency": 8, "sinceStart": { "succeeded": 288, "failed": 2, "retried": 5, "skipped": 0 } }
}
```

`scheduled` counts enabled jobs that have a next firing (a fired one-shot job is enabled but not scheduled). `sinceStart` resets on restart; `byStatus` is the database.

## Retention

Finished runs older than `RUN_RETENTION_DAYS` (default 30) are deleted once a minute by the worker. Queued and running runs are never purged. Jobs are kept forever until deleted.
