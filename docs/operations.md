# CloudNivo operations (Phase 10)

## Health checks

| Endpoint                   | Meaning                          | Failure mode            |
| -------------------------- | -------------------------------- | ----------------------- |
| `GET /api/v1/health`       | Liveness alias (back-compat)     | 200 when serving        |
| `GET /api/v1/health/live`  | Process liveness                 | 200 when serving        |
| `GET /api/v1/health/ready` | Readiness: control DB + registry | 200 ready, 503 degraded |

Readiness returns component booleans only — never URLs, credentials, or
stacks. Railway probes `/api/v1/health/ready` with `ON_FAILURE` restart
(max 3 retries); compose services carry `pg_isready`/`redis-cli ping`
healthchecks with `unless-stopped` restart.

## Failure behavior (verified)

| Failure                                                  | Behavior                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Control DB unreachable at boot (`CONTROL_STORE=drizzle`) | Fail fast with actionable error; memory stores untouched                   |
| Request with forged/expired credentials                  | 401, no leak, no crash                                                     |
| Abuse floods (auth, upgrades, plans, invokes)            | 429 with stable envelope                                                   |
| Runaway function                                         | Terminated at timeout → 504; metrics count it                              |
| Broken function source                                   | Deploy `failed`, never READY; invoke refuses                               |
| AI plan apply failing at migration                       | Automatic rollback of created tables (`rolled_back`)                       |
| AI plan failing later                                    | Stop, report failed step, never false success                              |
| Oversized bodies/payloads                                | 413 at the boundary                                                        |
| Restart                                                  | Healthy immediately; memory stores reset honestly (old IDs 404, never 500) |

## Background jobs

Provisioning and function deploys are idempotent by key (`findByKey` wins,
unique constraint backs the race); retries apply only to recoverable failures
within budget; terminal states (`completed`/`failed`) are never re-driven.

## Backups and recovery

Automated backup + verification (`packages/database/src/backup.ts`,
`db:backup` / `db:verify-backup`, exercised in CI against real Postgres):

```bash
npm run db:backup --workspace=packages/database \
  -- --url "$DATABASE_URL" --out ./backups
npm run db:verify-backup --workspace=packages/database \
  -- --dump ./backups/<file>.dump \
     --manifest ./backups/<file>.dump.manifest.json \
     --scratch "$SCRATCH_DATABASE_URL"
```

Backups are `pg_dump` custom-format plus a manifest (table inventory, row
counts, sha256 — never credentials or row contents). Verification restores
into an empty scratch database (refuses the source database outright) and
fails honestly on checksum drift, size drift, missing tables, or row-count
drift. Recovery paths:

- **Control database**: standard `pg_dump`/`pg_restore` against `DATABASE_URL`
  (migrations are replayable via `npm run db:migrate`; RBAC catalog via
  `npm run db:seed`). Schedule dumps before enabling `CONTROL_STORE=drizzle`
  in production.
- **Project databases**: Docker volumes (local) or provider snapshots
  (managed). Deletion removes containers AND volumes AND metadata — treat as
  irreversible.
- **Storage bytes**: local dir or S3 bucket policy (versioning recommended).
- **Config**: everything is env-driven; keep `.env` out of git (git-ignored).

## Observability

Structured JSON logs with `requestId` on every response (`X-Request-Id`
echo); audit events for auth, provisioning, storage, functions, invites, and
AI lifecycle; per-plane metrics endpoints (realtime stats, function metrics,
AI usage). Secrets are redacted at the logger, never in payloads or errors.
