# Retries

Each job has a policy:

```json
{ "retry": { "max": 3, "backoffSec": 60 } }
```

- `max`: retries after the first attempt (`0` = one attempt only). Cap: `MAX_RETRIES`.
- `backoffSec`: delay before the first retry. Doubles each time, capped at `MAX_BACKOFF_SEC`.

With the policy above and a target that keeps failing:

| Attempt | Starts |
|---|---|
| 1 | at the scheduled time |
| 2 | +60 s |
| 3 | +120 s later |
| 4 | +240 s later, then `failed` |

Between attempts the run is `retrying` and shows `nextAttemptAt`. Backoff is deterministic (no jitter); stagger schedules instead if many jobs hit one target.

## What is retried

Retried: `5xx`, `408`, `425`, `429`, timeouts, connection errors, DNS failures, attempts interrupted by a restart.

Not retried (run fails at once): `3xx` and other `4xx` (the request itself is wrong), a target on a private or blocked address, a `targetKey` no longer configured, a job deleted while its run was queued.

## Reading a run

```bash
scurl $SCHED/v1/runs/8412
```

```json
{
  "run": {
    "id": 8412, "job": "nightly.report", "trigger": "schedule", "status": "retrying",
    "scheduledFor": "2026-09-18T00:00:00.000Z", "attempt": 2, "maxAttempts": 4, "nextAttemptAt": "2026-09-18T00:03:02.310Z",
    "startedAt": "2026-09-18T00:00:00.412Z", "finishedAt": null, "durationMs": 30001,
    "httpStatus": null, "response": null, "error": "target timed out after 30000ms",
    "attempts": [
      { "n": 1, "startedAt": "2026-09-18T00:00:00.412Z", "durationMs": 1207, "httpStatus": 503, "error": "target responded 503: upstream unavailable" },
      { "n": 2, "startedAt": "2026-09-18T00:01:02.001Z", "durationMs": 30001, "httpStatus": null, "error": "target timed out after 30000ms" }
    ],
    "createdAt": "2026-09-18T00:00:00.100Z"
  }
}
```

`error`, `httpStatus` and `response` describe the latest attempt; `attempts` keeps all of them. On success `error` becomes `null` and `response` holds the first KiB of the body.

## Stop retrying

```bash
scurl -X POST $SCHED/v1/runs/8412/cancel
```

Works while the run is `pending` or `retrying` (`200`, status `cancelled`). A `running` attempt cannot be interrupted; it ends at `timeoutMs` at the latest, and a cancel after that is refused with `409 RUN_NOT_CANCELLABLE`.

## Restart in the middle of an attempt

On startup, runs left `running` by the previous process are settled as a failed attempt (`error: "interrupted by restart"`) and retried at once when attempts remain. PM2's `kill_timeout` is above `MAX_TIMEOUT_MS` so a normal restart waits for in-flight calls instead.
