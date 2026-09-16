# API keys and roles

`SCHEDULER_API_KEYS=id:secret[:role],…`

| Role | Can | Give to |
|---|---|---|
| `write` | create, update, delete jobs; trigger and cancel runs | deploy tooling |
| `read` | list jobs and runs, stats, preview, target-key names, timezones, metrics | dashboards |
| `readwrite` | both (default) | the admin console |

```env
SCHEDULER_API_KEYS=console:3f9a…,deploy:71cc…:write,grafana:b02e…:read
```

The key id is recorded as `createdBy` on jobs. Secrets are compared in constant time against every configured secret; a wrong key costs the same as a right one.

## Rate limit

`RATE_LIMIT_MAX` requests per key per minute (default 600); `429 RATE_LIMITED` with `retry in …` in the message.

## Responses

| Status | Code | Meaning |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or unknown secret; `WWW-Authenticate: Bearer`. |
| 403 | `FORBIDDEN` | Role does not allow the operation (checked before body validation). |
| 400 | `VALIDATION_FAILED`, `INVALID_JSON` | Schema or JSON problems. |
| 400 | `INVALID_SCHEDULE`, `INVALID_TARGET`, `UNKNOWN_TARGET_KEY` | Semantic problems in a job. |
| 404 | `JOB_NOT_FOUND`, `RUN_NOT_FOUND`, `NOT_FOUND` | |
| 409 | `JOB_EXISTS`, `RUN_ACTIVE`, `RUN_NOT_CANCELLABLE` | |
| 413 | `BODY_TOO_LARGE` | Target body above `MAX_BODY_BYTES`. |
| 429 | `RATE_LIMITED` | |

Errors are always `{ "error": { "code", "message", "details?" } }`.

## Two kinds of secrets

`SCHEDULER_API_KEYS` protect this API. `TARGET_KEYS` are tokens this service presents to others ([targets](targets-and-keys.md)). `SIGNING_SECRET` lets receivers verify that a call came from here ([receiving a call](receiving-calls.md)). Keep them separate; rotating one never touches the others.
