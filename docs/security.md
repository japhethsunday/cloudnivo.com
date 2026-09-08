# CloudNivo security model (Phase 1)

## Threat model

Untrusted browser clients, multi-tenant data, long-lived secrets (JWT, API keys,
`DATABASE_URL`). The foundation assumes the network is hostile and the client
is lying.

## Boundaries

- **Authentication boundary:** `Bearer` JWT (`@cloudnivo/auth`) or API-key hash
  lookup. `bearerFromHeader()` never logs tokens. Weak secrets rejected at boot
  (`JWT_SECRET` ≥ 32 chars) and at sign time.
- **Authorization boundary:** server-side only. Client-supplied `organizationId`,
  `projectId`, `role`, or `permissions` are _hints at best_ — every read/write
  loads memberships from the DB and calls `assertSameTenant()` + `can()`.
  Unknown roles grant nothing.
- **Tenant isolation:** `User → Organization → Project → Infrastructure`.
  `projects.organizationId` is `NOT NULL` + FK; list endpoints filter via
  `scopeProjectsToMemberOrgs()` _before_ pagination. Tests prove `u1` in `org-a`
  can never read `org-b` rows.
- **Input validation:** Zod at every API boundary (`parseBody`/`parseQuery`).
  Slugs, UUIDs, and emails share strict schemas in `@cloudnivo/validation`.
  Failures return `400 VALIDATION_ERROR` with field-level details, never stack traces.
- **Secrets:** raw API keys exist only in the create response (`cn_…`, once).
  Stored form is `{ keyPrefix, keyHash: sha256 }`. Passwords are
  `scrypt:salt:hash`. `DATABASE_URL`/tokens are redacted in logs and never
  echoed in `ConfigError` or 5xx responses.
- **Audit logs:** `audit_logs` is append-only, org-scoped, with JSONB metadata
  that MUST NOT contain PII/secrets (enforced by review + redacting logger).
- **Transport:** `Strict-Transport-Security`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'self'`, `Referrer-Policy`, and
  `Permissions-Policy` on all responses (Next middleware + api-core).
- **CORS:** explicit allowlist (`CORS_ORIGINS`). Non-listed origins get no
  `Access-Control-Allow-Origin` (fail-closed).
- **Rate limiting:** `checkRateLimit()` over `CacheService.incr()` (memory
  locally, Redis in prod). Default 120 req/min/IP. `429 RATE_LIMITED` envelope.
- **Errors:** `toPublicError()` maps `ApiError`/`ZodError` to stable envelopes;
  5xx messages are replaced with `Internal server error`.
- **Headers/IDs:** every response carries `X-Request-Id` (client-supplied only
  if well-formed, else `randomUUID()`); logs join on it without PII.

## What Phase 1 does NOT yet do

Row-Level Security (RLS) policies, key rotation, OAuth, WebSocket auth, or
per-project network isolation — all scheduled after the control-plane
persistence lands (see `roadmap.md`). The interfaces already reserve space.
