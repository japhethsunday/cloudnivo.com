# CloudNivo API architecture (Phase 3)

Base path: **`/api/v1`** (dashboard BFF + standalone `apps/api` share it).

Envelope note: the spec sketch shows `{ success, error }`; the platform keeps
the Phase 1/2 envelope (`{ data, meta }` / `{ error: { code, message,
requestId } }`) deliberately — every client, dashboard panel, and test already
depends on it, and it carries strictly more (request tracing).

## Envelope

```json
// success
{ "data": { "projects": [] }, "meta": { "requestId": "…" } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "requestId": "…", "details": [...] } }
```

Status mapping: `400` validation, `401` auth, `403` tenant/RBAC/limits,
`404` unknown, `409` conflicts, `429` rate-limited, `500` internal (message
redacted), `502` infrastructure operation failure (detail logged, not returned),
`503` infrastructure unavailable (Docker unreachable — retry later).

## Cross-cutting behavior

- `X-Request-Id` in/out (echo when well-formed, else `randomUUID()`).
- `securityHeaders()` + `corsHeaders(origin, allowlist)` on every response.
- `OPTIONS` short-circuits with `204` (CORS preflight).
- `checkRateLimit()` per IP (default 120/min) → `429 RATE_LIMITED`.
- Zod `parseBody`/`parseQuery` → `400 VALIDATION_ERROR` with field details.
- `toPublicError()` guarantees no stack/credential leak in 5xx.
- Structured logs with `requestId`, redacted fields.

## Endpoints (Phase 2)

| Method   | Path                                       | Auth   | Description                                              |
| -------- | ------------------------------------------ | ------ | -------------------------------------------------------- |
| `GET`    | `/api/v1/health`                           | no     | liveness + version envelope                              |
| `GET`    | `/api/v1/organizations`                    | Bearer | caller's orgs                                            |
| `POST`   | `/api/v1/organizations`                    | Bearer | create org (caller becomes owner)                        |
| `GET`    | `/api/v1/projects`                         | Bearer | tenant-scoped list with live database state              |
| `POST`   | `/api/v1/projects`                         | Bearer | create + enqueue provisioning → `202 { project, jobId }` |
| `GET`    | `/api/v1/projects/:id`                     | Bearer | project + database record + latest job                   |
| `DELETE` | `/api/v1/projects/:id`                     | Bearer | delete infra (container + volume) then metadata          |
| `GET`    | `/api/v1/projects/:id/database`            | Bearer | overview with REAL live status/health                    |
| `GET`    | `/api/v1/projects/:id/database/connection` | Bearer | masked by default; `?reveal=true` audited full access    |
| `POST`   | `/api/v1/projects/:id/database/actions`    | Bearer | `{ action: start\|stop\|restart }`                       |
| `GET`    | `/api/v1/projects/:id/database/schema`     | Bearer | tables, columns, PKs, FKs, indexes                       |
| `POST`   | `/api/v1/projects/:id/database/query`      | Bearer | guarded single-statement SQL + duration                  |
| `GET`    | `/api/v1/projects/:id/database/metrics`    | Bearer | version, size, connection count                          |
| `GET`    | `/api/v1/projects/:id/jobs` (+ `/:jobId`)  | Bearer | provisioning/operation jobs + logs                       |

`POST /projects` honors `Idempotency-Key` (opaque, same-org): repeats return
the live job without creating duplicates. Provisioning runs as a background
job — poll `jobs/:jobId` until `completed`, then read `database`.

## Data plane — generated table APIs (Phase 3)

Every table discovered by live introspection is served dynamically — no
hardcoded names (`database`/`jobs` stay reserved for control routes):

| Method   | Path                                      | Auth                  | Description                                   |
| -------- | ----------------------------------------- | --------------------- | --------------------------------------------- |
| `GET`    | `/api/v1/projects/:id/:table`             | session or key        | list (`select, filter, order, limit, offset`) |
| `GET`    | `/api/v1/projects/:id/:table/:rowId`      | session or key        | one row by single-column PK                   |
| `POST`   | `/api/v1/projects/:id/:table`             | writer only           | insert (unknown fields rejected)              |
| `PATCH`  | `/api/v1/projects/:id/:table/:rowId`      | writer only           | partial update (PK immutable)                 |
| `DELETE` | `/api/v1/projects/:id/:table/:rowId`      | writer only           | delete                                        |
| `GET`    | `/api/v1/projects/:id/keys`               | session (keys:read)   | list keys (hashes never exposed)              |
| `POST`   | `/api/v1/projects/:id/keys`               | session (keys:create) | issue key (raw shown once)                    |
| `POST`   | `/api/v1/projects/:id/keys/:keyId/revoke` | session (keys:revoke) | revoke                                        |
| `GET`    | `/api/v1/projects/:id/openapi.json`       | session or key        | live OpenAPI 3.0 for this project             |

Query grammar: `?select=a,b` · `?col=op.value` (`eq,neq,gt,gte,lt,lte,like,
ilike,in,is`) · `?order=col.asc,col.desc` · `?limit=&offset=` (clamped to
`PROVISION_MAX_SQL_ROWS`). Filters/sorts/columns are validated against the
introspected snapshot; values are `$n` bind parameters only.

Auth: `Authorization: Bearer <JWT>` (org member; viewers read-only, writers
need `projects:update`) or `apikey: <cn_…>` project key (`public` read-only,
`service`/`admin` read+write; keys can never manage keys). Stable base URL:
`{PUBLIC_API_URL}/api/v1/projects/:id` — local default
`http://localhost:3001`, production via env.

Rate limits (all 429 on breach): global per-IP (existing) + per-key
(`DATA_API_KEY_MAX`, default 300) + per-project (`DATA_API_PROJECT_MAX`,
default 1000) over the cache abstraction (memory locally, Redis in prod).

## Auth

`Authorization: Bearer <JWT>` → `verifySession()` (issuer-checked). Missing or
invalid → `401 UNAUTHORIZED`. Project API keys (`cn_…` → sha256 lookup, roles
`public`/`service`/`admin`, expiry, revocation) authenticate data-plane calls
via the `apikey` header — scoped to exactly one project, hashed at rest,
usage-counted. Session JWTs remain the only credential that can mint keys.

## Versioning

Breaking changes go to `/api/v2`. Additive fields are backward-compatible and
do not bump the version. `apps/api` stays framework-free so the contract is
portable beyond Next.js.
