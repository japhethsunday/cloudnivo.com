# CloudNivo architecture (Phase 2 — database provisioning engine)

CloudNivo is a Supabase-like Backend-as-a-Service. Phase 1 built the
foundation; Phase 2 adds the first real infrastructure capability: per-project
PostgreSQL provisioning on local Docker through a provider abstraction that
later accepts VPS/cloud drivers without control-plane rewrites.

## Monorepo layout

```text
apps/dashboard   Next.js 15 control-plane UI + BFF (`/api/v1/*`)
apps/api         Standalone Node `http` data-plane API (same envelope, no framework)
packages/config      Env validation (Zod, fail-fast). Single entry for all env access.
packages/logging     Structured JSON logger with secret redaction + requestId.
packages/validation  Shared Zod primitives (slugs, UUIDs, pagination, entities).
packages/database    Control-plane schema (Drizzle) + tenant + RBAC + DatabaseService.
packages/auth        Passwords (scrypt), sessions (JWT via jose), API keys (hash-only).
packages/storage     Object-storage abstraction (local driver today, S3 later).
packages/realtime    Pub/sub abstraction (in-memory today, Redis/WS later).
packages/cache       Cache abstraction (memory today, Redis via ioredis later).
packages/provisioning Local-only provision planner (Terraform/cloud driver later).
packages/api-core    Versioned envelope, validation, CORS, headers, rate-limit.
infrastructure/      Docker + Postgres bootstrap (extensions only; Drizzle owns schema).
docs/                Architecture, security, database, API, roadmap.
tests/               Cross-package integration tests.
```

Phase 2 additions (same layout, no rebuild):

```text
packages/database    + projectDatabases, databaseCredentials,
                       infrastructureInstances, provisioningJobs tables
                     + lifecycle.ts (status machine), project-db.ts (live pg:
                       health, guarded SQL, schema inspection, metrics)
packages/provisioning + provisioner.ts (DatabaseProvisioner interface)
                     + docker-provider.ts (real Docker adapter, execFile only)
                     + fake.ts (TEST-ONLY in-memory provider)
                     + jobs.ts (job store, idempotency, retry policy)
                     + orchestrator.ts (provision/destroy, audit sink)
                     + validation.ts (allow-listed identifiers)
                     + docker-provider.test.ts (gated: DOCKER_TESTS=1)
packages/config      + PROVISION_* limits (all configurable, none hard-coded)
apps/api             + registry.ts (metadata store: memory adapter now,
                       Drizzle adapter target documented)
                     + projects.ts (org/project/database/SQL/schema routes)
                     + projects.test.ts (8-test E2E with fake provider)
apps/dashboard       + projects list/create, projects/[id] database console
                       (status, connection reveal, actions, schema, SQL editor)
```

Phase 4 additions (same layout, no rebuild):

```text
packages/auth        + customer/ (types, tokens, metadata guards, email
                       abstraction, memory + Postgres stores, service, RLS)
packages/config      + AUTH_* TTLs/rate limits, EMAIL_DRIVER
apps/api             + customer-auth.ts (/auth/* routes, store selector,
                       strict limits, project CORS, audit)
                     + data.ts: customer-JWT callers + owner scoping
                     + auth.test.ts (7-test E2E), auth-docker.test.ts (gated)
apps/dashboard       + projects/[id]/auth console (users, CORS, email status)
docs/authentication.md (flows, tokens, RLS, client sketch)
```

Phase 5 additions (same layout, no rebuild):

```text
packages/storage     + types/validation/mime/signed-urls/providers (local
                       streaming + SigV4 S3)/policies/metadata/service/openapi
packages/database    + storage_buckets, storage_objects tables + migration
packages/config      + STORAGE_S3_*, STORAGE_MAX_FILE_MB/MAX_BUCKETS/
                       PROJECT_QUOTA_MB/RATE_MAX/SIGNING_SECRET/MAX_SIGNED_TTL_S
apps/api             + storage.ts (buckets/objects/sign/usage routes,
                       streaming uploads, signed redemption, quotas, audit)
                     + projects.ts: storage cascade on project delete
                     + data.ts: storage paths merged into openapi.json
                     + storage.test.ts (6-test E2E + security matrix)
apps/dashboard       + projects/[id]/storage console (buckets, browser,
                       upload, previews, usage, settings/policies)
docs/storage.md (providers, buckets, signed URLs, quotas, security)
```

## Storage architecture

```text
Dashboard ──► Storage API ──► ObjectStorageService ──► StorageProvider ──► disk / S3
   │               │                    │                        │
   │               │                    ▼                        ▼
   │               │           MemoryMetadataStore      Local (streaming fs)
   │               │         (Drizzle tables as         S3Compatible (SigV4)
   │               │          durable target)
   │               ▼
   │         Registry (audit) + quotas + policies
   ▼
Buckets browser, upload, previews, usage, settings
```

- **Provider boundary.** Routes depend only on `ObjectStorageService`, which
  binds a `StorageProvider` (bytes) to a metadata store (records). Local
  streams socket → temp file; S3 signs SigV4 over injected fetch. Vendors
  change at the factory.
- **Metadata ≠ bytes.** PostgreSQL rows describe; providers persist. Quotas
  reconcile both (overshoot rolls bytes back).
- **Capabilities, not sessions, for links.** Signed URLs carry their own
  HMAC-scoped authorization (`downloadSigned`/`putSigned` bypass caller
  policy by design — the token already authorized the exact object).

## Provisioning architecture

```text
Dashboard ──► Control API ──► Orchestrator ──► DatabaseProvisioner ──► Docker
   │               │                │                    │
   │               │                ▼                    ▼
   │               │           JobStore            postgres:16-alpine
   │               │         (idempotency,          per-project container
   │               │          retry, logs)          127.0.0.1-only ports
   │               ▼
   │         Registry (metadata) + AuditSink
   ▼
Poll jobs + database status (5s)
```

- **ProvisioningService boundary.** Business logic depends only on
  `DatabaseProvisioner` (`create/delete/start/stop/restart/status/metrics`).
  `DockerDatabaseProvider` is one adapter; `Vps/Cloud/KubernetesDatabaseProvider`
  implementations plug in later with zero route changes.
- **No Docker in business logic.** The only `docker` invocations live in
  `docker-provider.ts` via `execFile` argv (never a shell), with allow-listed
  identifiers (`validation.ts`) and `cloudnivo.*` ownership labels.
- **Job-based, never request-blocking.** `POST /projects` returns `202` with a
  job id; the orchestrator drives `pending → running → completed`
  (`failed`/`retrying` on error) with idempotency keys, attempt budgets, and
  recoverable-only retries.
- **Real status, always.** Container state comes from `docker inspect`, health
  from a live `select 1` probe. When Docker is absent the API returns
  `503 INFRA_UNAVAILABLE` — never an invented "Running".
- **Future cloud path.** Add a provider implementing the same interface
  (remote host/port/credentials instead of containers); orchestrator, jobs,
  routes, and dashboard are untouched.

## Control plane vs data plane

- **Control plane** (`apps/dashboard`, `packages/database`): users, orgs,
  memberships, projects, environments, API keys, roles, audit logs. This is the
  source of truth for tenancy. Deployed to **Vercel** (zero infra cost).
- **Data plane** (future): per-project Postgres, storage buckets, realtime
  gateways, serverless functions. In Phase 1 only the _interfaces_ exist
  (`StorageService`, `RealtimeService`, `ProvisioningService`); local drivers
  back them. Migrating to paid cloud later means adding a driver, not rewriting
  callers.

## Key decisions

1. **No cloud coupling.** Every infra dependency sits behind an interface with a
   local/memory implementation. `ioredis`, `postgres`, and `jose` are the only
   infra clients, and none are imported outside their owning package.
2. **TypeScript paths + built `dist`.** Tests and `apps/api` typecheck resolve
   `@cloudnivo/*` to `packages/*/src` (instant, no build). The dashboard
   bundles built `dist/` (its bundler cannot resolve TS source subpaths), so
   run `npm run build:packages` before dashboard dev/build — root `typecheck`
   and `build` scripts already enforce this order. Production resolves to
   built `dist/` via npm workspace symlinks everywhere.
3. **Framework-free `apps/api`.** Plain `node:http` proves the envelope works
   without Next.js, keeping the future data-plane portable.
4. **Drizzle owns the schema.** `infrastructure/postgres/init.sql` only enables
   extensions; migrations come from `drizzle-kit generate` in `packages/database`.
5. **Fail-fast config.** `loadConfig()` throws `ConfigError` at boot on missing
   secrets — never at request time, never with credential echo.

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d        # postgres + redis
npm run db:migrate           # when migrations exist (Phase 2 seeds)
npm run dev                  # dashboard on :3000
npm run dev:api              # standalone API on :3001
```

## Future infrastructure strategy

Phase 2 delivered local Docker provisioning behind the provider interface.
Phase 3 delivered the data plane (`@cloudnivo/api-engine` + generated REST)
which talks only to `DatabaseProvisioner` / parameterized SQL — identical on
Docker, Railway, or VPS. Phase 4 adds Drizzle-backed metadata; later phases
add cloud provisioners, realtime gateway, and S3 storage. None of these change
the API envelope or tenancy model established here.

## Deploy targets

Local compose (`postgres` + `redis`, optional `api` profile), host-run API +
dashboard (`npm run dev:api` / `npm run dev`), Railway (`Dockerfile.api` +
`railway.json`), any VPS (same image + env). See `docs/deploy-railway.md`.
