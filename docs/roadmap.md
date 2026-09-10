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

## Phase 3 — API engine (DONE)

- `@cloudnivo/api-engine`: introspection service (cached), pure query builder
  (allow-list identifiers, `$n` values only), executor-based CRUD engine,
  project keys (hash-only, roles, expiry, revocation, usage), live OpenAPI 3.0.
- Data routes `/:projectId/:table[/:rowId]` + keys + `openapi.json` with
  session-or-key auth, per-key/per-project rate limits, audit + metrics.
- Dashboard API console (base URL, keys, endpoints, curl examples, OpenAPI).
- Railway/Docker deploy (`Dockerfile.api`, `railway.json`, compose `api`
  profile, `docs/deploy-railway.md`); gated real-Postgres integration tests.

## Phase 4 — Authentication & authorization (DONE)

- `@cloudnivo/auth` customer plane: users/sessions/opaque tokens, scrypt,
  rotation + reuse detection, verify/reset flows, metadata guards, email
  abstraction, RLS policy generator, PG + memory stores.
- `/auth/*` routes per project, strict rate limits, project CORS, full audit
  events; engine integration (customer JWTs + owner scoping).
- Dashboard Auth section (users, sessions, CORS, email status).
- 100+ green tests (unit + HTTP E2E + isolation matrix); gated real-PG test.

## Phase 5 — Storage system (DONE)

- `StorageProvider` boundary: streaming local FS driver (real bytes) +
  SigV4 S3-compatible driver (verified signing, stubbed-transport tests).
- Buckets (validated, scoped, visibility/limits/allowlist/isolation settings),
  objects (sniffed MIME, sha256 etags, move/copy/upsert), signed URLs
  (HMAC capabilities + S3 presigned), quotas, policies, audit events.
- Storage API under `/api/v1/projects/:id/storage/*` + OpenAPI paths;
  Storage console in the dashboard (buckets, browser, upload, previews,
  usage, settings). 30+ new tests, all green.

## Phase 6 — Realtime infrastructure (DONE)

- `@cloudnivo/realtime`: RFC 6455 codec (no deps), project-bound channels
  (`project:<uuid>:<topic>`, `table:<name>`), pure server-side authz
  (`canSubscribe/Broadcast/Receive/TrackPresence/WatchTable` + safe equality
  filters), memory + Redis event bus (degrade-to-local, no echo), memory +
  Redis presence (TTL, no permanent rows), transport-agnostic gateway
  (limits, metrics, heartbeat + credential-expiry sweep), raw-socket server,
  `RealtimeService` facade, framework-independent client with reconnect.
- PostgreSQL CDC over LISTEN/NOTIFY (idempotent per-table triggers, multiplexed
  listener, bounded reconnects, no polling) + lazy trigger installs on first
  table subscribe; per-subscriber owner-scoped delivery at fan-out.
- WS upgrades in-process on the API port + standalone on `REALTIME_PORT`
  (same factory/auth); HTTP management (`/realtime`, `/stats`, `/channels`,
  `/presence`) + OpenAPI paths; dashboard Realtime console (overview,
  connections, channels, events, usage, settings, live smoke test).
- 30+ new tests (codec, authz matrix, filters, fan-out INSERT/UPDATE/DELETE,
  presence, heartbeats, expiry, rate/size limits, raw-socket E2E incl.
  expired-token + oversized-payload + upgrade-flood cases); green
  `lint → typecheck → test → build`.

## Phase 7 — Serverless functions (DONE)

- `@cloudnivo/functions`: records/versions/jobs/env model, frozen in-function
  SDK, worker-isolate + container runtimes (timeouts, memory/concurrency/size
  caps), async deploy pipeline with verified builds, invocation with caller
  identity, secret-masked env, redacted logs, honest metrics + cold starts.
- Function API (`/functions/*`: CRUD, deploy/redeploy jobs, invoke, logs,
  versions + rollback, env, metrics) with session/key/customer auth and
  project isolation; OpenAPI paths; dashboard Functions console (overview,
  editor, deployments, invoke tester, logs, env, versions, settings).
- 30+ new tests (validation, sandbox denials, timeouts, lifecycle, versions,
  isolation, rate limits, raw-HTTP E2E incl. rollback + delete); green
  `lint → typecheck → test → build`.

## Phase 8 — Durable control plane (DONE)

- Async `Registry` contract with `MemoryRegistry` (dev/test) + `DrizzleRegistry`
  (orgs, projects, memberships, databases, credentials, audit, CORS configs).
- Drizzle-backed keys/jobs/storage-metadata/platform-user/invite stores
  (`api_keys`, `provisioning_jobs`, `storage_*`, `users`, `organization_invites`
  - `0003`/`0004` migrations, idempotent RBAC seed, `CONTROL_STORE` selector
    with fail-fast boot). Customer auth already durable per project DB.
- Platform signup/login (`cn_session` cookie) + `GET /me`, org invites
  (opaque tokens, owner-gated, accept flow). Playwright smoke
  (`tests/e2e`: signup → org → project → key → CRUD → upload → 403 + dashboard).
- Gated live coverage: `LIVE_PG_URL` (CDC round-trip), `LIVE_REDIS_URL`
  (cross-instance bus + presence), `DOCKER_TESTS=1` (container runtime, CDC E2E).
- Real function SDK data-plane: guarded project-scoped SELECT, object reads,
  project-bound publishes (unit + HTTP E2E incl. denials).
- Green `lint → typecheck → test → build` (199+ unit/integration, gated skips).

## Phase 9 — CLI + SDKs (next)

- CLI + language SDKs on the stable envelope (functions SDK data-plane next).
- Dashboard wires to live data (loading/empty/error states stay).

## Phase 10 — Provisioning & scale

- `ProvisioningService` cloud driver (Terraform/API) per project env.
- Usage metering + billing on top of function/realtime/storage metrics.
- AI backend generation on top of the stable envelope.

## Non-goals for Phase 1

No real persistence in routes, no OAuth/RLS/rotation, no WS server, no cloud
provisioning, no billing. Interfaces reserve all of it.
