# CloudNivo architecture (Phase 1 — foundation)

CloudNivo is a Supabase-like Backend-as-a-Service. Phase 1 builds only the
**production-quality foundation** every later phase reuses — not the full platform.

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
2. **TypeScript paths + built `dist`.** Dev/test resolve `@cloudnivo/*` to
   `packages/*/src` (instant, no build). Production resolves to built
   `dist/` via npm workspace symlinks. Root `npm run build` builds everything.
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

Phase 2 adds real persistence + auth flows on this schema. Phase 3 adds the
Realtime gateway (Redis pub/sub) and S3-compatible storage. Phase 4 adds
per-project provisioning (Terraform/cloud APIs) behind `ProvisioningService`.
None of these change the API envelope or tenancy model established here.
