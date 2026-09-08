# CloudNivo security model (Phase 2)

## Threat model

Untrusted browser clients, multi-tenant data, long-lived secrets (JWT, API keys,
`DATABASE_URL`, per-project DB passwords). The platform assumes the network is
hostile and the client is lying — now including infrastructure operations.

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
- **Database credentials (Phase 2):** per-project passwords are generated
  server-side (`crypto.randomBytes`) or validated (12–128 chars), stored in
  `database_credentials`, masked (`••••••••`) in every API response, revealed
  only to org members via an audited endpoint. Error redaction strips
  credential-shaped substrings from driver messages. Known local-dev tradeoff:
  the password travels via `docker -e` at container create (briefly visible in
  the host process list); cloud providers later will use secret mounts.
- **Command injection:** no shell is ever spawned for infrastructure. Docker runs
  through `execFile` argv with allow-listed identifiers (`validation.ts`:
  slugs, container names, pg idents, image versions). Unsanitized input cannot
  reach a process API.
- **SQL injection:** the SQL editor executes exactly one statement per call
  (multi-statements rejected), under `statement_timeout`, with SELECT row caps.
  Schema/metrics use parameterized `postgres.js` tagged templates only.
- **Cross-project/org access:** every database route resolves the org from the
  stored project row (`mustOwnProject`) and asserts membership; job lookups are
  re-scoped to the project; idempotency dedup verifies membership before
  returning a peer job (no cross-org oracle).
- **Destructive actions:** start/stop/restart/delete require membership and are
  audit-logged; delete removes the container AND its volume AND metadata.
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

## What Phase 2 does NOT yet do

Row-Level Security (RLS) policies, KMS envelope encryption for stored DB
passwords, key rotation, OAuth, WebSocket auth, or per-project network
isolation — tracked in `roadmap.md`. Audit coverage for provisioning events
(`project.created` … `database.query.executed`) is implemented; review the
audit store before relying on it for compliance.
