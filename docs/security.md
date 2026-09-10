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
- **Data plane (Phase 3):** table/column names are allow-listed against live
  introspection (never interpolated); values are `$n` bind parameters only.
  Unknown fields rejected (no mass assignment), PKs immutable, pagination
  clamped, bodies capped (256 KB data writes, 1 MB global), single-statement
  SQL editor unchanged. Project keys are sha256-hashed, expiry/revocation
  enforced, usage-counted, and can never mint keys. `apikey` header only —
  never query strings (no secret in logs/URLs). Error messages never echo raw
  table references, SQL, or credentials.
- **Customer auth (Phase 4):** scrypt password hashing (8–128 chars); short
  access JWTs audience-bound per project + live session checks (revocation
  kills tokens); rotating opaque refresh with reuse-theft detection; hashed
  single-use verify/reset tokens; enumeration-neutral login/reset; dummy-hash
  timing equalization; strict per-endpoint rate limits (brute-force bucket
  trips at 10/window); metadata allowlist (roles never user-writable);
  per-project CORS (wildcards rejected); full security audit trail; no
  passwords/tokens/secrets in logs, responses, or admin listings.
- **Storage (Phase 5):** logical keys validated (traversal, null bytes,
  absolute/drive paths rejected) and namespaced per project; browser MIME
  distrusted (magic-byte sniffing, executable spoofs rejected, safe-inline
  allowlist for previews, rest `attachment`); HMAC capability tokens bind
  project/bucket/path/op/expiry with constant-time verifies and op separation;
  owner-prefix policies for customers, public-bucket anonymous downloads only
  (no listing oracle); reads 404 / writes 403 on denial; quotas enforced
  pre- and post-write with rollback; per-bucket caps; non-empty bucket delete
  blocked; signed-URL + upload/download/list/delete budgets rate-limited;
  responses never carry storage keys or secrets; Docker-socket mounting (compose
  `api` profile) documented as a local-dev-only tradeoff.
- **Realtime (Phase 6):** upgrade auth reuses data-plane caller resolution
  (customer JWT with live revocation check, platform session with membership
  check, project key with scope/expiry/revocation check — all over query params
  since browsers cannot set WS headers; tokens never logged). Channels bind the
  project structurally (`project:<uuid>:<topic>` — cross-project subscribe and
  broadcast rejected by shape and re-checked per message). Viewers/anonymous/
  public keys listen but never broadcast; presence requires an identity and is
  removed on disconnect/unsubscribe (Redis TTL garbage-collects the rest).
  Table events re-apply owner-scoped delivery per subscriber (engine RLS twin)
  plus validated equality filters (allow-listed keys, primitive values, ≤8
  entries — never SQL). Expired credentials are rejected at upgrade and swept
  mid-connection (`expiresAt` from JWT `exp`/key expiry). Floods capped
  (upgrade budget per IP, 20 msg/s per socket, 60 broadcasts/min per sender,
  50 subs/socket, 500 conns/project, 64 KB frames/payloads, 4 KB presence
  metadata); violations return error envelopes without dropping honest
  connections, while malformed frames close safely. Redis pub/sub carries only
  `{channel, kind, event}` with an origin id (no echo, malformed bus payloads
  dropped); outages degrade to local-only delivery, never a hard outage.
  Metrics/logs expose counts and latency only — no tokens, passwords, payloads,
  or infra internals.
- **Functions (Phase 7):** customer code is untrusted. Worker isolates run
  source in a `vm` context with no `require`/`process`/`fetch`/`WebSocket`;
  only the frozen `cloudnivo` SDK (identity + project + env), capturing
  console, and timers exist. Containers bake source into images (no host
  mounts) and run `--network none --cap-drop ALL --read-only --pids-limit 64`
  with memory caps. Entrypoint segments `__proto__`/`constructor`/`prototype`
  rejected; slugs/env keys allow-listed; source/env/body/response sizes capped
  (413/502 past limits); timeouts terminate the isolate (504); concurrency
  capped per function and invocations rate-limited per project (429).
  Invocation strips `authorization`/`apikey`/`cookie`/`host` headers; the
  handler receives identity only — never signing secrets, connection strings,
  or other projects' data (project comes from the URL, every credential is
  re-scoped; unknown and foreign functions both read 404). Secrets masked in
  API responses and redacted from logs; reserved env keys unsettable. Build
  verification proves the entrypoint exists without invoking the handler, so
  `ready` never follows a failed build.
- **Durable plane (Phase 8):** platform passwords are scrypt-hashed (dummy
  work on unknown emails, enumeration-neutral); sessions are signed JWTs with
  httpOnly cookies; invite tokens are opaque with sha256-only storage and
  7-day expiry; owner-gated invite roles (only owners invite owners);
  strict auth rate limits; drizzle adapters map unique violations to the same
  409s (no cross-tenant oracles — unknown and foreign read 404); audit writes
  never break requests and never carry secrets.
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
passwords, key rotation, OAuth, or per-project network
isolation — tracked in `roadmap.md`. Audit coverage for provisioning events
(`project.created` … `database.query.executed`) is implemented; review the
audit store before relying on it for compliance.
