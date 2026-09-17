# scheduler examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `SCHEDULER_API_KEYS`. Base URL below is `http://localhost:3008`.

| Example | Shows |
|---|---|
| [Creating jobs](creating-jobs.md) | Name, cron or one-shot schedule, target, tags, retry, timeout, paused jobs |
| [Schedules](schedules.md) | Cron syntax, timezones, preview, daylight saving, missed and overlapping firings |
| [Targets and target keys](targets-and-keys.md) | URL rules, methods, headers, body, bearer tokens by name, internal hosts |
| [Receiving a call](receiving-calls.md) | What the target sees, verifying the signature, idempotency, what counts as success |
| [Retries](retries.md) | Retry policy, backoff, retryable versus permanent failures, attempts |
| [Manual runs](manual-runs.md) | Run now, one active run per job, cancelling queued runs |
| [Runs and history](runs-and-history.md) | Listing, filters, pagination, stats, retention |
| [Scheduling a flag change](flags-scheduled-change.md) | Enable a feature flag at 09:00 through the flags service |
| [API keys and roles](keys-and-roles.md) | Read, write, readwrite; rate limit; error codes |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, backups |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export SCHED=http://localhost:3008
export KEY=<a readwrite secret from SCHEDULER_API_KEYS>
alias scurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
