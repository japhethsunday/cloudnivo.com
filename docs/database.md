# CloudNivo database architecture (Phase 1)

## Engine

PostgreSQL 16 (Docker locally, managed Postgres later). Access only via
`DatabaseService` (`packages/database/src/service.ts`) — Drizzle ORM +
`postgres` driver are implementation details.

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
