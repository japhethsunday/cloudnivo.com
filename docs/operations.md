# CloudNivo operations

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

## Production boot guards

`NODE_ENV=production` refuses to serve on dangerous configuration
(`apps/api/src/prod-guards.ts`, applied to API and worker):

| Condition                                            | Behavior                                   |
| ---------------------------------------------------- | ------------------------------------------ |
| `PROVISION_DRIVER=fake`                              | Refuse boot (test double)                  |
| `DATABASE_URL` contains the compose dev password     | Refuse boot                                |
| `CONTROL_STORE=memory`                               | Boot with loud `prod.memory_store` warning |
| Default/local `REDIS_URL`                            | Boot with loud `prod.local_cache` warning  |
| `REQUIRE_REDIS=true` and cache unreachable           | Refuse boot                                |

Set `REQUIRE_REDIS=true` once a Redis service is attached so a missing
`REDIS_URL` can never silently downgrade rate limiting and session
revocation to single-instance memory.

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

Two layers. Provider-managed Postgres backups (e.g. the Railway plugin's
automated backups) are the primary safety net — enable them. The CloudNivo
worker scheduler (`BACKUP_ENABLED=true`) is the portable second layer:
`pg_dump` custom-format plus a manifest (table inventory, row counts,
sha256 — never credentials or row contents), AES-256-GCM encrypted with
`BACKUP_ENCRYPTION_KEY`, verified every cycle, pruned to
`BACKUP_RETENTION_COUNT` newest.

```bash
# Manual backup + verification (same code the scheduler runs):
npm run db:backup --workspace=packages/database \
  -- --url "$DATABASE_URL" --out ./backups
npm run db:verify-backup --workspace=packages/database \
  -- --dump ./backups/<file>.dump \
     --manifest ./backups/<file>.dump.manifest.json \
     --scratch "$SCRATCH_DATABASE_URL"
```

The worker logs `worker.backups_config` at startup (directory, interval,
retention, encrypted yes/no) and `backups.completed` /
`backups.failed` (redacted) per cycle. Verification is restore-into-scratch
when `BACKUP_VERIFY_URL` is set, otherwise size+sha256 checksum of the
stored artifact. `BACKUP_DIR` must be a persistent volume in production
(Railway volume mount) — ephemeral disk loses backups on redeploy.

### Tested restore procedure (control database)

1. Pick the artifact: newest verified `cn-backup-<db>-<ts>.dump[.enc]` +
   its `.manifest.json` in `BACKUP_DIR`.
2. Decrypt if needed (key from env, never argv):
   `BACKUP_ENCRYPTION_KEY=... tsx packages/database/src/backup-cli.ts restore`
   handles decryption internally — do not decrypt by hand.
3. Restore into a scratch database first and compare inventory:
   run the `verify` command above against an empty database.
4. Restore into the target (requires explicit confirmation):
   ```bash
   tsx packages/database/src/backup-cli.ts restore \
     --dump ./backups/<file>.dump[.enc] \
     --manifest ./backups/<file>.dump.manifest.json \
     --target "$RESTORE_TARGET_URL" \
     --confirm-target <database-name-from-manifest>
   ```
5. Run `npm run db:migrate` if the dump predates the current schema, then
   `npm run db:seed` (idempotent) and check `/api/v1/health/ready`.

Never restore into a live database without a fresh backup first, and never
test restores against live customer data — scratch first, always. Recovery paths:

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
