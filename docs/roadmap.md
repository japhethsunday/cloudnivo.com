# CloudNivo roadmap

## Phase 1 — Architecture & foundation (this branch, DONE)

Monorepo, Docker (Postgres 16 + Redis 7), control-plane schema, tenant/RBAC
helpers, service abstractions (db/storage/realtime/cache/provisioning),
versioned API envelope, dashboard shell, docs, green
`lint → typecheck → test → build`.

## Phase 2 — Database provisioning engine (DONE)

- `DatabaseProvisioner` interface + real `DockerDatabaseProvider` (execFile,
  labeled containers, localhost-only ports) + test-only fake.
- Job system (idempotency, retry budgets, logs) + orchestrator + audit sink.
- Control metadata tables (`project_databases`, `database_credentials`,
  `infrastructure_instances`, `provisioning_jobs`) + lifecycle machine.
- Live health/SQL/schema/metrics against project databases; masked + audited
  credential reveal; guarded SQL editor foundation.
- Project database console in the dashboard; 67 green tests (1 Docker test
  gated on `DOCKER_TESTS=1`); green `lint → typecheck → test → build`.

## Phase 3 — API engine (DONE)

- `@cloudnivo/api-engine`: introspection service (cached), pure query builder
  (allow-list identifiers, `$n` values only), executor-based CRUD engine,
  project keys (hash-only, roles, expiry, revocation, usage), live OpenAPI 3.0.
- Data routes `/:projectId/:table[/:rowId]` + keys + `openapi.json` with
  session-or-key auth, per-key/per-project rate limits, audit + metrics.
- Dashboard API console (base URL, keys, endpoints, curl examples, OpenAPI).
- Railway/Docker deploy (`Dockerfile.api`, `railway.json`, compose `api`
  profile, `docs/deploy-railway.md`); gated real-Postgres integration tests.

## Phase 4 — Authentication & authorization (DONE)

- `@cloudnivo/auth` customer plane: users/sessions/opaque tokens, scrypt,
  rotation + reuse detection, verify/reset flows, metadata guards, email
  abstraction, RLS policy generator, PG + memory stores.
- `/auth/*` routes per project, strict rate limits, project CORS, full audit
  events; engine integration (customer JWTs + owner scoping).
- Dashboard Auth section (users, sessions, CORS, email status).
- 100+ green tests (unit + HTTP E2E + isolation matrix); gated real-PG test.

## Phase 5 — Storage system (DONE)

- `StorageProvider` boundary: streaming local FS driver (real bytes) +
  SigV4 S3-compatible driver (verified signing, stubbed-transport tests).
- Buckets (validated, scoped, visibility/limits/allowlist/isolation settings),
  objects (sniffed MIME, sha256 etags, move/copy/upsert), signed URLs
  (HMAC capabilities + S3 presigned), quotas, policies, audit events.
- Storage API under `/api/v1/projects/:id/storage/*` + OpenAPI paths;
  Storage console in the dashboard (buckets, browser, upload, previews,
  usage, settings). 30+ new tests, all green.

## Phase 6 — Realtime infrastructure (DONE)

- `@cloudnivo/realtime`: RFC 6455 codec (no deps), project-bound channels
  (`project:<uuid>:<topic>`, `table:<name>`), pure server-side authz
  (`canSubscribe/Broadcast/Receive/TrackPresence/WatchTable` + safe equality
  filters), memory + Redis event bus (degrade-to-local, no echo), memory +
  Redis presence (TTL, no permanent rows), transport-agnostic gateway
  (limits, metrics, heartbeat + credential-expiry sweep), raw-socket server,
  `RealtimeService` facade, framework-independent client with reconnect.
- PostgreSQL CDC over LISTEN/NOTIFY (idempotent per-table triggers, multiplexed
  listener, bounded reconnects, no polling) + lazy trigger installs on first
  table subscribe; per-subscriber owner-scoped delivery at fan-out.
- WS upgrades in-process on the API port + standalone on `REALTIME_PORT`
  (same factory/auth); HTTP management (`/realtime`, `/stats`, `/channels`,
  `/presence`) + OpenAPI paths; dashboard Realtime console (overview,
  connections, channels, events, usage, settings, live smoke test).
- 30+ new tests (codec, authz matrix, filters, fan-out INSERT/UPDATE/DELETE,
  presence, heartbeats, expiry, rate/size limits, raw-socket E2E incl.
  expired-token + oversized-payload + upgrade-flood cases); green
  `lint → typecheck → test → build`.

## Phase 7 — Serverless functions (DONE)

- `@cloudnivo/functions`: records/versions/jobs/env model, frozen in-function
  SDK, worker-isolate + container runtimes (timeouts, memory/concurrency/size
  caps), async deploy pipeline with verified builds, invocation with caller
  identity, secret-masked env, redacted logs, honest metrics + cold starts.
