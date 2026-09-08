# CloudNivo API architecture (Phase 1)

Base path: **`/api/v1`** (dashboard BFF + standalone `apps/api` share it).

## Envelope

```json
// success
{ "data": { "projects": [] }, "meta": { "requestId": "…" } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "requestId": "…", "details": [...] } }
```

Status mapping: `400` validation, `401` auth, `403` tenant/RBAC, `404` unknown,
`409` conflicts, `429` rate-limited, `500` internal (message redacted).

## Cross-cutting behavior

- `X-Request-Id` in/out (echo when well-formed, else `randomUUID()`).
- `securityHeaders()` + `corsHeaders(origin, allowlist)` on every response.
- `OPTIONS` short-circuits with `204` (CORS preflight).
- `checkRateLimit()` per IP (default 120/min) → `429 RATE_LIMITED`.
- Zod `parseBody`/`parseQuery` → `400 VALIDATION_ERROR` with field details.
- `toPublicError()` guarantees no stack/credential leak in 5xx.
- Structured logs with `requestId`, redacted fields.

## Endpoints (Phase 1)

| Method | Path               | Auth   | Description                                                                   |
| ------ | ------------------ | ------ | ----------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health`   | no     | liveness + version envelope                                                   |
| `GET`  | `/api/v1/projects` | Bearer | tenant-scoped stub (empty list; DB in Phase 2)                                |
| `POST` | `/api/v1/projects` | Bearer | validates `{ name, slug, organizationId }`, echoes `201` (no persistence yet) |

## Auth

`Authorization: Bearer <JWT>` → `verifySession()` (issuer-checked). Missing or
invalid → `401 UNAUTHORIZED`. API keys (`cn_…` → sha256 lookup) land with
persistence in Phase 2; the hash-only scheme is already fixed.

## Versioning

Breaking changes go to `/api/v2`. Additive fields are backward-compatible and
do not bump the version. `apps/api` stays framework-free so the contract is
portable beyond Next.js.
