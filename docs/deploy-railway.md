# Deploying CloudNivo (Railway / Docker / VPS)

The API engine is provider-independent: local Docker today, Railway/VPS
tomorrow, same routes and envelope. Nothing is coupled to Railway — it is one
target of the `DatabaseProvisioner` / Dockerfile abstraction.

## Option A — Railway (managed)

1. Create a Railway project with a PostgreSQL plugin (control plane).
2. Deploy the API from this repo:
   - Builder: `Dockerfile`, path `Dockerfile.api` (see `railway.json` —
     health check is `GET /api/v1/health`).
   - Set every variable from `.env.example` as Railway environment variables.
     Minimum: `DATABASE_URL` (plugin), `JWT_SECRET` (≥32 chars), `CORS_ORIGINS`,
     `PUBLIC_API_URL` (your Railway public domain, e.g.
     `https://api.<your-app>.up.railway.app`), `REDIS_URL` if you add Redis.
3. Deploy the dashboard to Vercel with `NEXT_PUBLIC_API_URL` pointing at the
   Railway API URL.
4. On Railway, project databases are provisioned per the active provider:
   - `PROVISION_DRIVER=docker` only works where a Docker engine is reachable
     (Railway services do not expose one by default).
   - For managed Postgres per project, implement `RailwayProvider` against the
     `DatabaseProvisioner` interface (same 8 methods) and select it via env —
     no route or dashboard changes needed.
5. Realtime scales independently: deploy the same image as a second Railway
   service with `REALTIME_STANDALONE=true`, `REALTIME_DRIVER=redis`,
   `REDIS_URL` (shared with the API service), `DATABASE_URL`, JWT/CORS
   settings, and the `REALTIME_*` budgets (`REALTIME_PORT`, heartbeat, per-
   project/per-socket caps). Both services share the registry/stores, so
   subscribers on either instance receive every event via Redis pub/sub
   (health check stays `GET /api/v1/health`).

## Option B — Docker Compose (local / VPS)

```bash
cp .env.example .env
docker compose up -d                # postgres + redis (control plane deps)
docker compose --profile api up -d --build   # + containerized API
```

The `api` service mounts the Docker socket so the containerized API can
provision project databases on the shared `cloudnivo` network
(`PROVISION_HOST_MODE=container`). Socket mounting is a deliberate local-dev
tradeoff — never do it on shared infrastructure without understanding the
implications (see `docs/security.md`).

## Option C — host-run API + Docker engine (recommended local flow)

```bash
docker compose up -d
npm run dev:api     # API on :3001, provisions via local Docker socket
npm run dev         # dashboard on :3000
```

`PROVISION_HOST_MODE=loopback` (default): project DBs are reached at
`127.0.0.1:<mapped-port>`.

## Environment checklist (production)

- `JWT_SECRET` ≥ 32 random chars, `CORS_ORIGINS` tight allowlist.
- `PUBLIC_API_URL` = the public API origin (drives OpenAPI servers + dashboard).
- `DATA_API_KEY_MAX` / `DATA_API_PROJECT_MAX` tuned per plan.
- `AUTH_*` TTLs at defaults unless you need shorter sessions; `EMAIL_DRIVER`
  stays `memory` until an SMTP/transactional driver is configured.
- Storage: local disks are ephemeral on Railway/Vercel — set
  `STORAGE_DRIVER=s3` with `STORAGE_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/
SECRET_ACCESS_KEY` (MinIO, R2, or AWS; keep path style on for MinIO).
  Tune `STORAGE_MAX_FILE_MB`, `STORAGE_PROJECT_QUOTA_MB`, `STORAGE_RATE_MAX`,
  and set a persistent `STORAGE_SIGNING_SECRET` so signed URLs survive restarts.
- `REDIS_PASSWORD` set; `DATABASE_URL` points at managed Postgres.
- Run `npm run db:migrate` (and `npm run db:seed` for the RBAC catalog) against
  the control database on every deploy, then set `CONTROL_STORE=drizzle` so the
  API serves registry/keys/jobs/storage metadata from Postgres instead of
  process memory (required for multi-replica and for data to survive restarts).
- Realtime: `REALTIME_DRIVER=redis` + shared `REDIS_URL` for multi-instance
  fan-out; standalone service sets `REALTIME_STANDALONE=true` and exposes
  `REALTIME_PORT`. Single-instance deploys can stay on `memory`.
- Functions: served in-process by default (`FUNCTION_RUNTIME=worker`). For
  container isolation set `FUNCTION_RUNTIME=docker` on a host with a Docker
  engine; for independent scaling run a worker service with `DATABASE_URL`,
  `REDIS_URL`, and the `FUNCTION_*` budgets (`FUNCTION_EXECUTION_TIMEOUT_MS`,
  `FUNCTION_MEMORY_MB`, `FUNCTION_MAX_CONCURRENCY`). Tune
  `FUNCTION_INVOKE_RATE_MAX` per plan.
- AI Builder: served in-process (local planner is CPU-trivial). Frontier
  models need `AI_PROVIDER=openai-compatible` + `AI_MODEL` + `AI_API_KEY` in
  Railway env (never committed). Provider calls are timeout-bounded
  (`AI_REQUEST_TIMEOUT_MS`) and rate-limited (`AI_RATE_MAX`); a dedicated AI
  worker can reuse the same builder later.
- Run `npm run db:migrate` against the control database on deploy.
- No `.env`, keys, or `*.pem` in images or git (`.dockerignore`-equivalent:
  the Dockerfile copies only `package*.json`, `packages/`, `apps/api/`).
