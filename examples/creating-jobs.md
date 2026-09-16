# Creating jobs

Scenario: a report must be generated every night at 03:00 Istanbul time by calling the reporting API.

## 1. Create

```bash
scurl -X POST $SCHED/v1/jobs -d '{
  "name": "nightly.report",
  "description": "Generate the daily sales report",
  "tags": ["reports"],
  "schedule": { "cron": "0 3 * * *", "timezone": "Europe/Istanbul" },
  "target": { "url": "https://api.example/reports/daily", "method": "POST", "body": { "full": true } },
  "targetKey": "reports",
  "timeoutMs": 45000,
  "retry": { "max": 3, "backoffSec": 60 }
}'
```

`201` with `Location: /v1/jobs/nightly.report`:

```json
{
  "job": {
    "name": "nightly.report", "description": "Generate the daily sales report", "tags": ["reports"], "enabled": true,
    "schedule": { "cron": "0 3 * * *", "timezone": "Europe/Istanbul" },
    "target": { "url": "https://api.example/reports/daily", "method": "POST", "headers": {}, "body": { "full": true } },
    "targetKey": "reports", "timeoutMs": 45000, "retry": { "max": 3, "backoffSec": 60 },
    "nextRunAt": "2026-09-18T00:00:00.000Z", "lastRunAt": null, "lastStatus": null,
    "createdBy": "console", "createdAt": "2026-09-17T10:00:00.000Z", "updatedAt": "2026-09-17T10:00:00.000Z"
  }
}
```

`nextRunAt` is computed at once: 03:00 in Istanbul is 00:00 UTC. `createdBy` is the id of the API key.

## Fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | | `^[a-z0-9]+([.\-_][a-z0-9]+)*$`, up to 80 chars; the job's id in every URL. Cannot be renamed. |
| `schedule` | yes | | `{ cron, timezone? }` or `{ at }`. See [schedules](schedules.md). |
| `target` | yes | | `{ url, method?, headers?, body? }`. See [targets](targets-and-keys.md). |
| `targetKey` | no | `null` | Name from `TARGET_KEYS`; adds `Authorization: Bearer …` to the call. |
| `timeoutMs` | no | `DEFAULT_TIMEOUT_MS` | 1000 … `MAX_TIMEOUT_MS`. |
| `retry` | no | `{ max: 3, backoffSec: 30 }` | See [retries](retries.md). A partial object keeps the other default. |
| `enabled` | no | `true` | `false` creates a paused job (`nextRunAt: null`). |
| `description`, `tags` | no | `''`, `[]` | Tags are lower-cased, trimmed, de-duplicated, sorted. |

## One-shot job

```bash
scurl -X POST $SCHED/v1/jobs -d '{ "name": "launch.banner", "schedule": { "at": "2026-10-01T06:00:00Z" }, "target": { "url": "https://api.example/banners/launch/activate" } }'
```

Fires once at that instant; afterwards `nextRunAt` is `null` and the job stays as a record of what ran. `at` must be in the future when the job is created or the schedule is patched.

## Update

`PATCH /v1/jobs/:name` takes any subset of the fields above except `name`.

```bash
scurl -X PATCH $SCHED/v1/jobs/nightly.report -d '{ "schedule": { "cron": "30 2 * * *", "timezone": "Europe/Istanbul" }, "retry": { "max": 5 } }'
```

- A new `schedule` recomputes `nextRunAt` from now.
- `enabled: false` clears `nextRunAt`; `enabled: true` recomputes it from now. Firings that would have happened while paused are not made up.
- Other fields (target, timeout, retry, tags, description) keep the current `nextRunAt`.

## Delete

```bash
scurl -X DELETE $SCHED/v1/jobs/nightly.report   # 204
```

Deleting a job deletes its run history. Pause instead (`enabled: false`) to keep it.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad name, unknown field, wrong type. `details` lists each problem. |
| 400 | `INVALID_SCHEDULE` | Cron syntax, unknown timezone, `at` in the past or not ISO 8601, a cron that never fires. |
| 400 | `INVALID_TARGET` | Scheme, host allowlist, credentials in the URL, method, headers, body on GET/DELETE, timeout, retry bounds. |
| 400 | `UNKNOWN_TARGET_KEY` | `targetKey` not in `TARGET_KEYS`. |
| 409 | `JOB_EXISTS` | Name taken. |
| 413 | `BODY_TOO_LARGE` | `target.body` above `MAX_BODY_BYTES` when JSON-encoded. |

Validation happens when the job is saved, so a typo never waits until 03:00 to surface. DNS and private-address checks run at call time because addresses change.
