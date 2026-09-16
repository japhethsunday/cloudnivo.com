# CloudNivo security audit — 2026-09-16

Defensive assessment of the whole application: repository, API, data plane,
functions, provisioning, infrastructure and CI/CD. Every finding below was
reproduced against a running CloudNivo instance (standalone API on a real
PostgreSQL 16 cluster with `PROVISION_DRIVER=managed`, the production driver)
before it was fixed, and re-tested after. Nothing here is speculative; items
that were checked and found sound are listed under **Verified sound**.

No production data was touched. All testing used throwaway accounts, projects
and databases in an isolated local cluster. No real credential, key or token
appears in this document, in the tests, or in the commit history.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Function sandbox escape → host `process`/`require` (all platform secrets) | **CRITICAL** | Fixed + regression tests |
| 2 | Any tenant database role could connect to every other tenant's database and to the control-plane database | **HIGH** | Fixed + retroactive repair |
| 3 | Brute-force protection bypassed by spoofing `X-Forwarded-For` | **HIGH** | Fixed + regression tests |
| 4 | Platform accounts accepted `password`, `12345678`, `aaaaaaaa` | **HIGH** | Fixed + regression tests |
| 5 | SSRF guard on log drains checked the hostname string only (no DNS resolution) | **MEDIUM** | Fixed + regression tests |
| 6 | Unique-violation detection missed wrapped driver errors → duplicate signup 500s, idempotency keys silently not deduping (payments, provisioning jobs, storage objects) | **MEDIUM** | Fixed + regression tests |
| 7 | Documentation placeholder secrets could boot production | **MEDIUM** | Guard added |
| 8 | SQL editor errors surfaced as `500 Internal server error` | **LOW** | Fixed + verified |
| 9 | GitHub Actions workflows ran without an explicit least-privilege `permissions` block | **LOW** | Fixed |
| 10 | Cross-tenant metadata readable from shared PostgreSQL catalogs (`pg_database`, `pg_roles`) | **LOW** | Documented — see Remaining risks |

---

## 1. Function sandbox escape — CRITICAL

**Component:** `packages/functions/src/runtime.ts` (`NodeWorkerRuntime`, used by
`FUNCTION_RUNTIME=worker`, the default and the only runtime available on
Railway, where no Docker engine exists).

**Issue.** Customer function source ran in a `vm` context whose globals were
**host objects** (`Date`, `JSON`, `Math`, `Promise`, `URL`, `setTimeout`, the
`console` closures, the `cloudnivo` SDK object and the request object). Node's
`vm` is not a security boundary: any host object carries the host realm's
`Function` constructor, so `Date.constructor('return process')()` returned the
worker's real `process`.

**Proof (non-destructive, values never printed).** A deployed-shaped function
returned only the *types* it could reach:

```
{ "functionCtor": "function", "process": "object",
  "require": "function", "hostEnvKeyCount": 138 }
```

138 environment variables — i.e. `DATABASE_URL`, `JWT_SECRET`, `VAULT_KEY`,
`MANAGED_PG_URL`, provider API keys — plus `require` (filesystem, network,
`child_process`).

**Impact.** Any customer able to deploy a function reads every platform secret
and thereby compromises the control plane and all tenants' data.

**Fix.** The context boundary now carries no host objects at all:

- Exactly one host function (a bridge) crosses into the context; an in-context
  bootstrap closes over it, builds `cloudnivo`, `console` and timers from the
  **context's own** intrinsics, then `delete`s the bridge and its data from the
  global object.
- Data crosses in both directions as JSON **text**, revived by the context's own
  `JSON`, so not even a plain worker-realm object reaches customer code.
- The request object handed to the handler is now constructed inside the
  context (it was a host object before).
- Defense in depth: the worker is started with `env: {}`, so the isolate no
  longer inherits the API process environment even if a future escape appears.
- Behaviour preserved: the function's own `env`, `console`, timers and the
  SDK capability calls (`database.query`, `storage.read`, `realtime.publish`,
  with `storage.write` still denied) all work exactly as before.

**Regression tests.** `packages/functions/src/sandbox-escape.test.ts` — 11 tests
probing escape through host intrinsics, the request object, `console`, the env
object, array literals and timers, plus bridge-global visibility and the
positive path. Verified failing (5/11) on the pre-fix code and passing after.

## 2. Cross-tenant database connection — HIGH

**Component:** `packages/provisioning/src/managed-provider.ts`.

