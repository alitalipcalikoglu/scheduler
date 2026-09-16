# Scheduling a flag change

Scenario: the `checkout.new` flag must switch on in `prod` on 1 October at 09:00 Istanbul time, without anyone being awake for it. The [flags service](https://github.com/alitalipcalikoglu/flags) has no scheduling of its own; this job supplies it.

## 1. Give the scheduler a flags key

In the flags service, add a write key scoped to `prod`:

```env
FLAGS_API_KEYS=console:…,scheduler:1c7e…:write:prod
```

In the scheduler:

```env
TARGET_KEYS=flags:1c7e…
TARGET_ALLOW_PRIVATE=true
TARGET_ALLOW_HTTP=true
TARGET_ALLOWED_HOSTS=flags.internal
```

## 2. Create a one-shot job

```bash
scurl -X POST $SCHED/v1/jobs -d '{
  "name": "flags.checkout-new.prod.on",
  "description": "Enable checkout.new in prod for the October launch",
  "tags": ["flags", "launch"],
  "schedule": { "at": "2026-10-01T06:00:00Z" },
  "target": { "url": "http://flags.internal:3007/v1/flags/checkout.new/envs/prod", "method": "PATCH", "body": { "enabled": true } },
  "targetKey": "flags",
  "retry": { "max": 5, "backoffSec": 30 }
}'
```

09:00 Istanbul is 06:00 UTC; `at` is always an absolute instant, so write it in UTC (or with an explicit offset: `2026-10-01T09:00:00+03:00`).

## 3. What happens at 06:00 UTC

The worker calls `PATCH /v1/flags/checkout.new/envs/prod` with the bearer token and `{"enabled":true}`. Flags answers `200` with the new state; the run is `succeeded` and its `response` holds the beginning of that JSON, including the new version. Flags' own history records the change with actor `scheduler`.

If flags is down at that moment: `503` or a connection error → retries at 30 s, 60 s, 120 s, 240 s, 480 s. After the last one the run is `failed`, `lastStatus` on the job is `failed`, and the console shows it red. The change is not silently lost; it is a visible failure to act on.

## 4. A recurring variant

Turn a flag on during office hours only:

```bash
scurl -X POST $SCHED/v1/jobs -d '{ "name": "flags.live-chat.on",  "schedule": { "cron": "0 9 * * mon-fri",  "timezone": "Europe/Istanbul" }, "target": { "url": "http://flags.internal:3007/v1/flags/live.chat/envs/prod", "method": "PATCH", "body": { "enabled": true } },  "targetKey": "flags" }'
scurl -X POST $SCHED/v1/jobs -d '{ "name": "flags.live-chat.off", "schedule": { "cron": "0 18 * * mon-fri", "timezone": "Europe/Istanbul" }, "target": { "url": "http://flags.internal:3007/v1/flags/live.chat/envs/prod", "method": "PATCH", "body": { "enabled": false } }, "targetKey": "flags" }'
```

Both calls are idempotent on the flags side (setting `enabled` to its current value is a no-op with a version bump), so a retry or a catch-up firing after downtime is harmless.
