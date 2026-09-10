# CloudNivo database architecture (Phase 2 + Phase 8 durable plane)

## Engine

PostgreSQL 16 (Docker locally, managed Postgres later). Access only via
`DatabaseService` (`packages/database/src/service.ts`) — Drizzle ORM +
`postgres` driver are implementation details.

Two strictly separated planes: the **control database** (platform metadata)
and **project databases** (one Postgres per project, customer data). Never mix
them — see below.

## Durable control plane (Phase 8)

Memory adapters stay the dev/test default (`CONTROL_STORE=memory`). Production
sets `CONTROL_STORE=drizzle` with migrations + seed applied at deploy:

```bash
npm run db:migrate   # drizzle migrations on DATABASE_URL
npm run db:seed      # idempotent roles/permissions catalog
```

| Store                                                                       | Memory                                | Drizzle                                                | Tables                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry (orgs, projects, memberships, databases, credentials, audit, CORS) | `MemoryRegistry`                      | `DrizzleRegistry` (`apps/api/src/registry-drizzle.ts`) | `organizations`, `organization_memberships`, `projects`, `project_databases`, `database_credentials`, `audit_logs`, `project_auth_configs` |
| Project keys                                                                | `MemoryKeyStore`                      | `DrizzleKeyStore`                                      | `api_keys`                                                                                                                                 |
| Provisioning jobs                                                           | `MemoryJobStore`                      | `DrizzleJobStore`                                      | `provisioning_jobs`                                                                                                                        |
| Storage metadata                                                            | `MemoryStorageMetadataStore`          | `DrizzleStorageMetadataStore`                          | `storage_buckets`, `storage_objects`, `storage_usage`                                                                                      |
| Platform users/invites                                                      | `MemoryPlatformUsers`/`MemoryInvites` | `DrizzlePlatformUsers`/`DrizzleInvites`                | `users`, `organization_invites`                                                                                                            |
| Customer auth                                                               | memory (fake/test)                    | `PgCustomerAuthStore` (per-project DB schema)          | `auth.*` in project DBs                                                                                                                    |

The `Registry` interface is async so both adapters satisfy it; unique
violations map to the same 409s, unknown ids read 404 on both. Boot with
`CONTROL_STORE=drizzle` fails fast when the control database is unreachable.
Live-Postgres/Redis/Docker coverage is gated (`LIVE_PG_URL`, `LIVE_REDIS_URL`,
`DOCKER_TESTS=1`) — see `docs/functions.md` testing notes and `tests/e2e`
for the Playwright smoke.

## Control-plane tables

| Table                                        | Purpose                                        | Tenancy         |
| -------------------------------------------- | ---------------------------------------------- | --------------- |
| `users`                                      | identity (email unique, scrypt hash)           | global          |
| `organizations`                              | tenant root (slug unique)                      | root            |
| `organization_memberships`                   | `user ↔ org` + `role`, unique `(org,user)`     | org-scoped      |
| `projects`                                   | `org → project`, unique `(org,slug)`           | org-scoped (FK) |
| `project_environments`                       | `project → env`, unique `(project,slug)`       | via project     |
| `api_keys`                                   | `{ prefix, sha256 hash, scopes[] }`, never raw | via project     |
| `roles` / `permissions` / `role_permissions` | static RBAC catalog                            | global          |
| `audit_logs`                                 | append-only, org-scoped, redacted metadata     | org-scoped      |

## Phase 2 metadata tables (control plane)

| Table                      | Purpose                                                | Tenancy                       |
| -------------------------- | ------------------------------------------------------ | ----------------------------- |
| `project_databases`        | one row per provisioned DB (handle, host/port, status) | org-scoped (+ project unique) |
| `database_credentials`     | server-side user/password (access-checked + audited)   | org-scoped                    |
| `infrastructure_instances` | provider records (container id, status)                | via database                  |
| `provisioning_jobs`        | async ops, idempotency keys, attempts, logs            | org-scoped                    |

`organization_memberships` already covers `project_members` semantics — no
duplicate table. Passwords stay out of logs and API payloads (masked by
default, explicit audited reveal only). Phase 3 adds KMS envelope encryption
for `database_credentials.db_password`.

## Database lifecycle

`creating → ready → running ⇄ stopped → restarting → ready`, plus `failed`,
`deleting → deleted` (`lifecycle.ts`, transition-guarded). Steady states are
`ready/running/stopped`. Live health (`healthy/unhealthy/starting/unavailable`)
comes from real `select 1` probes (`project-db.ts`), overlaid on the stored
lifecycle status by the API on every read.

## Customer access layer (`project-db.ts`)

- `checkProjectDbHealth()` — refused/unreachable → `unavailable`, auth errors → `unhealthy`.
- `executeProjectSql()` — single statement only, `statement_timeout`, SELECT
  row-capping, bounded length. Writes execute exactly once.
- `queryProjectDb()` — parameterized executor for the API engine (text +
  `$n` params; identifiers must be pre-validated by the query builder).
- `inspectProjectSchema()` — tables, columns, PKs, FKs, indexes from
  `information_schema`/`pg_catalog`.
- `getProjectDbMetrics()` — `version()`, `pg_database_size`, `pg_stat_activity`.

## Project API keys → `api_keys` mapping

Runtime key records (`MemoryKeyStore`, Phase 4 → Drizzle) mirror the Phase 1
`api_keys` table: `{ prefix, sha256 hash }`, project FK, scopes array,
expiry/revocation timestamps. Raw secrets exist only in the issue response.

## Provisioning jobs

`pending → running → completed`, with `retrying`/`failed`. Idempotency keys are
unique per org (double submits collapse); retries apply only to recoverable
provider errors within `PROVISION_MAX_ATTEMPTS`, with capped backoff.

## Multi-tenancy rules

1. Every tenant row resolves to exactly one `organizationId` (directly or via
   `project → organization`). Helpers in `tenant.ts` enforce this in code.
2. Writes require `assertSameTenant(memberships, resource, userId)` after loading
   memberships in the request session — never from client claims.
3. Reads filter with `scopeProjectsToMemberOrgs()` before pagination.
4. `organization_memberships.role ∈ { owner, admin, member, viewer }` with the
   hierarchy in `rbac.ts`. `can(role, permission)` is the only permission check.

## Migrations

```bash
npm run db:generate   # drizzle-kit generate → packages/database/drizzle/
npm run db:migrate    # drizzle-kit migrate against DATABASE_URL
```

`infrastructure/postgres/init.sql` only creates `pgcrypto`/`uuid-ossp` on fresh
volumes. Drizzle is the schema authority.

## Connection handling

`createDatabaseService(DATABASE_URL)` validates the URL eagerly (fail-fast),
pools with `max: 10`, and exposes `healthCheck()` that returns
`{ ok, latencyMs }` instead of throwing — readiness probes and `/health`
stay safe when Postgres is down.

## AI-generated migrations (Phase 9)

AI plans produce ordered, checksummed DDL via packages/ai migrate.ts (identifiers allow-listed, single statements) and execute through the guarded project-DB executor after approval. Inverse DROP statements roll back when only the migration ran. See docs/ai-builder.md.
