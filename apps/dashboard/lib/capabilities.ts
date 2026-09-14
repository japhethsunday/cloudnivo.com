'use client';

/**
 * Canonical CloudNivo capability catalog — exactly 100 product capabilities.
 * Each entry maps to a REAL backend route and a REAL frontend surface.
 * Project-scoped entries resolve to `/projects/:id<tab>` when a project is
 * in context, otherwise they fall back to `/projects`.
 */

export type CapabilityCategory =
  | 'Database'
  | 'API'
  | 'Auth'
  | 'Storage'
  | 'Realtime'
  | 'Functions'
  | 'AI'
  | 'Automation'
  | 'Observability'
  | 'Security'
  | 'Environments'
  | 'Billing'
  | 'Developer Tools';

export interface Capability {
  id: string;
  title: string;
  body: string;
  category: CapabilityCategory;
  /** Project tab suffix (e.g. "/database") for project-scoped caps. */
  tab?: string;
  /** Global route for org/global caps, or fallback when no project selected. */
  href: string;
  /** Backend route proving this is real (for docs / debugging). */
  api: string;
}

export const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  'Database',
  'API',
  'Auth',
  'Storage',
  'Realtime',
  'Functions',
  'AI',
  'Automation',
  'Observability',
  'Security',
  'Environments',
  'Billing',
  'Developer Tools',
];

