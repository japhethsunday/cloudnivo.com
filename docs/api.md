# CloudNivo API architecture (Phase 2)

Base path: **`/api/v1`** (dashboard BFF + standalone `apps/api` share it).

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

## Auth

`Authorization: Bearer <JWT>` → `verifySession()` (issuer-checked). Missing or
invalid → `401 UNAUTHORIZED`. API keys (`cn_…` → sha256 lookup) land with
persistence in Phase 2; the hash-only scheme is already fixed.

## Versioning

Breaking changes go to `/api/v2`. Additive fields are backward-compatible and
do not bump the version. `apps/api` stays framework-free so the contract is
portable beyond Next.js.
