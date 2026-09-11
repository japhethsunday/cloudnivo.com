# Automation: queues, schedules, webhooks

Per-project automation planes. Same envelope, same tenancy
(`User → Organization → Project`), same agent scopes
(`automation.read` / `automation.write`). Dashboard → project →
Automations, or `packages/cli` / `packages/sdk` on the same backend.

## Queues

Durable FIFO-ish message queues with leases, retries, idempotent publish,
and a dead-letter set.

- `POST /queues` `{name, maxDeliveries?}` (1–25, default 5).
- `POST /queues/{id}/messages` `{body, idempotencyKey?}` — replays with the
  same key return the original (`duplicate: true`, 200).
- `POST /queues/{id}/consume` `{limit?, leaseMs?}` — leases up to 25
  messages; expired leases become visible again.
- `POST …/messages/{mid}/ack|nack` — ack completes; nack requeues or, past
  `maxDeliveries`, dead-letters.
- `POST /queues/{id}/purge` `{statuses: [acked|dead]}`.
- `GET /queues` includes live depth; `DELETE` removes the queue and its
  messages.

## Schedules

Five-field UTC cron expressions invoking a deployed project function.

- `POST /schedules` `{name, functionSlug, cron, payload?}` — validates the
  expression and precomputes `nextRunAt`.
- `PATCH` (name/cron/payload/enabled), `DELETE`, `POST …/trigger` (fires
  now as the schedule system and records the outcome).
- The background `worker` fires due schedules; each run records
  `lastRunAt/lastStatus` and advances `nextRunAt` before invoking, so a
  crashing function can never refire the same tick.

## Webhooks (outbound)

Signed `POST` deliveries on `job.completed`, `job.failed`,
`function.deployed`, `function.invoked`, `ai.plan.applied`,
`project.deleted`.

- `POST /webhooks` `{name, url, eventTypes, maxAttempts?}` — returns the
  raw `whsec_…` secret **once**; only its sha256 is stored.
- Verification: `X-CloudNivo-Signature: sha256=HMAC_SHA256(key, body)`
  where `key` is the UTF-8 bytes of `sha256_hex(raw_secret)`, over the
  exact response bytes. `X-CloudNivo-Event` and `X-CloudNivo-Delivery`
  identify the event for idempotent receivers.
- Loopback URLs are rejected at creation (SSRF guard).
- Deliveries attempt inline on trigger; failures retry on
  1m → 5m → 30m → 2h → 8h → 24h (capped by `maxAttempts`, then `failed`).
- `POST …/test` (signed sample), `GET …/deliveries`,
  `POST …/deliveries/{id}/replay`, `POST …/rotate` (new secret, old dies
  immediately), `PATCH` (incl. enable/disable), `DELETE`.

## Metrics

`GET /organizations/{id}/metrics?window=1h|6h|24h|7d[&projectId=]` —
request counts, errors, p50/p95 latency, per-service breakdown, top
routes, and 5-minute throughput buckets. Process-local ring (10k samples,
labeled `sinceBoot` in every response); project slices follow membership
(and agent allow-lists). Dashboard → project → Metrics.

## CSV data portability

- `GET /:table/export?format=csv[&filters]` — same auth/filters as list,
  streamed as an attachment, capped at 10,000 rows (`X-Export-Truncated`
  says when the cap bit).
- `POST /:table/import` `{csv}` — insert-only, ≤1024 rows, unknown columns
  rejected up front, per-row errors collected (`{inserted, failed,
  errors[]}`), owner-scoping enforced per row. Dashboard → Database →
  per-table Export/Import.

## AI Debugger

`POST /ai/diagnose` `{ref?, note?}` — deterministic analysis over recent
failed jobs, function error logs, and failed AI plans: probable cause,
affected service, evidence excerpts, suggested fix, and an honest
confidence level. No LLM involved; unknown signatures say so. Dashboard →
AI Builder → Debugger. CLI: `cloudnivo ai diagnose --project <id>`.

## Durability

Memory stores by default; `CONTROL_STORE=drizzle` uses
`automation_*` tables (migration `0007`). The worker drains delivery
retries and schedule ticks; without it, first attempts still run inline.
