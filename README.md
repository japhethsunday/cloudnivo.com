# cloudnivo.com

CloudNivo — developer-focused Backend-as-a-Service (Supabase-like) control-plane
foundation. **Phase 1: architecture & foundation** (production-quality monorepo,
multi-tenant by design, $0 infra to start).

## Stack

Next.js 15 · TypeScript · PostgreSQL 16 · Redis 7 · Drizzle ORM · Zod ·
Vitest · ESLint · Prettier · Docker Compose. Vercel hosts the control plane;
Postgres/Redis run locally via Docker and migrate to managed cloud later
without rewrites (every infra dependency sits behind an interface).

## Quickstart

```bash
cp .env.example .env
npm install
docker compose up -d
npm run dev        # dashboard → http://localhost:3000
npm run dev:api    # standalone API → http://localhost:3001
```

Verify:

```bash
npm run lint
npm run typecheck
npm test
npm run build
curl http://localhost:3001/api/v1/health
```

## Layout

- `apps/dashboard` — Next.js control-plane UI + `/api/v1/*` BFF
- `apps/api` — framework-free Node API (same envelope)
- `packages/{config,logging,validation,database,auth,storage,realtime,cache,provisioning,api-core}` — shared foundation
- `infrastructure/` — Docker + Postgres bootstrap
- `docs/` — `architecture.md`, `security.md`, `database.md`, `api.md`, `roadmap.md`
- `tests/` — cross-package integration tests

## Tenancy

`User → Organization → Project → Infrastructure`. Memberships are the only
access grant; `assertSameTenant()` + `can(role, permission)` run server-side on
every request. See `docs/security.md` and `docs/database.md`.

## Env

All config via `loadConfig()` (`packages/config`) — fails fast with `ConfigError`
when secrets are missing. Never commit `.env`, `*.key`, `*.pem`.