**Issue.** Provisioning created a database per project and ran
`REVOKE ALL ON DATABASE "<control-db>" FROM "<project role>"`. PostgreSQL grants
`CONNECT` on every new database to **PUBLIC**, and a privilege held through
PUBLIC is not removed by revoking it from a role — so the revoke was a no-op and
every project role could open every other project's database, the `postgres`
maintenance database, and the CloudNivo **control-plane** database.

**Proof.** With the credentials CloudNivo legitimately reveals to a project
owner, that project's role connected to another tenant's database, to
`postgres`, and to `cloudnivo`, where it enumerated control-plane table names
(`users`, `agent_tokens`, `sso_connections`, …). Row reads were denied by table
ownership, and `CREATE` in another tenant's `public` schema was denied by
PostgreSQL 16 defaults — so this was a broken isolation boundary and schema
disclosure, not (today) cross-tenant data exfiltration. It also allowed
connection-slot exhaustion against other tenants and the control plane.

**Fix.** `lockDownDatabase()` revokes from PUBLIC and grants back only the owner
(plus the admin connection, so the control plane cannot lock itself out), run on
project creation and on branch creation; `lockDownControlDb()` does the same for
the control database. `hardenExistingDatabases()` repairs databases provisioned
before this change and runs once per boot — idempotent, non-blocking, logged as
`provision.harden`.

**Verified after the fix:** own database still reachable; other tenants'
databases, `postgres` and the control database all refused with
`FATAL: permission denied for database`, for both newly created and
pre-existing roles (`provision.harden checked=7 hardened=6`).

## 3. Rate-limit / brute-force bypass — HIGH

**Component:** every client-IP derivation in `apps/api/src` (14 call sites).

**Issue.** All of them read the **first** entry of the client-supplied
`X-Forwarded-For` header. Rotating that header gave each request its own
rate-limit bucket.

**Proof.** 12 failed logins with a fresh `X-Forwarded-For` each: `401 ×12`, no
`429`. The same 12 without the header: `429` from the tenth.

**Fix.** New `apps/api/src/client-ip.ts`. Only the last `TRUSTED_PROXY_HOPS`
entries (new config, default `1` — Railway/Vercel) are trusted; the client
address is the entry to their left. A chain shorter than the trusted hop count
means the header never passed through our proxies, so it is ignored and the
socket address is used (fail closed). `TRUSTED_PROXY_HOPS=0` ignores the header
entirely.

**Verified after the fix:** the same rotating-header spray now hits `429` at the
eleventh attempt. Regression tests: `apps/api/src/client-ip.test.ts` (7) plus a
live spray test in `apps/api/src/security.test.ts`.

## 4. Weak platform passwords accepted — HIGH

**Component:** `apps/api/src/platform-auth.ts` (`effectivePasswordPolicy`),
`packages/auth/src/password-policy.ts`.

**Issue.** A strong `DEFAULT_PASSWORD_POLICY` existed but was never applied to
platform accounts: signup (no user yet) and password change both fell back to
`LEGACY_PASSWORD_POLICY` — 8 characters, no class requirement, common-password
denylist **off**.

**Proof.** `password`, `12345678`, `aaaaaaaa` and `Password` all returned `201`.

**Fix.** New `PLATFORM_BASELINE_PASSWORD_POLICY` (12 characters, 3 of 4
character classes, common-password denylist on) is the floor for signup and
password change; organization policy may tighten it but never loosen it, and a
registry failure falls back to the baseline rather than below it. Existing
sessions and existing passwords are unaffected.

**Regression tests:** `packages/auth/src/password-baseline.test.ts` plus a live
signup test in `apps/api/src/security.test.ts`.

## 5. SSRF in log drains — MEDIUM

**Component:** `apps/api/src/platform-ops.ts` (`assertDrainUrl`, `deliverDrain`).

**Issue.** Drain URLs were validated by pattern-matching the hostname string.
A name that resolves to `169.254.169.254` (cloud metadata) or an internal
`10.0.0.0/8` address passed, as did bracketed IPv6 and decimal/hex literal
hosts. Automation webhooks already resolved before delivering; drains did not.

**Fix.** Shared guard in `apps/api/src/ssrf.ts` (`isPrivateResolvedIp`,
`resolvesToPublicAddress`), now used by both automation webhooks and drains:
resolve first, require **every** answer to be public, fail closed on DNS
failure. `assertDrainUrl` additionally rejects bracketed and non-dotted numeric
hosts. Redirects were already `manual` and remain so.

**Regression tests:** `apps/api/src/ssrf.test.ts` (17).

## 6. Unique-violation detection missed wrapped errors — MEDIUM

