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
Auth endpoints carry stricter budgets (`AUTH_RATE_MAX`, default 10/window).

## Customer auth (Phase 4)

`POST /api/v1/projects/:id/auth/signup|token|refresh|logout|reset-request|
reset|verify|change`, `GET|PATCH /user`, `GET /sessions`,
`DELETE /sessions/:id`, `POST /sessions/revoke-all`,
`GET|PATCH|DELETE /admin/users`, `GET|PATCH /config`, `GET /email/status`.
Full reference in `docs/authentication.md`.

## Storage plane (Phase 5)

`/storage/v1` mounted per project (`/api/v1/projects/:id/storage/*`).
Reserved word: a table literally named `storage` stays unreachable via data
routes (documented collision, same class as `database`/`jobs`/`auth`).

| Method   | Path                                                 | Auth                    | Description                                                                  |
| -------- | ---------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `POST`   | `/storage/buckets`                                   | admin/owner session     | create `{name, visibility, fileSizeLimit, allowedMimeTypes, ownerIsolation}` |
| `GET`    | `/storage/buckets`                                   | member+                 | list (tenant-scoped, never cross-project)                                    |
| `GET`    | `/storage/buckets/:bucket`                           | member+                 | bucket metadata                                                              |
| `PATCH`  | `/storage/buckets/:bucket`                           | admin/owner session     | visibility/limits/allowlist/isolation                                        |
| `DELETE` | `/storage/buckets/:bucket`                           | admin/owner session     | must be empty (409 otherwise)                                                |
| `GET`    | `/storage/buckets/:b/objects?prefix=&limit=&offset=` | member+ (authed)        | list (mine-only for isolated customers)                                      |
| `PUT`    | `/storage/buckets/:b/objects/:path`                  | writer (`?upsert=true`) | raw-body upload, streamed, sniffed                                           |
| `GET`    | `/storage/buckets/:b/objects/:path`                  | gated (or public/anon)  | download with safe disposition                                               |
| `GET`    | `/storage/buckets/:b/objects/:path/metadata`         | gated                   | metadata, no bytes                                                           |
| `DELETE` | `/storage/buckets/:b/objects/:path`                  | writer                  | delete bytes + metadata                                                      |
| `POST`   | `/storage/buckets/:b/objects/:path/move`             | writer (`{dest}`)       | atomic-ish move                                                              |
| `POST`   | `/storage/buckets/:b/objects/:path/copy`             | writer (`{dest}`)       | copy (quota-checked)                                                         |
| `POST`   | `/storage/buckets/:b/sign`                           | writer                  | mint download/upload capability URL                                          |
| `POST`   | `/storage/buckets/:b/upload-sign`                    | writer                  | mint upload URL (`PUT` target)                                               |
| `GET`    | `/storage/s/:token`                                  | token-only (no headers) | redeem download                                                              |
| `PUT`    | `/storage/s/:token`                                  | token-only (no headers) | redeem upload                                                                |
| `GET`    | `/storage/usage`                                     | member+                 | files/bytes/uploads/downloads vs quota                                       |

Paths with slashes must be percent-encoded per segment. Uploads stream with a
`STORAGE_MAX_FILE_MB` cap; per-bucket caps and project quotas (`STORAGE_*`
limits) are enforced pre- and post-write. Storage paths ship inside
`openapi.json` alongside table routes.

## Realtime plane (Phase 6)

WebSocket at `/api/v1/projects/:id/realtime/ws` (`?token=<session|customer JWT>`
or `?apikey=<key>`; `101` on success, `401/403/404/429` otherwise — never
upgraded on failure). Frames are JSON text (`subscribe/unsubscribe/broadcast/
presence.set/presence.remove/ping` → `subscribed/unsubscribed/event/broadcast/
presence/pong/error`); channels are `project:<uuid>:<topic>` with
`table:<name>` topics for row changes and optional equality `filter` objects.
Full wire reference in `docs/realtime.md`.

| Method | Path                                     | Auth   | Description                                                                    |
| ------ | ---------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/projects/:id/realtime`          | Bearer | WS URL, bus/presence drivers, `degraded` flag                                  |
| `GET`  | `/api/v1/projects/:id/realtime/stats`    | Bearer | metrics snapshot (connections, channels, published/delivered/dropped, latency) |
| `GET`  | `/api/v1/projects/:id/realtime/channels` | Bearer | active channels + subscriber counts                                            |
| `GET`  | `/api/v1/projects/:id/realtime/presence` | Bearer | presence state (≤50 channels)                                                  |

Reserved word: a table literally named `realtime` stays unreachable via data
routes (documented collision, same class as `database`/`jobs`/`auth`/`storage`).

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