export const CAPABILITIES: Capability[] = [
  // ── Database (8) ──────────────────────────────────────────────
  { id: 'db-isolated-postgres', title: 'Isolated PostgreSQL per project', body: 'Every project gets its own PostgreSQL database and role — Docker locally, managed template clones in production. Health and lifecycle stay visible in the console.', category: 'Database', tab: '/database', href: '/projects', api: 'GET /api/v1/projects/:id/database' },
  { id: 'db-provision-lifecycle', title: 'Async provisioning with jobs', body: 'Creates return 202 with a job id. Poll jobs for pending → ready, with idempotency collapse so double-clicks never double-provision.', category: 'Database', tab: '/logs', href: '/projects', api: 'GET /api/v1/projects/:id/jobs' },
  { id: 'db-schema-inspector', title: 'Live schema inspector', body: 'Tables, columns, primary keys, indexes and foreign keys read straight from information_schema — no cached guesses.', category: 'Database', tab: '/database', href: '/projects', api: 'GET /api/v1/projects/:id/database/schema' },
  { id: 'db-guarded-sql', title: 'Guarded SQL editor', body: 'Single-statement, read/write-guarded queries with row, time and size caps. Stacked statements are rejected before they reach Postgres.', category: 'Database', tab: '/sql', href: '/projects', api: 'POST /api/v1/projects/:id/database/query' },
  { id: 'db-connection-reveal', title: 'Masked connection, audited reveal', body: 'Connection strings render masked by default. Reveal is a deliberate, audit-logged action — agents can never reveal.', category: 'Database', tab: '/database', href: '/projects', api: 'GET /api/v1/projects/:id/database/connection?reveal=true' },
  { id: 'db-start-stop-restart', title: 'Start, stop and restart', body: 'Lifecycle actions for the project database with live status transitions in the header and overview.', category: 'Database', tab: '/database', href: '/projects', api: 'POST /api/v1/projects/:id/database/actions' },
  { id: 'db-csv-portability', title: 'CSV export and import per table', body: 'Stream any table to CSV and import insert-only with per-row error reporting — portability without leaving the console.', category: 'Database', tab: '/database', href: '/projects', api: 'GET|POST /api/v1/projects/:id/:table/export|import' },
  { id: 'db-size-metrics', title: 'Database size and connection metrics', body: 'pg_stat-backed size and connection counts refresh on demand and feed the same meters as billing.', category: 'Database', tab: '/database', href: '/projects', api: 'GET /api/v1/projects/:id/database/metrics' },

  // ── API (7) ───────────────────────────────────────────────────
  { id: 'api-auto-rest', title: 'Auto-generated REST per table', body: 'GET, POST, PATCH and DELETE over /:projectId/:table[/:rowId] — your schema becomes an API instantly.', category: 'API', tab: '/api', href: '/projects', api: 'ANY /api/v1/projects/:id/:table' },
  { id: 'api-filter-sort-page', title: 'Filtering, sorting, pagination', body: 'Allow-listed identifiers with $n-bound values only. Filter, order and page with the same envelope everywhere.', category: 'API', tab: '/api', href: '/projects', api: 'GET /api/v1/projects/:id/:table?limit=&order=' },
  { id: 'api-project-keys', title: 'Scoped project API keys', body: 'service, admin and readonly keys per project. Hash-stored, revocable, with expiry — raw shown once.', category: 'API', tab: '/api', href: '/projects', api: 'POST /api/v1/projects/:id/keys' },
  { id: 'api-key-budgets', title: 'Per-key budgets and audit', body: 'Per-key and per-project rate budgets with usage auditing, so a leaky key cannot take down the project.', category: 'API', tab: '/api', href: '/projects', api: 'GET /api/v1/projects/:id/keys' },
  { id: 'api-openapi', title: 'Live OpenAPI per project', body: 'openapi.json aggregates data, storage, realtime, functions, AI and billing paths — always in sync with the router.', category: 'API', tab: '/api', href: '/projects', api: 'GET /api/v1/projects/:id/openapi.json' },
  { id: 'api-cors', title: 'Per-project CORS allowlist', body: 'Project allowedOrigins override the global list. The Security Center flags wildcard origins.', category: 'API', tab: '/auth', href: '/projects', api: 'GET /api/v1/projects/:id/auth/config' },
  { id: 'api-envelope-limits', title: 'Standard envelope and rate limits', body: '{ data, meta, requestId } on success, { error } on failure — with per-IP and per-plane rate limiting and X-Request-Id tracing.', category: 'API', tab: '/metrics', href: '/projects', api: 'GET /api/v1/health/ready' },

  // ── Auth (11) ─────────────────────────────────────────────────
  { id: 'auth-app-users', title: 'Application users per project', body: 'Sign up and manage end-users scoped to one project — passwords never displayed, admins list and remove.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/signup' },
  { id: 'auth-rotating-sessions', title: 'Rotating sessions with reuse detection', body: 'Opaque session tokens rotate on refresh. Reuse is detected and the session family is invalidated.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/refresh' },
  { id: 'auth-email-verify', title: 'Email verification flow', body: 'Verify links gate emailVerified. Unverified cohorts surface as low-severity findings in Security.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/verify' },
  { id: 'auth-password-reset', title: 'Password reset flow', body: 'Request and consume reset tokens with strict rate limits and full audit events.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/reset-*' },
  { id: 'auth-magic-link', title: 'Passwordless magic links', body: 'Request a link, consume it to sign in — no password stored for magic-link users.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/magic-*' },
  { id: 'auth-email-otp', title: 'Email OTP login', body: 'One-time codes over the configured email driver, with a memory outbox for local development.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/otp-*' },
  { id: 'auth-phone-sms', title: 'Phone and SMS login', body: 'Attach and verify phone numbers, then sign in by SMS — HTTP SMS driver in production, memory outbox locally.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/phone-*' },
  { id: 'auth-anon-convert', title: 'Anonymous users that convert', body: 'Start anonymous, upgrade with email and password later — carts and trials survive signup.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/anonymous' },
  { id: 'auth-customer-totp', title: 'Customer TOTP two-factor', body: 'Enroll, confirm and verify per-user TOTP with backup codes for your end-users.', category: 'Auth', tab: '/auth', href: '/projects', api: 'POST /api/v1/projects/:id/auth/mfa-*' },
  { id: 'auth-admin-users', title: 'Admin user directory', body: 'List users, update metadata, revoke sessions and delete accounts — owner-scoped per project.', category: 'Auth', tab: '/auth', href: '/projects', api: 'GET /api/v1/projects/:id/auth/admin/users' },
  { id: 'auth-config-email', title: 'Auth config, email and captcha', body: 'CORS origins, email driver status, password policy and captcha gates (Turnstile/hCaptcha when keyed).', category: 'Auth', tab: '/auth', href: '/projects', api: 'GET /api/v1/projects/:id/auth/email/status' },

  // ── Storage (7) ───────────────────────────────────────────────
  { id: 'storage-buckets', title: 'Buckets with visibility controls', body: 'Public or private buckets with file-size limits, MIME allowlists and owner isolation per bucket.', category: 'Storage', tab: '/storage', href: '/projects', api: 'POST /api/v1/projects/:id/storage/buckets' },
  { id: 'storage-streaming-objects', title: 'Streaming object uploads', body: 'Real bytes through local or S3-compatible drivers, with byte caps (413) and traversal rejection.', category: 'Storage', tab: '/storage', href: '/projects', api: 'PUT /api/v1/projects/:id/storage/buckets/:b/objects/*' },
  { id: 'storage-move-copy', title: 'List, move and copy objects', body: 'Prefix listing, server-side move and copy, and per-object metadata — all tenant-scoped.', category: 'Storage', tab: '/storage', href: '/projects', api: 'POST /api/v1/projects/:id/storage/buckets/:b/move' },
  { id: 'storage-signed-urls', title: 'Signed download and upload URLs', body: 'HMAC capability tokens mint time-boxed URLs for direct GETs and PUTs without proxying bytes.', category: 'Storage', tab: '/storage', href: '/projects', api: 'POST /api/v1/projects/:id/storage/buckets/:b/sign' },
  { id: 'storage-multipart', title: 'Resumable multipart uploads', body: 'Numbered parts upload out of order with idempotent retry, gap-safe completion and abort.', category: 'Storage', tab: '/storage', href: '/projects', api: 'POST /api/v1/projects/:id/storage/buckets/:b/uploads' },
  { id: 'storage-quotas', title: 'Quotas with billing-matched usage', body: 'Per-bucket quotas enforced on write; usage endpoint matches the billing meters exactly.', category: 'Storage', tab: '/storage', href: '/projects', api: 'GET /api/v1/projects/:id/storage/usage' },
  { id: 'storage-isolation', title: 'Owner isolation and customer scoping', body: 'Owner-isolated buckets plus customer-scoped prefixes — users only ever see their own objects.', category: 'Storage', tab: '/storage', href: '/projects', api: 'GET /api/v1/projects/:id/storage/buckets/:b/objects' },

  // ── Realtime (6) ──────────────────────────────────────────────
  { id: 'rt-channels', title: 'Project-scoped WebSocket channels', body: 'project:<id>:<topic> and table:<name> channels over one authenticated socket per project.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'GET /api/v1/projects/:id/realtime/ws?token=' },
  { id: 'rt-presence', title: 'Presence tracking', body: 'Who is online in which channel, with TTL heartbeats and per-channel state for up to 50 channels.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'GET /api/v1/projects/:id/realtime/presence' },
  { id: 'rt-broadcast-table', title: 'Broadcast and table feeds', body: 'Publish to any channel and subscribe to Postgres tables with safe equality filters.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'GET /api/v1/projects/:id/realtime/channels' },
  { id: 'rt-cdc', title: 'Postgres CDC change feeds', body: 'Idempotent per-table triggers fan INSERT, UPDATE and DELETE out over LISTEN/NOTIFY — lazy-installed on first subscribe.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'POST /api/v1/projects/:id/realtime/cdc' },
  { id: 'rt-stats', title: 'Connection stats and health', body: 'Channel counts, delivery totals and degraded flags when the Redis bus falls back to memory.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'GET /api/v1/projects/:id/realtime/stats' },
  { id: 'rt-client-limits', title: 'Reconnecting client with limits', body: 'Framework-independent client with reconnect, heartbeats, payload caps and per-channel authz.', category: 'Realtime', tab: '/realtime', href: '/projects', api: 'WS /api/v1/projects/:id/realtime/ws' },

  // ── Functions (7) ─────────────────────────────────────────────
  { id: 'fn-create', title: 'Versioned serverless functions', body: 'Slug-validated functions with frozen in-function SDK, secret-masked env and honest cold-start metrics.', category: 'Functions', tab: '/functions', href: '/projects', api: 'POST /api/v1/projects/:id/functions' },
  { id: 'fn-deploy-jobs', title: 'Async deploys with status', body: 'Deploy from source or CLI into a verified build pipeline; poll deployments for build and ready state.', category: 'Functions', tab: '/functions', href: '/projects', api: 'POST /api/v1/projects/:id/functions/:slug/deploy' },
  { id: 'fn-invoke', title: 'Invoke tester with identity', body: 'Invoke as session, customer or service/admin key. Public invoke without credentials is blocked.', category: 'Functions', tab: '/functions', href: '/projects', api: 'POST /api/v1/projects/:id/functions/:slug/invoke' },
  { id: 'fn-rollback', title: 'Versions and instant rollback', body: 'Every deploy is a version. Activate any prior version to roll back in one click.', category: 'Functions', tab: '/functions', href: '/projects', api: 'POST /api/v1/projects/:id/functions/:slug/versions/:n/activate' },
  { id: 'fn-env', title: 'Per-function environment variables', body: 'Get and set env per function with redaction in logs and audit on change.', category: 'Functions', tab: '/functions', href: '/projects', api: 'GET|PUT /api/v1/projects/:id/functions/:slug/env' },
  { id: 'fn-logs', title: 'Per-execution logs', body: 'Redacted stdout, errors and timing per invocation — the same stream the AI Debugger reads.', category: 'Functions', tab: '/functions', href: '/projects', api: 'GET /api/v1/projects/:id/functions/:slug/logs' },
  { id: 'fn-sandbox', title: 'Sandboxed runtime with caps', body: 'Timeouts, memory and concurrency caps plus egress blocklists (authorization, apikey, cookie, host).', category: 'Functions', tab: '/functions', href: '/projects', api: 'POST /api/v1/projects/:id/functions/:slug/invoke' },

  // ── AI (7) ────────────────────────────────────────────────────
  { id: 'ai-plan', title: 'Natural-language backend plans', body: 'Describe the backend; the deterministic planner plus provider models draft validated structured plans.', category: 'AI', tab: '/ai', href: '/projects', api: 'POST /api/v1/projects/:id/ai/plan' },
  { id: 'ai-preview', title: 'Plan preview with migration SQL', body: 'Every plan shows diffs, checksums and rollback inverses before anything executes.', category: 'AI', tab: '/ai', href: '/projects', api: 'GET /api/v1/projects/:id/ai/plans/:planId' },
  { id: 'ai-approvals', title: 'Approval gates for destructive plans', body: 'Drops and overwrites require explicit confirmation — admin-only approve and reject.', category: 'AI', tab: '/ai', href: '/projects', api: 'POST /api/v1/projects/:id/ai/plans/:planId/approve' },
  { id: 'ai-apply', title: 'Apply with bounded rollback', body: 'Approved plans apply through guarded executors; failures roll back and land in history.', category: 'AI', tab: '/ai', href: '/projects', api: 'POST /api/v1/projects/:id/ai/plans/:planId/apply' },
  { id: 'ai-history-usage', title: 'Plan history and token usage', body: 'Last actions plus honest request, applied and failed counters per project and period.', category: 'AI', tab: '/ai', href: '/projects', api: 'GET /api/v1/projects/:id/ai/history|usage' },
  { id: 'ai-diagnose', title: 'Deterministic failure debugger', body: 'Failed jobs, function errors and failed plans resolve to cause, evidence, fix and confidence.', category: 'AI', tab: '/ai', href: '/projects', api: 'POST /api/v1/projects/:id/ai/diagnose' },
  { id: 'ai-context', title: 'Context-aware generation', body: 'Plans see live tables, buckets, functions, channels and recent changes — never stale snapshots.', category: 'AI', tab: '/ai', href: '/projects', api: 'POST /api/v1/projects/:id/ai/plan' },

  // ── Automation (8) ────────────────────────────────────────────
  { id: 'auto-queues', title: 'Durable queues with depth', body: 'Per-project queues with queued, leased and dead depth visible before you publish a single message.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/queues' },
  { id: 'auto-publish-consume', title: 'Idempotent publish and leased consume', body: 'Idempotency keys dedupe publishes; consume leases with ack, nack-requeue and max-delivery DLQ.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/queues/:q/messages' },
  { id: 'auto-purge-dlq', title: 'Purge and dead-letter handling', body: 'Purge acked or dead sets on demand; poison messages park in the dead set instead of looping.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/queues/:q/purge' },
  { id: 'auto-cron', title: 'Cron schedules invoking functions', body: 'UTC crons with precomputed next runs; the worker fires due schedules as system invocations.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/schedules' },
  { id: 'auto-schedule-controls', title: 'Pause, resume and trigger now', body: 'Pause without deleting, resume on command, or fire a schedule immediately to test the function.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/schedules/:s/trigger' },
  { id: 'auto-webhooks', title: 'HMAC-signed outbound webhooks', body: 'SSRF-guarded URLs with sha256 signatures over exact bytes, 10s timeouts and no redirects.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/webhooks' },
  { id: 'auto-deliveries', title: 'Delivery history, replay and test', body: 'Every attempt is recorded with backoff retries; replay or test-send any webhook on demand.', category: 'Automation', tab: '/automations', href: '/projects', api: 'GET /api/v1/projects/:id/webhooks/:w/deliveries' },
  { id: 'auto-secret-rotate', title: 'Webhook secret rotation', body: 'whsec_ secrets are hash-only and shown once; rotate without changing the URL or event set.', category: 'Automation', tab: '/automations', href: '/projects', api: 'POST /api/v1/projects/:id/webhooks/:w/rotate' },

  // ── Observability (7) ─────────────────────────────────────────
  { id: 'obs-request-metrics', title: 'Request metrics with p50 and p95', body: 'Service, route, status and latency rings with tenant-scoped reads and since-boot labels.', category: 'Observability', tab: '/metrics', href: '/projects', api: 'GET /api/v1/organizations/:org/metrics' },
  { id: 'obs-prometheus', title: 'Prometheus exposition', body: 'requests_total, errors_total and latency p50/p95 gauges scrape-ready for your existing stack.', category: 'Observability', tab: '/metrics', href: '/projects', api: 'GET /api/v1/metrics/prometheus' },
  { id: 'obs-logs', title: 'Unified project logs', body: 'Provisioning, deploys, invocations and automation completions in one chronological feed per project.', category: 'Observability', tab: '/logs', href: '/projects', api: 'GET /api/v1/projects/:id/jobs' },
  { id: 'obs-jobs', title: 'Provisioning job tracking', body: 'Every async job with kind, status, attempts and last error — the source of truth for activity.', category: 'Observability', tab: '/logs', href: '/projects', api: 'GET /api/v1/projects/:id/jobs/:jobId' },
  { id: 'obs-activity', title: 'Workspace activity feed', body: 'Cross-project lifecycle, denials, approvals and mutations — token ids only, never raw values.', category: 'Observability', href: '/activity', api: 'GET /api/v1/organizations/:org/agent-activity' },
  { id: 'obs-service-insights', title: 'Per-service throughput insights', body: 'Totals, per-service breakdowns, top routes and throughput bars rendered live in Metrics.', category: 'Observability', tab: '/metrics', href: '/projects', api: 'GET /api/v1/organizations/:org/metrics?window=24h' },
  { id: 'obs-status', title: 'Public status and incidents', body: 'Operator-published status with open, monitoring and resolved incidents by severity.', category: 'Observability', href: '/dashboard', api: 'GET /api/v1/status' },

  // ── Security (8) ──────────────────────────────────────────────
  { id: 'sec-posture-scan', title: 'Live posture scan with score', body: 'Starts at 100 per scan; high −10, medium −4, low −1. Public buckets, open CORS and quota breaches all count.', category: 'Security', href: '/security', api: 'GET /api/v1/projects (scan input)' },
  { id: 'sec-platform-mfa', title: 'Platform TOTP two-factor', body: 'Enroll, confirm and disable TOTP with backup codes; step-up challenge at login.', category: 'Security', href: '/account', api: 'POST /api/v1/me/mfa/enroll|confirm|disable' },
  { id: 'sec-sso-oidc', title: 'Organization SSO with OIDC', body: 'Per-org connections with PKCE start, id-token callback and encrypted client secrets.', category: 'Security', href: '/security', api: 'POST /api/v1/auth/sso/:id/start' },
  { id: 'sec-org-policy', title: 'Organization security policies', body: 'Email domains, requireMfa, password floor and log retention enforced at signup and login.', category: 'Security', href: '/organizations', api: 'GET|PUT /api/v1/organizations/:org/policy' },
  { id: 'sec-session-inventory', title: 'Session inventory and revoke-all', body: 'List active platform sessions, revoke one or revoke all into the shared denylist.', category: 'Security', href: '/account', api: 'GET|DELETE /api/v1/me/sessions' },
  { id: 'sec-credential-hygiene', title: 'Hash-only credentials', body: 'API keys, webhook secrets and agent tokens store hashes only; raw values show exactly once.', category: 'Security', href: '/security', api: 'POST /api/v1/organizations/:org/agent-tokens' },
  { id: 'sec-approval-gates', title: 'Approval gates for destructive ops', body: 'Deletes and deploys pause with 428 APPROVAL_REQUIRED until a human approves the exact method, path and body.', category: 'Security', href: '/agents', api: 'POST /api/v1/organizations/:org/approvals/:id/approve' },
  { id: 'sec-ip-allowlist', title: 'Agent IP allowlists', body: 'Per-token CIDR allowlists enforced on every call across every plane.', category: 'Security', href: '/agents', api: 'POST /api/v1/organizations/:org/agent-tokens' },

  // ── Environments (7) ──────────────────────────────────────────
  { id: 'env-branches', title: 'Full-database branches', body: 'Clone the whole database into an isolated branch with durable records, masked connections and reset.', category: 'Environments', tab: '/settings', href: '/projects', api: 'POST /api/v1/projects/:id/database/branches' },
  { id: 'env-preview', title: 'Preview environments with auto-branch', body: 'preview:true environments auto-branch preview-<slug>; the header switcher keeps production styling distinct.', category: 'Environments', tab: '/settings', href: '/projects', api: 'POST /api/v1/projects/:id/database/environments' },
  { id: 'env-vault', title: 'Project vault for secrets', body: 'AES-256-GCM envelopes under VAULT_KEY. Metadata lists freely; values reveal-once and audit.', category: 'Environments', tab: '/settings', href: '/projects', api: 'PUT /api/v1/projects/:id/database/vault/:name' },
  { id: 'env-db-tools', title: 'Database power tools', body: 'Extensions allowlist, advisors, replication status, routines, TypeScript types, diff, restore, import and RLS simulation.', category: 'Environments', tab: '/settings', href: '/projects', api: 'GET /api/v1/projects/:id/database/advisors|extensions|types' },
  { id: 'env-diff-restore', title: 'Schema diff and guarded restore', body: 'Preview base-vs-compare migrations with drops flagged; restores run transactionally with CREATE ROLE blocked.', category: 'Environments', tab: '/settings', href: '/projects', api: 'POST /api/v1/projects/:id/database/diff|restore' },
  { id: 'env-domains', title: 'DNS-verified custom domains', body: 'Attach api, storage, functions or app domains and verify ownership over DNS TXT.', category: 'Environments', href: '/organizations', api: 'POST /api/v1/organizations/:org/domains' },
  { id: 'env-drains', title: 'Signed log drains', body: 'Ship audit, billing, auth and error events to SSRF-guarded HTTPS endpoints with HMAC signatures.', category: 'Environments', href: '/organizations', api: 'POST /api/v1/organizations/:org/drains' },

  // ── Billing (7) ───────────────────────────────────────────────
  { id: 'bill-plans', title: 'Plans with real quotas', body: 'free, pro, business and enterprise with metered limits — the same numbers the Security scan reads.', category: 'Billing', href: '/billing', api: 'GET /api/v1/organizations/:org/billing/plans' },
  { id: 'bill-subscription', title: 'Subscription change and cancel', body: 'Owner and admin-gated plan moves with status tracking; cancel falls back to free limits.', category: 'Billing', href: '/billing', api: 'POST /api/v1/organizations/:org/billing/subscription' },
  { id: 'bill-usage', title: 'Metered usage by period', body: 'Counters and gauges per UTC YYYY-MM period with per-project breakdowns in the console.', category: 'Billing', href: '/billing', api: 'GET /api/v1/organizations/:org/billing/usage' },
  { id: 'bill-quotas', title: 'Quota checks with warnings', body: '50, 75, 90 and 100 percent warnings computed live against plan limits in billing and security.', category: 'Billing', href: '/billing', api: 'GET /api/v1/organizations/:org/billing/plan' },
  { id: 'bill-invoices', title: 'Invoices and payments', body: 'Generated invoices with statuses and recorded payments — provider refs only, never card data.', category: 'Billing', href: '/billing', api: 'GET /api/v1/organizations/:org/billing/invoices|payments' },
  { id: 'bill-budgets', title: 'Spend budgets with block mode', body: 'Monthly caps that alert or block; breached block budgets return 402 on project create, AI apply, deploys and branches.', category: 'Billing', href: '/billing', api: 'POST /api/v1/organizations/:org/billing/budgets' },
  { id: 'bill-webhooks', title: 'HMAC-verified billing webhooks', body: 'Stripe-compatible provider webhooks with idempotent (provider, eventId) handling.', category: 'Billing', href: '/billing', api: 'POST /api/v1/billing/webhooks/:provider' },

  // ── Developer Tools (10) ──────────────────────────────────────
  { id: 'dev-cli', title: 'cloudnivo CLI', body: 'agent, ai, queues, schedules, webhooks and metrics groups on the same backend as the dashboard.', category: 'Developer Tools', href: '/developer', api: 'CLI packages/cli' },
  { id: 'dev-sdk', title: 'Typed TypeScript SDK', body: 'CloudNivoClient with agent, AI, automation, metrics and CSV helpers over the versioned envelope.', category: 'Developer Tools', href: '/developer', api: 'SDK packages/sdk' },
  { id: 'dev-agent-tokens', title: 'Scoped agent tokens', body: 'cn_agent_ credentials with granular scopes, project allow-lists, expiry and instant revocation.', category: 'Developer Tools', href: '/agents', api: 'POST /api/v1/organizations/:org/agent-tokens' },
  { id: 'dev-approval-inbox', title: 'Agent approval inbox', body: 'Pending destructive operations approve or reject here or over the API with X-Approval-Id replay.', category: 'Developer Tools', href: '/agents', api: 'GET /api/v1/organizations/:org/approvals' },
  { id: 'dev-agent-activity', title: 'Agent activity ledger', body: 'Lifecycle, denials with reasons, approvals and mutations per token for audit and debugging.', category: 'Developer Tools', href: '/agents', api: 'GET /api/v1/organizations/:org/agent-activity' },
  { id: 'dev-command-palette', title: 'Command palette and search', body: 'Ctrl/⌘K across projects, organizations, sections and actions — capabilities included.', category: 'Developer Tools', href: '/dashboard', api: 'UI ⌘K' },
  { id: 'dev-orgs-invites', title: 'Organizations and invites', body: 'Create orgs, invite by email with one-time tokens, and gate everything on owner, admin, member and viewer roles.', category: 'Developer Tools', href: '/organizations', api: 'POST /api/v1/organizations/:org/invites' },
  { id: 'dev-projects', title: 'Projects with regions', body: 'Slug and region-scoped projects with settings, transfer by org and approval-gated deletes.', category: 'Developer Tools', href: '/projects', api: 'POST /api/v1/projects' },
  { id: 'dev-per-project-usage', title: 'Per-project usage views', body: 'The same billing meters sliced by project so owners see which backend spends the budget.', category: 'Developer Tools', tab: '/usage', href: '/projects', api: 'GET /api/v1/organizations/:org/billing/usage' },
  { id: 'dev-capability-catalog', title: 'Capability catalog (this index)', body: 'All 100 capabilities in one searchable index — every entry links to the console where it runs.', category: 'Developer Tools', href: '/capabilities', api: 'UI /capabilities' },
];

export function capabilitiesByCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITIES.filter(c => c.category === category);
}

export function resolveCapabilityHref(cap: Capability, projectId: string | null): string {
  if (cap.tab && projectId) return `/projects/${projectId}${cap.tab}`;
  return cap.href;
}
