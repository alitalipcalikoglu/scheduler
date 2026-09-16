# Receiving a call

Scenario: `reports.example` exposes `POST /reports/daily` and must accept only calls from the scheduler, exactly once per run.

## What arrives

```
POST /reports/daily HTTP/1.1
Host: api.example
Content-Type: application/json
Content-Length: 24
User-Agent: atc-scheduler/1.0
Accept: application/json, */*;q=0.5
Authorization: Bearer b02e…              ← only with targetKey
X-Tenant: shop-1                         ← job headers
X-Scheduler-Job: nightly.report
X-Scheduler-Run: 8412
X-Scheduler-Attempt: 1
X-Scheduler-Timestamp: 2026-09-18T00:00:01.204Z
X-Scheduler-Signature: t=1758153601,v1=9f2c…
```

```json
{"full":true,"days":1}
```

`GET` and `DELETE` calls have no body and `Content-Length: 0`; the signature then covers the empty string.

## Verify the signature

`v1 = HMAC-SHA256(SIGNING_SECRET, "<t>.<raw body>")`. Reject stale timestamps.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyScheduler(secret, rawBody, header, toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  const given = Buffer.from(m[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

Use the raw bytes as received, not a re-serialised object. Share `SIGNING_SECRET` with every receiver out of band. A receiver that also needs a bearer token (an existing API) gets it through `targetKey`; the signature is still there for receivers that want to check provenance without a shared API key.

Fastify receiver:

```js
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => { req.rawBody = body; done(null, body ? JSON.parse(body) : undefined); });
app.post('/reports/daily', async (req, reply) => {
  if (!verifyScheduler(process.env.SCHEDULER_SIGNING_SECRET, req.rawBody ?? '', req.headers['x-scheduler-signature'])) return reply.code(401).send();
  …
});
```

## Exactly once

A run is retried after failures and interrupted attempts, so the same `X-Scheduler-Run` can reach you more than once (with an increasing `X-Scheduler-Attempt`). Make the handler idempotent on the run id: store `(job, run)` before doing the work, and answer `200` again if it is already there. A `2xx` after a timeout on the scheduler's side still counts as a failure there, so the retry will come.

## What counts as success

| Answer | Run |
|---|---|
| `2xx` | `succeeded`; up to 1 KiB of the body is stored as `response`. |
| `408`, `425`, `429`, `5xx` | attempt failed, retried per policy |
| other `4xx`, any `3xx` | `failed` at once, no retry |
| timeout, connection error, DNS failure | attempt failed, retried |

Do the work before answering only if it fits in the job's `timeoutMs`. For long work, answer `202` immediately and run it in the background; the scheduler is a trigger, not a supervisor of long tasks.
