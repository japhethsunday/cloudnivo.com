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

## Phase 6 — Durable control plane (next)

- Drizzle migrations + seed (roles/permissions) applied at deploy.
- Drizzle-backed registry/key/job/customer stores (replace memory adapters).
- Platform signup/login/session cookies + `GET /me`, org invites.
- Dashboard wires to live data (loading/empty/error states stay).
- Playwright smoke: signup → org → project → key → data CRUD → 403 cross-org.

## Phase 6 — Durable control plane (next)

- Drizzle migrations + seed (roles/permissions) applied at deploy.
- Drizzle-backed registry/key/job/customer/storage stores (replace memory adapters).
- Platform signup/login/session cookies + `GET /me`, org invites.
- Dashboard wires to live data (loading/empty/error states stay).
- Playwright smoke: signup → org → project → key → data CRUD → file upload → 403 cross-org.

## Phase 7 — Data-plane primitives

- Redis-backed `CacheService`/`RealtimeService` in prod; WS gateway with
  channel auth (`canSubscribe`).
- Storage webhooks/realtime events + multipart/resumable dashboard uploads.
- Automatic per-project REST (`/api/v1/data/:table` with RLS).

## Phase 8 — Provisioning & serverless

- `ProvisioningService` cloud driver (Terraform/API) per project env.
- Serverless functions + logs + usage metering + CLI/SDKs.
- AI backend generation on top of the stable envelope.

## Non-goals for Phase 1

No real persistence in routes, no OAuth/RLS/rotation, no WS server, no cloud
provisioning, no billing. Interfaces reserve all of it.