- Function API (`/functions/*`: CRUD, deploy/redeploy jobs, invoke, logs,
  versions + rollback, env, metrics) with session/key/customer auth and
  project isolation; OpenAPI paths; dashboard Functions console (overview,
  editor, deployments, invoke tester, logs, env, versions, settings).
- 30+ new tests (validation, sandbox denials, timeouts, lifecycle, versions,
  isolation, rate limits, raw-HTTP E2E incl. rollback + delete); green
  `lint → typecheck → test → build`.

## Phase 8 — Durable control plane (DONE)

- Async `Registry` contract with `MemoryRegistry` (dev/test) + `DrizzleRegistry`
  (orgs, projects, memberships, databases, credentials, audit, CORS configs).
- Drizzle-backed keys/jobs/storage-metadata/platform-user/invite stores
  (`api_keys`, `provisioning_jobs`, `storage_*`, `users`, `organization_invites`
  - `0003`/`0004` migrations, idempotent RBAC seed, `CONTROL_STORE` selector
    with fail-fast boot). Customer auth already durable per project DB.
- Platform signup/login (`cn_session` cookie) + `GET /me`, org invites
  (opaque tokens, owner-gated, accept flow). Playwright smoke
  (`tests/e2e`: signup → org → project → key → CRUD → upload → 403 + dashboard).
- Gated live coverage: `LIVE_PG_URL` (CDC round-trip), `LIVE_REDIS_URL`
  (cross-instance bus + presence), `DOCKER_TESTS=1` (container runtime, CDC E2E).
- Real function SDK data-plane: guarded project-scoped SELECT, object reads,
  project-bound publishes (unit + HTTP E2E incl. denials).
- Green `lint → typecheck → test → build` (199+ unit/integration, gated skips).

## Phase 9 — AI Backend Builder (DONE)

- `@cloudnivo/ai`: strict plan schema, semantic validation, local deterministic
  planner + OpenAI-compatible provider abstraction, DDL migration builder with
  checksums + rollback inverses, live-state diff, approval lifecycle with
  destructive confirmations, permission-checked tools, code/SQL scanner, redacted
  audit log, honest usage tracking.
- AI API (`/ai/plan|plans|usage|history`, approve/reject/apply) wired to real
  services (migrations via guarded executor, buckets, scanned function deploys,
  CDC feeds); dashboard AI Builder (prompt → plan → preview → approve → result);
  `packages/cli` (`cloudnivo ai …`) + `packages/sdk` on the same backend.
- 40+ new tests (planner, validation, destructive gates, scanner, tools, audit
  honesty, CLI/SDK, full E2E incl. rollback + injection + rate limits); green
  `lint → typecheck → test → build`.

## Phase 10 — Security, Performance & Load Testing (DONE)

- Dependency audit: drizzle-orm HIGH fixed (0.45.2, suites green); postcss +
  vitest/esbuild findings triaged (build/dev-only, unreachable — documented).
- Secret scan clean; new `security.test.ts` regression suite (forged sessions,
  login brute-force 429, 13-path cross-project sweep, SQL stacking, traversal,
  hostile-function containment); reliability suite (fail-fast control plane,
  restart recovery); perf tripwires.
- Fixed real bugs: auth ESM cycle crashing standalone boots, N+1 registry
  reads (batched), Railway healthcheck now probes readiness.
- `tests/load` harness (12/12 scenarios green) + `docs/performance.md` +
  `docs/operations.md` (health, failure table, jobs, backup posture).

## Phase 11 — Production Infrastructure & Deployment (DONE)

- `ManagedPostgresProvider` (per-project database+role in shared PG; the
  Railway story where Docker is absent) with lockdown, lifecycle, and
  idempotent adopt; `PROVISION_DRIVER=managed` + `MANAGED_PG_URL` wiring.
- Background `worker` service (orphan-drain with stale threshold, graceful
  shutdown, own health endpoints); `listByStatus` on both job stores.
- Hardened Dockerfiles (non-root, healthchecks), compose worker/realtime
  services, per-service Railway settings, `vercel.json`, env-per-environment
  examples, GitHub CI (lint/typecheck/test/build/docker/smoke/secrets) +
  staging-auto / production-manual deploy pipeline.
- `MIGRATE_ON_BOOT` (opt-in, fail-fast), split health endpoints
  (`/health/live`, `/health/ready`), API graceful shutdown.
- `tests/smoke-prod.mjs`: 16/16-step production journey green against
  production builds; `docs/deployment.md` + operations/runbook updates.
