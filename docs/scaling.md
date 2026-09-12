# CloudNivo scaling readiness

Current production runs a single API replica (`numReplicas: 1` in
`railway.json`). Do NOT raise the replica count until every item below is
satisfied. Single-replica is a deliberate choice, not a gap: with one
instance, memory fallbacks are correct; with two, they silently split brain.

## Shared-state inventory

| Concern | Mechanism | Multi-instance ready? |
| --- | --- | --- |
| Platform sessions | JWT + shared denylist (`sess-revoked:*` in cache) | YES when `REDIS_URL` is shared; each instance checks the denylist via `verifyPlatformSession` |
| Rate limiting | Atomic `INCR` on shared cache; fail-open + `ratelimit.degraded` log on outage | YES when `REDIS_URL` is shared; without it each instance counts alone |
| Registry / keys / jobs / billing / storage meta / automation | `CONTROL_STORE=drizzle` (Postgres) | YES when `drizzle` + migrated |
| AI audit / plans / usage | Postgres journal + boot rehydrate | YES when `drizzle` + migrated (migration 0008) |
| Realtime fan-out + presence | `REALTIME_DRIVER=redis` pub/sub | YES when set; `memory` is single-instance only |
| Job lifecycle | Idempotency keys + DB unique constraint; worker reaps stale rows | YES when `drizzle`; only one worker service must run (two workers double-deliver webhooks) |
| Scheduled backups | Worker loop, `BACKUP_*` env | YES with one worker; never enable on two workers (duplicate dumps + retention races) |
| Request metrics ring | Process-local, labeled "since boot" | Ephemeral by design; scrape per-instance, do not sum as truth |
| Customer sessions (project auth) | Stateful sessions in project DB / store | YES — already server-side with revocation |

## Safe scale-out checklist

1. Attach shared Postgres (control plane) + Redis; set `DATABASE_URL`,
   `MANAGED_PG_URL`, `REDIS_URL` (with password) on every service.
2. `CONTROL_STORE=drizzle`, `MIGRATE_ON_BOOT=true` (or release-step
   migrate), `npm run db:seed` once.
3. `REQUIRE_REDIS=true` so a dropped `REDIS_URL` fails boot instead of
   silently splitting rate limits and revocations.
4. `REALTIME_DRIVER=redis`; run realtime standalone if WS load grows.
5. `STORAGE_DRIVER=s3` (local disks are per-instance ephemeral).
6. Keep exactly ONE worker service (`cloudnivo-worker`).
7. Keep `BACKUP_DIR` on a persistent volume; keep provider DB backups on.
8. Raise `numReplicas` in `railway.json` (API is stateless past the above).

## What is NOT shared (by design)

- Function isolates run in-process per instance (`FUNCTION_RUNTIME=worker`);
  invocations are stateless so any instance can serve them.
- AI generations are stateless; only their records are journaled.
- `cn_session` cookie + `Authorization` headers route to any instance —
  no sticky sessions required anywhere.
