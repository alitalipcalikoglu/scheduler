# Targets and target keys

The `target` describes the HTTP call. The scheduler adds signature and run headers ([receiving a call](receiving-calls.md)); everything else is yours.

```json
{
  "url": "https://api.example/reports/daily",
  "method": "POST",
  "headers": { "X-Tenant": "shop-1" },
  "body": { "full": true, "days": 1 }
}
```

| Field | Rules |
|---|---|
| `url` | Absolute `https://` URL (or `http://` when `TARGET_ALLOW_HTTP=true`). No credentials in the URL. Host must be in `TARGET_ALLOWED_HOSTS` when that list is set. |
| `method` | `GET`, `POST` (default), `PUT`, `PATCH`, `DELETE`. |
| `headers` | Up to 10 custom `X-*` headers, printable ASCII values up to 1024 chars. `X-Scheduler-*` is reserved. `Authorization` is not accepted here, use `targetKey`. |
| `body` | Any JSON value, sent as `application/json`. Not allowed with `GET` or `DELETE`. At most `MAX_BODY_BYTES` encoded. |

Redirects are not followed; a `3xx` answer is a failure.

## Bearer tokens by name

Targets that need an API key get it from the process environment, never from the job:

```env
TARGET_KEYS=flags:3f9a…,notify:71cc…,reports:b02e…
```

```json
{ "name": "sync.flags", "targetKey": "flags", "target": { "url": "https://flags.internal/v1/flags/promo/envs/prod", "method": "PATCH", "body": { "enabled": true } } }
```

The call carries `Authorization: Bearer 3f9a…`. The secret is not stored in the database, does not appear in any response, and rotating it is an `.env` change plus restart. `GET /v1/target-keys` lists the names (never the values) so a console can offer a picker.

Setting `targetKey` to a name that is not configured fails at save time (`400 UNKNOWN_TARGET_KEY`). Removing a name from `TARGET_KEYS` while jobs reference it makes those runs fail permanently with `target key "x" is not configured`, no retries.

## Calling your own services

Internal services usually live on private addresses, which the SSRF guard blocks by default. Opt in explicitly and pin the hosts:

```env
TARGET_ALLOW_PRIVATE=true
TARGET_ALLOW_HTTP=true
TARGET_ALLOWED_HOSTS=flags.internal,notify.internal,10.0.0.7
```

`TARGET_ALLOW_PRIVATE=true` without an allowlist is refused at startup. With the allowlist set, a job can only ever reach those hosts (exact host or any subdomain of a listed domain), so a stolen write key cannot turn the scheduler into a proxy to the rest of the network.

## What the guard checks

At save time: scheme, credentials, allowlist. At call time, again plus DNS: the host must resolve, and every address must be public unless `TARGET_ALLOW_PRIVATE`. The vetted address is pinned for the connection, so a DNS answer that changes between check and connect cannot redirect the call. DNS failures are retried; a private or blocked address is a permanent failure.