- Phase 11 hardening: concurrent-storm race tests closed a real same-key
  duplication race (in-flight collapse in store + orchestrator) — 10/50/100
  project storms green; automated backup + verify tooling (`db:backup`,
  `db:verify-backup`, CI-verified) with tamper-evident manifests.

## Phase 12 — Billing + usage metering (DONE)

- `@cloudnivo/billing`: org-scoped plans (`free`/`pro`/`business`/`enterprise`),
  subscriptions, invoices, payments, and usage metering (counters + gauges,
  UTC `YYYY-MM` periods, quota checks with 50/75/90/100 warnings).
- Provider boundary (`manual` default — no charges; webhook interface for
  Stripe-compatible providers): HMAC-verified, idempotent webhooks; no payment
  credentials ever accepted, stored, logged, or returned (provider refs only).
- Billing API (org reads for any member; mutations owner/admin-gated) + usage
  recording at API-route choke points + OpenAPI paths; dashboard usage/billing
  views; `packages/cli` + `packages/sdk` on the same backend.
- Green `lint → typecheck → test → build` (unit + HTTP E2E incl. quota,
  webhook, and isolation cases; Drizzle live test gated).

## Phase 13 — Agent access tokens (DONE)

- `@cloudnivo/agents`: dedicated `cn_agent_…` credentials (sha256 hash-only,
  raw shown once, never logged/audited) with granular scopes
  (`projects.*`, `database.*`, `functions.*`, `storage.*`, `realtime.*`,
  `logs.read`, `environment.*`, `usage.read`/`billing.read`), per-token
  project allow-lists, expiry, instant revocation, and per-token rate limits
  (`AGENT_RATE_MAX`) on top of IP budgets.
- Approval gate for destructive operations: `428 APPROVAL_REQUIRED` with an
  approval id bound to exact method + path + body (24h TTL, single-use);
  approve/reject in dashboard inbox or API with `X-Approval-Id` replay.
- Enforcement in every plane (projects, data, storage, functions, realtime WS
  via `?token=`, AI builder, billing reads); agents can never manage API keys,
  reveal DB credentials, invite members, or touch customer-auth flows.
- Activity feed (lifecycle, denials with reasons, approvals, mutations — token
  ids only, never raw values) + Drizzle store (`0006` migration).
- Dashboard Agents console (tokens, scope picker with dangerous flags,
  approvals inbox, activity) + Account → Agent access; `cloudnivo agent …`
  CLI (0600 credentials file, env-var override) + SDK (`agentWhoami`,
  `createAgentToken`, approval-aware mutations). See `docs/agent-tokens.md`.
- 20+ new tests (service, HTTP E2E, rate-limit, realtime authz matrix, CLI/SDK,
  Playwright smoke); green `lint → typecheck → test → build` (342 passed).

## Phase 14 — Automation, observability, data portability (DONE)

- `@cloudnivo/automation`: per-project queues (leases, idempotent publish,
  retries, dead-letter set, purge), cron schedules invoking functions (UTC,
  precomputed next runs, worker firing, manual trigger), and outbound
  webhooks (hash-only `whsec_` secrets with rotation, SSRF-guarded URLs,
  HMAC-signed deliveries, backoff retries, history, replay, test sends).
- Event fan-out from real completions (provision/lifecycle jobs, deploys via
  completion hook, invocations, AI applies, project deletes); worker drains
  retries + due schedules. Memory default, `automation_*` tables (`0007`)
  under `CONTROL_STORE=drizzle`.
- Request metrics: process-local ring (service/route/status/latency) with
  tenant-scoped reads (`automation.read`), since-boot labeled; dashboard
  Metrics (totals, p50/p95, per-service, top routes, throughput bars).
- CSV portability on every table (`export` capped/streamed, `import`
  insert-only with per-row errors) reusing engine auth, filters, and owner
  scoping; per-table Export/Import in the database console.
- AI Debugger: deterministic `POST /ai/diagnose` over failed jobs, function
  error logs, and failed plans (cause, service, evidence, fix, honest
  confidence) + Builder panel section; `ai diagnose` in CLI/SDK.
- New `automation.read`/`automation.write` agent scopes; SDK + CLI coverage
  (`queues`, `schedules`, `webhooks`, `metrics` groups); dashboard
  Automations + Metrics project tabs, sidebar/palette wiring.
- 40+ new tests (cron/signing/service, HTTP E2E incl. isolation + signed
  delivery paths, CSV engine, diagnose rules, SDK/CLI, Playwright incl. UI
  pages); green `lint → typecheck → test → build`.
- See `docs/automation.md`.

## Non-goals for Phase 1

No real persistence in routes, no OAuth/RLS/rotation, no WS server, no cloud
provisioning, no billing. Interfaces reserve all of it.