**Component:** 9 call sites across `apps/api/src` and `packages/*`.

**Issue.** Each tested `err.code === '23505'` on the top-level error. Drizzle
wraps driver errors, so the check never matched: duplicate signup returned
`500 Internal server error`, and the idempotency keys that dedupe **billing
payments**, **provisioning jobs** and **storage objects** stopped deduping.

**Fix.** `isUniqueViolation()` in `@cloudnivo/api-core` walks the `cause` chain
(depth-bounded, loop-safe); all 9 sites use it.

**Regression tests:** `packages/api-core/src/unique-violation.test.ts` plus a
live duplicate-signup test asserting `409`.

## 7. Placeholder secrets could boot production — MEDIUM

**Component:** `apps/api/src/prod-guards.ts`.

**Issue.** `.env.example` ships
`JWT_SECRET=change-me-to-a-long-random-string-min-32-chars` — 46 characters, so
the 32-character minimum accepted it. A copied example file in production makes
every session forgeable.

**Fix.** Production refuses to boot on a documentation-placeholder `JWT_SECRET`
or `VAULT_KEY`, and when `VAULT_KEY === JWT_SECRET` (one compromised secret must
not also decrypt stored credentials). A development origin left in
`CORS_ORIGINS` now warns loudly (`prod.dev_cors_origin`).

## 8. SQL editor errors surfaced as 500 — LOW

**Component:** `packages/database/src/project-db.ts`, `apps/api/src/projects.ts`.

**Issue.** Every Postgres error from a user's own statement was rewrapped in a
bare `Error`, losing the SQLSTATE, and returned as `500 Internal server error` —
so permission denials, missing relations and syntax errors were indistinguishable
from server faults, both for operators and for abuse detection.

**Fix.** `SqlExecutionError` carries the redacted message and the SQLSTATE;
`mapInfraError` returns `400 SQL_ERROR` for statement errors and keeps `503` for
connection-class states (`08xxx`, `57P03`). Verified live: `permission denied
for table pg_authid`, `relation "nope_missing" does not exist` and `must be
owner of database postgres` now return `400` with the database's own message
(the caller owns that database), while `select 1` still returns `200`.

## 9. CI/CD token scope — LOW

`.github/workflows/ci.yml` and `deploy.yml` had no `permissions:` block, so
`GITHUB_TOKEN` inherited the repository default. Both now declare
`permissions: contents: read`. CI already uses `pull_request` (not
`pull_request_target`), so fork PRs never see secrets; production deploys remain
manual-dispatch only, against a protected `production` environment.

## 10. Shared-catalog metadata disclosure — LOW (accepted, see Remaining risks)

From its own database, a tenant can read cluster-wide catalogs (`pg_database`,
`pg_roles`) and so learn other projects' database and role names, which encode
project slugs. No data, credentials or schema of another tenant is exposed
(verified). Revoking `PUBLIC` access to shared catalogs is cluster-wide and
breaks ordinary client tooling, so it is documented rather than silently
changed — see Recommended future hardening.

---

## Verified sound (tested, no change needed)

- **Tenant isolation across the API.** 26 cross-tenant requests spanning
  projects, databases, schema, revealed credentials, keys, jobs, storage,
  functions, realtime, logs, usage, vault, branches, environments, OpenAPI, SQL
  execution, lifecycle actions, project deletion, billing, SSO, policy, domains,
  drains, metrics and invites — all `401/403/404`.
- **Session and token handling.** `alg=none`, tampered signature and tampered
  payload all rejected; logout revokes (replay → `401`); MFA enrolment,
  challenge, wrong-code rejection and single-use tickets all behave (a login by
  an MFA-enabled user returns no session token, only a challenge).
- **Account enumeration.** Wrong password and unknown account return identical
  status and message.
- **Path traversal / file upload.** `../`, encoded `..%2F`, mixed and null-byte
  object keys all rejected.
- **Project API keys.** Cannot read `/me`, create projects, run SQL, read org
  billing, delete projects or reveal database credentials.
- **Agent tokens.** Every gate passes organization **and** project scope;
  destructive operations require an approval ticket (`428` + `X-Approval-Id`);
  denials are audited.
- **CSRF.** Authentication is Bearer-only — the session cookie is `HttpOnly`,
  `SameSite=Lax`, `Secure` in production and is never accepted as a credential,
  so there is no ambient authority to forge.
- **CORS.** Strict allowlist, no origin reflection, no credentials header.
- **Webhooks.** HMAC-SHA256 with constant-time comparison; missing secret is a
  hard failure.
