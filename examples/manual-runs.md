# Manual runs

Scenario: the nightly report failed and the fix is deployed; run it now instead of waiting for 03:00.

```bash
scurl -X POST $SCHED/v1/jobs/nightly.report/run
```

`202`:

```json
{ "run": { "id": 8413, "job": "nightly.report", "trigger": "manual", "status": "pending", "scheduledFor": "2026-09-18T09:12:44.000Z", "attempt": 0, "maxAttempts": 4, "nextAttemptAt": "2026-09-18T09:12:44.000Z", … } }
```

The run is queued and picked up within `POLL_MS`. It uses the job's target, timeout and retry policy exactly like a scheduled firing; only `trigger` differs. The schedule is untouched: the next regular firing still happens.

Manual runs work on paused jobs too (`enabled: false`), which makes a paused job a handy "run on demand only" definition.

## One active run per job

While a job has a `pending`, `running` or `retrying` run, another trigger is refused:

```json
{ "error": { "code": "RUN_ACTIVE", "message": "job \"nightly.report\" already has a queued or running run" } }
```

`409`. Wait for it, or cancel it if it is still queued or retrying:

```bash
scurl -X POST $SCHED/v1/runs/8413/cancel
```

## Watching it finish

```bash
scurl $SCHED/v1/runs/8413
```

Poll until `status` is `succeeded` or `failed`; `finishedAt`, `durationMs`, `httpStatus` and `response` are then filled. A console can show the run page and refresh it on demand; there is no push channel.

## Needs the write role

Triggering and cancelling change state, so they need a `write` or `readwrite` key. A read key gets `403 FORBIDDEN`.
