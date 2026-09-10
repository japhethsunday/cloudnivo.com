# CloudNivo deployment

Production topology: Vercel (dashboard) → Railway (API, worker, realtime,
Postgres, Redis). GitHub holds source + CI/CD. The app never imports a
provider SDK — Railway is a target, not an architecture (see
`docs/architecture.md` for the portability boundary).

## Services

| Service            | Image / target         | Start                                       | Health                            |
| ------------------ | ---------------------- | ------------------------------------------- | --------------------------------- |
| cloudnivo-api      | `Dockerfile.api`       | `node apps/api/dist/index.js`               | `GET /api/v1/health/ready`        |
| cloudnivo-worker   | `Dockerfile.worker`    | `node apps/api/dist/worker.js`              | `GET /api/v1/health/live` (:3003) |
| cloudnivo-realtime | `Dockerfile.realtime`  | `node apps/api/dist/realtime-standalone.js` | `GET /api/v1/health` (:3002)      |
| Postgres 16        | Railway plugin         | —                                           | `pg_isready`                      |
| Redis 7            | Railway plugin         | —                                           | `redis-cli ping`                  |
| dashboard          | Vercel (`vercel.json`) | `next start` (built)                        | `/` 200                           |

Railway: one service per row from this repo (override the Dockerfile path per
service). Attach Postgres + Redis plugins once; reference
`DATABASE_URL`/`REDIS_URL` from every service. All images run non-root with
`HEALTHCHECK`s and `ON_FAILURE` restarts.

## Environment

- Start from `.env.example`; per-environment deltas in `.env.local.example`,
  `.env.staging.example`, `.env.production.example`.
- Only `NEXT_PUBLIC_API_URL` is browser-safe. Everything else stays in
  Railway/Vercel environment config — never git, logs, or responses.
- `CORS_ORIGINS` must list the exact dashboard origin (no wildcards).
- Tokens (`RAILWAY_TOKEN`, `VERCEL_TOKEN`) live in GitHub secrets only.
  There is no token in this repo; automation degrades to clear errors
  without them.

## Database, migrations, backups

- Deploy order: `db:migrate` → `db:seed` → services (CI `deploy.yml` enforces
  it; `MIGRATE_ON_BOOT=true` is the container fallback). The journal applies
  in order; boot halts on failure instead of serving a stale schema.
- `PROVISION_DRIVER=managed` on Railway (`MANAGED_PG_URL` = plugin URL):
  one database + locked-down role per project, `REVOKE ALL` on the control
  database per role. `docker` stays the local story.
- Backups: `pg_dump $DATABASE_URL` on a schedule (plus Railway backups if
  enabled); restore, then re-run `db:migrate` to confirm journal state.
  Project DBs: same dump per database (managed) or volume snapshots (docker).
  Storage: S3 versioning in prod — never container filesystems.
- Recovery order: Postgres → Redis → API (migrate first) → worker →
  realtime → dashboard, verifying `/health/ready` at each step.

## CI/CD and staging

- `ci.yml`: install → lint → typecheck → unit/integration → build →
  secret scan → Docker builds + compose boot probe → Playwright E2E against
  a live local stack.
- `deploy.yml`: staging auto-deploys on `main` (migrate → seed → services →
  readiness gate); production is manual-dispatch only behind the
  `production` environment (required reviewers). Destructive changes never
  auto-deploy.
- Staging mirrors production (managed PG, drizzle stores, worker, standalone
  realtime). Validate migrations, auth, provisioning, storage, realtime,
  functions, and dashboard wiring there first.

## Troubleshooting

- `Control database unreachable` at boot: wrong `DATABASE_URL` or PG down.
- `MANAGED_PG_URL is required`: set when `PROVISION_DRIVER=managed`.
- 503 `/health/ready`: control store/registry down — check logs via
  `X-Request-Id`; `/health/live` distinguishes dead from degraded.
- Dashboard `API unreachable`: `NEXT_PUBLIC_API_URL` mismatch or CORS —
  `CORS_ORIGINS` must exactly match the dashboard origin.
- Worker idle with memory store: expected — set `CONTROL_STORE=drizzle`.
- `EADDRINUSE` locally: a previous `dev`/dist server is still running.