- **Realtime.** Connection project binding is server-side; channel names are
  structurally bound to the credential's project.
- **AI plane.** Requests are member-gated per project; context is
  secret-redacted before it reaches a provider; applying a plan requires admin
  (humans) or scoped approval (agents) and only for `approved` plans.
- **Secrets in the repository.** No committed keys, tokens or credentials; logs
  hash recipient emails and never carry passwords, tokens or SQL text.
- **Error envelope.** 5xx bodies never echo internal messages.
- **Production infrastructure exposure.** The Railway production PostgreSQL and
  Redis services have no TCP proxy — neither is reachable from the public
  internet; only the API, worker and realtime services are.
- **Backups.** Scheduled backups refuse to run unencrypted in production.

## Dependency and supply-chain audit

`npm audit`: 10 advisories — all in development tooling (`vitest`, `vite`,
`esbuild`, `drizzle-kit`) or in the `postcss` copy bundled inside Next's build
pipeline. None is reachable from the deployed API or the dashboard at runtime.
Next.js resolves to 15.5.25, past CVE-2025-29927 (middleware bypass). No
production dependency requires an upgrade today.

## Remaining risks

1. **Shared PostgreSQL catalogs** (finding 10): tenants can enumerate other
   projects' database and role names. Bounded to names.
2. **`postgres` / `template1` maintenance databases** still accept connections
   from tenant roles (no tenant data lives there; the control database no longer
   does).
3. **`vm`-based function isolation** is now contained against realm escape, but
   it is still a single OS process shared with other tenants' invocations.
   `FUNCTION_RUNTIME=docker` (already implemented) is the stronger boundary
   wherever a Docker engine is available.
4. **Rate limiting is per-instance** unless `REDIS_URL` points at a shared Redis;
   `REQUIRE_REDIS=true` makes that mandatory at boot.
5. **Customer-plane password policy** (a project's own end users) still defaults
   to 8 characters with no class requirement. That is a tenant's policy choice,
   configurable per project, and was deliberately left alone.
6. **Signup discloses whether an email is registered** (`409`). Standard for
   developer platforms, and login is non-enumerating; changing it would break the
   signup flow. Accepted.

## Production security checklist

- [ ] `JWT_SECRET` random, ≥32 characters, not the documentation placeholder (now enforced at boot)
- [ ] `VAULT_KEY` set, ≥32 characters, different from `JWT_SECRET` (now enforced at boot)
- [ ] `PROVISION_DRIVER=managed` with `MANAGED_PG_URL`; never `fake` (enforced)
- [ ] `CONTROL_STORE=drizzle` with migrations applied
- [ ] `REDIS_URL` points at a shared Redis and `REQUIRE_REDIS=true`
- [ ] `TRUSTED_PROXY_HOPS` matches the real proxy depth (1 on Railway/Vercel)
- [ ] `CORS_ORIGINS` lists only production origins — no `localhost`, no `http://`
- [ ] `BACKUP_ENCRYPTION_KEY` set wherever scheduled backups run
- [ ] `BILLING_WEBHOOK_SECRET` set if any billing webhook is enabled
- [x] Database and Redis services are private (no public TCP proxy) — verified 2026-09-16
- [ ] `provision.harden` appears in API boot logs after deploying this change
- [ ] Production deploys remain manual-dispatch with required reviewers

## Recommended future hardening

1. Run functions on `FUNCTION_RUNTIME=docker` (or gVisor/Firecracker) where a
   container runtime exists — process-level isolation per invocation.
2. Consider `REVOKE ALL ON pg_database, pg_authid FROM PUBLIC` on the managed
   cluster, after testing client tooling against it (finding 10).
3. Pin GitHub Actions to commit SHAs instead of floating tags.
4. Add a dependency-review / `npm audit --omit=dev` gate to CI.
5. Move the managed-cluster admin role to a least-privilege role that can
   `CREATEDB`/`CREATEROLE` but is not a superuser.
6. Per-organization rate-limit buckets in addition to per-IP, to blunt
   distributed spraying.
7. Sign audit-log entries (or ship them to an append-only drain) so tampering is
   detectable, not just unlikely.

## How to re-run the security suite

```bash
npx vitest run apps/api/src/security.test.ts apps/api/src/client-ip.test.ts \
  apps/api/src/ssrf.test.ts packages/functions/src/sandbox-escape.test.ts \
  packages/api-core/src/unique-violation.test.ts \
  packages/auth/src/password-baseline.test.ts
```

Full suite after this audit: **541 passed, 14 skipped** (was 490 before; +51
security regression tests). Lint and typecheck clean.
