# Schedules

## Cron

Five fields: `minute hour day-of-month month day-of-week`.

| Field | Values | Names |
|---|---|---|
| minute | 0–59 | |
| hour | 0–23 | |
| day-of-month | 1–31 | |
| month | 1–12 | `jan` … `dec` |
| day-of-week | 0–7 (0 and 7 = Sunday) | `sun` … `sat` |

Each field takes `*`, a value, a range `a-b`, a list `a,b,c`, and steps `*/n` or `a-b/n` (`5/20` means 5, 25, 45). Aliases: `@hourly`, `@daily` (`@midnight`), `@weekly`, `@monthly`, `@yearly` (`@annually`). Case does not matter.

When both day-of-month and day-of-week are restricted, either one matching fires the job (`0 12 13 * fri` = the 13th and every Friday), as in Vixie cron.

| Expression | Meaning |
|---|---|
| `*/5 * * * *` | every 5 minutes |
| `0 9 * * mon-fri` | 09:00 on weekdays |
| `0 0 1 * *` | midnight on the first of every month |
| `30 4 * * sun` | 04:30 every Sunday |
| `0 */6 * * *` | 00:00, 06:00, 12:00, 18:00 |
| `0 0 29 2 *` | every leap day (accepted; fires in 2028) |

Rejected: wrong field count, out-of-range values, `*/0`, ranges out of order, days that never occur in the listed months (`0 0 31 feb *`).

## Timezones

`timezone` is an IANA name (`Europe/Istanbul`, `America/New_York`, `UTC`). Missing → `DEFAULT_TIMEZONE`. `GET /v1/timezones` lists what the runtime knows.

Wall-clock semantics: `0 9 * * *` in `Europe/Berlin` fires at 09:00 Berlin time all year, 07:00 UTC in summer and 08:00 UTC in winter. `nextRunAt` in responses is always UTC.

Daylight saving edges:

- A wall time that does not exist (02:30 on the spring-forward night) is skipped that day.
- A wall time that occurs twice (fall-back night) fires once, at the first occurrence.

## Preview

Check an expression before saving a job:

```bash
scurl "$SCHED/v1/schedule/preview?cron=0%209%20*%20*%20mon-fri&timezone=Europe/Istanbul&count=3"
```

```json
{ "cron": "0 9 * * mon-fri", "timezone": "Europe/Istanbul", "next": ["2026-09-18T06:00:00.000Z", "2026-09-21T06:00:00.000Z", "2026-09-22T06:00:00.000Z"] }
```

`count` 1–50, default 5. Invalid input answers `400 INVALID_SCHEDULE` with the reason.

## One-shot

`{ "at": "2026-10-01T06:00:00Z" }`: fires once. Any ISO 8601 date-time with an offset is accepted and stored as UTC. After firing, `nextRunAt` is `null`; patch `schedule.at` to arm it again.

## When the process was down

Each job stores only its next firing. If the service was stopped from 02:00 to 05:00, a job due at 03:00 and 04:00 fires **once** right after start (its pointer still says 03:00), then continues from the next regular slot. Runs record `scheduledFor` (the slot) separately from `startedAt`, so the delay is visible. If catching up is wrong for a job, pause it before planned downtime.

## When the previous run is still going

A firing whose job still has an active run (`pending`, `running` or `retrying`) is recorded as a `skipped` run with `error: "previous run still active"`, and the pointer moves on. Nothing queues up behind a slow or retrying job. `lastStatus` on the job shows `skipped`; look at the active run to see why.

Keep in mind that a job retrying for an hour with a 5-minute schedule produces twelve skipped rows; that is intended, it is the record of what did not happen.
