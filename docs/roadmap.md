# CloudNivo roadmap

## Phase 1 — Architecture & foundation (this branch, DONE)

Monorepo, Docker (Postgres 16 + Redis 7), control-plane schema, tenant/RBAC
helpers, service abstractions (db/storage/realtime/cache/provisioning),
versioned API envelope, dashboard shell, docs, green
`lint → typecheck → test → build`.

## Phase 2 — Database provisioning engine (DONE)

- `DatabaseProvisioner` interface + real `DockerDatabaseProvider` (execFile,
  labeled containers, localhost-only ports) + test-only fake.
- Job system (idempotency, retry budgets, logs) + orchestrator + audit sink.
- Control metadata tables (`project_databases`, `database_credentials`,
  `infrastructure_instances`, `provisioning_jobs`) + lifecycle machine.
- Live health/SQL/schema/metrics against project databases; masked + audited
  credential reveal; guarded SQL editor foundation.
- Project database console in the dashboard; 67 green tests (1 Docker test
  gated on `DOCKER_TESTS=1`); green `lint → typecheck → test → build`.

## Phase 3 — Control-plane persistence & auth (next)

- Drizzle migrations + seed (roles/permissions).
- Signup/login/session cookies + `GET /me`, org CRUD + invites.
- Project/env CRUD with real tenant checks against Postgres.
- API-key issue/verify/revoke (hash lookup + scopes).
- Audit-log writes on all mutations.
- Dashboard wires to live data (loading/empty/error states stay).
- Playwright smoke: signup → org → project → key → 403 cross-org.

## Phase 3 — Data-plane primitives

- Redis-backed `CacheService`/`RealtimeService` in prod; WS gateway with
  channel auth (`canSubscribe`).
- S3-compatible `StorageService` + signed URLs, per-project buckets.
- Automatic per-project REST (`/api/v1/data/:table` with RLS).

## Phase 4 — Provisioning & serverless

- `ProvisioningService` cloud driver (Terraform/API) per project env.
- Serverless functions + logs + usage metering + CLI/SDKs.
- AI backend generation on top of the stable envelope.

## Non-goals for Phase 1

No real persistence in routes, no OAuth/RLS/rotation, no WS server, no cloud
provisioning, no billing. Interfaces reserve all of it.
