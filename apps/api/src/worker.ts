import { createServer, type Server } from 'node:http';
import { loadConfig, loadDotEnv } from '@cloudnivo/config';
import { createLogger, type Logger } from '@cloudnivo/logging';
import type { DatabaseStatus } from '@cloudnivo/database';
import type { JobStatus } from '@cloudnivo/provisioning';
import { createContext, initControlPlane, type ApiContext } from './v1.js';
import { assertProductionSafety, assertSharedCache } from './prod-guards.js';
import { resolveListenPort } from './platform-port.js';
import { storageFor } from './storage.js';

export interface DrainResult {
  resumed: number;
  reaped: number;
  failed: number;
}

export interface BillingDrainResult {
  reconciled: number;
  pruned: number;
  errors: { organizationId: string; error: string }[];
}

const STALE_STATUSES: JobStatus[] = ['pending', 'retrying'];

/**
 * Background worker: drains orphaned provisioning jobs.
 *
 * The API drives jobs inline; when it restarts mid-flight, in-process drivers
 * die and leave non-terminal rows behind. On drizzle (shared) stores this
 * worker reaps them: lifecycle jobs (delete/stop/start/restart) are resumed
 * against live infrastructure; provision jobs cannot resume (the plaintext
 * password exists only in the originating request) so they are marked failed
 * with a safe-to-retry message — the org idempotency key then admits a fresh
 * attempt instead of wedging on the dead row forever.
 *
 * Only jobs older than WORKER_STALE_MS are touched, so a healthy API driving
 * its own jobs never races the worker. With CONTROL_STORE=memory the worker
 * shares no state and exits its polls idle (documented, not an error).
 */
export async function drainOnce(ctx: ApiContext, now = Date.now()): Promise<DrainResult> {
  const staleMs = ctx.config.WORKER_STALE_MS;
  const result: DrainResult = { resumed: 0, reaped: 0, failed: 0 };
  const stale: {
    id: string;
    kind: string;
    projectId: string;
    organizationId: string;
    status: string;
    updatedAt: string;
  }[] = [];
  for (const status of STALE_STATUSES) {
    const jobs = await ctx.jobs.listByStatus(status, 100);
    for (const job of jobs) {
      if (now - Date.parse(job.updatedAt) >= staleMs) {
        stale.push({
          id: job.id,
          kind: job.kind,
          projectId: job.projectId,
          organizationId: job.organizationId,
          status: job.status,
          updatedAt: job.updatedAt,
        });
      }
    }
  }
  for (const job of stale) {
    try {
      if (job.kind === 'provision') {
        await ctx.jobs.update(job.id, {
          status: 'failed',
          lastError:
            'Worker reaped orphaned provision job (driver lost during API restart). Safe to retry: the org idempotency key admits a fresh attempt.',
        });
        ctx.audit.record('database.provisioning.failed', {
          projectId: job.projectId,
          organizationId: job.organizationId,
        });
        result.reaped += 1;
        continue;
      }
      const db = await ctx.registry.getDatabaseByProject(job.projectId);
      if (!db) {
        await ctx.jobs.update(job.id, {
          status: 'failed',
          lastError:
            'Worker could not resume lifecycle job: database record is gone. Check for orphaned infrastructure manually.',
        });
        ctx.logger.warn('worker.orphan_infra', {
          job: job.id,
          project: job.projectId,
          kind: job.kind,
        });
        result.failed += 1;
        continue;
      }
      if (job.kind === 'delete') await ctx.provider.deleteDatabase(db.databaseId);
      else if (job.kind === 'stop') await ctx.provider.stopDatabase(db.databaseId);
      else if (job.kind === 'start') await ctx.provider.startDatabase(db.databaseId);
      else await ctx.provider.restartDatabase(db.databaseId);
      const status: DatabaseStatus =
        job.kind === 'stop' ? 'stopped' : job.kind === 'start' ? 'running' : 'ready';
      await ctx.registry.updateDatabaseStatus(job.projectId, status);
      if (job.kind === 'delete') {
        await ctx.registry.deleteProject(job.projectId);
        try {
          await storageFor(ctx).deleteProjectData(job.projectId);
        } catch (err) {
          ctx.logger.warn('worker.delete.storage_cleanup_failed', {
            project: job.projectId,
            error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
          });
        }
      }
      await ctx.jobs.update(job.id, { status: 'completed', lastError: null });
      result.resumed += 1;
    } catch (err) {
      await ctx.jobs
        .update(job.id, {
          status: 'failed',
          lastError: `Worker resume failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
        })
        .catch(() => undefined);
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Billing maintenance: reconcile time-driven subscription transitions and
 * prune raw usage past retention. Pruning is global (no org enumeration
 * needed); reconciliation covers orgs the caller lists — the API reconciles
 * lazily on read, so the worker's prune is the critical scheduled work.
 * Every step is idempotent; failures are reported, never thrown.
 */
export async function drainBillingOnce(
  ctx: ApiContext,
  organizationIds: string[] = [],
): Promise<BillingDrainResult> {
  try {
    return await ctx.billing.runMaintenance(organizationIds, {
      rawRetentionDays: ctx.config.BILLING_RAW_RETENTION_DAYS,
    });
  } catch (err) {
    return {
      reconciled: 0,
      pruned: 0,
      errors: [
        { organizationId: '', error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
      ],
    };
  }
}

/**
 * Agent maintenance: expire stale pending approvals and prune old activity.
 * Same fire-and-forget discipline as the billing drain.
 */
export async function drainAgentsOnce(
  ctx: ApiContext,
  organizationIds: string[] = [],
): Promise<{ expired: number; pruned: number }> {
  try {
    const { agentServiceFor } = await import('./agents.js');
    return await agentServiceFor(ctx).runMaintenance(organizationIds, {
      activityRetentionDays: ctx.config.AGENT_ACTIVITY_RETENTION_DAYS,
    });
  } catch {
    return { expired: 0, pruned: 0 };
  }
}

export interface BackupDrainResult {
  ran: boolean;
  artifactPath?: string;
  encrypted?: boolean;
  verified?: string;
  pruned?: number;
  error?: string;
}

export interface RetentionDrainResult {
  organizations: number;
  pruned: number;
}

const DEFAULT_LOG_RETENTION_DAYS = 90;

/**
 * Log retention enforcement: per-org policy (organization_policies.
 * logRetentionDays, default 90d) prunes audit rows older than the cutoff.
 * Runs in the worker loop; failures are logged, never thrown.
 */
export async function drainRetentionOnce(ctx: ApiContext, now = Date.now()): Promise<RetentionDrainResult> {
  let organizations = 0;
  let pruned = 0;
  try {
    const { platformAuthFor } = await import('./platform-auth.js');
    const orgIds = await ctx.registry.listOrganizationIds().catch(() => [] as string[]);
    for (const orgId of orgIds) {
      const store = platformAuthFor(ctx);
      const policy = await store.policies.getPolicy(orgId).catch(() => null);
      const days = Math.min(
        Math.max(policy?.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS, 7),
        365,
      );
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      pruned += await ctx.registry.pruneAuditLogs(cutoff, orgId).catch(() => 0);
      organizations += 1;
    }
  } catch (err) {
    ctx.logger.warn('worker.retention_failed', {
      error: err instanceof Error ? err.message.slice(0, 160) : 'unknown',
    });
  }
  return { organizations, pruned };
}

export interface LogDrainResult {
  drains: number;
  shipped: number;
  failed: number;
}

/**
 * Log-drain shipping: enabled drains receive new audit entries (cursor =
 * last shipped timestamp, 100 entries max per drain per cycle) with HMAC
 * signatures. Failures update lastStatus/lastError for the dashboard.
 */
export async function drainLogsOnce(ctx: ApiContext): Promise<LogDrainResult> {
  let drains = 0;
  let shipped = 0;
  let failed = 0;
  try {
    const { platformOpsFor, deliverDrain } = await import('./platform-ops.js');
    const ops = platformOpsFor(ctx);
    const all = await ops.drains.listAll().catch(() => []);
    const entries = await ctx.registry.listAudit().catch(() => []);
    const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : 1));
    for (const drain of all) {
      drains += 1;
      try {
        const full = await ops.drains.getWithSecret(drain.id);
        if (!full) continue;
        const batch = ordered
          .filter(
            e =>
              (drain.organizationId === e.organizationId || e.organizationId === null) &&
              (!drain.projectId || drain.projectId === e.projectId) &&
              (!full.cursor || e.at > full.cursor),
          )
          .slice(0, 100);
        if (batch.length === 0) {
          await ops.drains.setStatus(drain.id, 'ok', null, null);
          continue;
        }
        const result = await deliverDrain(ctx, full, batch);
        if (result.ok) {
          shipped += batch.length;
          await ops.drains.setStatus(drain.id, 'ok', null, batch[batch.length - 1]?.at ?? null);
        } else {
          failed += 1;
          await ops.drains.setStatus(drain.id, 'error', result.error, null);
        }
      } catch (err) {
        failed += 1;
        await ops.drains
          .setStatus(drain.id, 'error', err instanceof Error ? err.message.slice(0, 160) : 'failed', null)
          .catch(() => undefined);
      }
    }
  } catch (err) {
    ctx.logger.warn('worker.drains_failed', {
      error: err instanceof Error ? err.message.slice(0, 160) : 'unknown',
    });
  }
  return { drains, shipped, failed };
}

let lastBackupAt = 0;

/**
 * Scheduled control-plane backups. Runs at most every BACKUP_INTERVAL_MS
 * from this single worker loop (never from the API fleet). Skipped unless
 * BACKUP_ENABLED=true. Failures are logged redacted and retried next
 * interval — a failed backup is observable, never silent.
 */
export async function drainBackupsOnce(ctx: ApiContext, now = Date.now()): Promise<BackupDrainResult> {
  if (!ctx.config.BACKUP_ENABLED) return { ran: false };
  if (now - lastBackupAt < ctx.config.BACKUP_INTERVAL_MS) return { ran: false };
  lastBackupAt = now;
  try {
    const { runBackupCycle } = await import('@cloudnivo/database');
    const report = await runBackupCycle({
      connectionString: ctx.config.DATABASE_URL,
      outDir: ctx.config.BACKUP_DIR,
      appVersion: '0.1.0',
      encryptionKey: ctx.config.BACKUP_ENCRYPTION_KEY || undefined,
      isProduction: ctx.config.isProduction,
      retentionCount: ctx.config.BACKUP_RETENTION_COUNT,
      verifyUrl: process.env.BACKUP_VERIFY_URL || undefined,
    });
    ctx.logger.info('backups.completed', {
      artifact: report.artifactPath.split(/[\\/]/).slice(-1)[0],
      tables: report.tables,
      rows: report.totalRows,
      bytes: report.artifactBytes,
      encrypted: report.encrypted,
      verified: report.verified,
      pruned: report.pruned.length,
    });
    await ctx.registry.recordAudit('backups.completed', {}).catch(() => undefined);
    return {
      ran: true,
      artifactPath: report.artifactPath,
      encrypted: report.encrypted,
      verified: report.verified,
      pruned: report.pruned.length,
    };
  } catch (err) {
    const { redactBackupError } = await import('@cloudnivo/database');
    const message = redactBackupError(err);
    ctx.logger.warn('backups.failed', { error: message });
    return { ran: false, error: message };
  }
}

export interface WorkerHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startWorker(port?: number): Promise<WorkerHandle> {
  await loadDotEnv();
  const config = loadConfig();
  const logger: Logger = createLogger({ service: 'worker' });
  const ctx = createContext(config);
  assertProductionSafety(config, logger);
  await assertSharedCache(config, ctx.cache, logger);
  await initControlPlane(ctx);
  if (config.CONTROL_STORE !== 'drizzle') {
    logger.warn('worker.memory_store', {
      note: 'CONTROL_STORE=memory shares no job state; worker polls idle until drizzle is configured',
    });
  }
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await drainOnce(ctx);
      if (result.resumed + result.reaped + result.failed > 0) {
        logger.info('worker.drain', {
          resumed: result.resumed,
          reaped: result.reaped,
          failed: result.failed,
        });
      }
      const billing = await drainBillingOnce(ctx);
      if (billing.pruned + billing.reconciled + billing.errors.length > 0) {
        logger.info('worker.billing_drain', {
          reconciled: billing.reconciled,
          pruned: billing.pruned,
          errors: billing.errors.length,
        });
      }
      const agents = await drainAgentsOnce(ctx);
      if (agents.expired + agents.pruned > 0) {
        logger.info('worker.agents_drain', {
          expired: agents.expired,
          pruned: agents.pruned,
        });
      }
      const { drainAutomationOnce } = await import('./automation.js');
      const automation = await drainAutomationOnce(ctx, `worker-${Date.now()}`);
      if (
        automation.deliveries.retried + automation.schedules.fired + automation.schedules.failed >
        0
      ) {
        logger.info('worker.automation_drain', {
          deliveriesRetried: automation.deliveries.retried,
          deliveriesSucceeded: automation.deliveries.succeeded,
          deliveriesFailed: automation.deliveries.failed,
          schedulesFired: automation.schedules.fired,
          schedulesFailed: automation.schedules.failed,
        });
      }
      const backups = await drainBackupsOnce(ctx);
      if (backups.ran) {
        logger.info('worker.backups_drain', {
          artifact: backups.artifactPath?.split(/[\\/]/).slice(-1)[0],
          encrypted: backups.encrypted,
          verified: backups.verified,
          pruned: backups.pruned,
        });
      }
      const retention = await drainRetentionOnce(ctx);
      if (retention.pruned > 0) {
        logger.info('worker.retention_drain', {
          organizations: retention.organizations,
          pruned: retention.pruned,
        });
      }
      const drains = await drainLogsOnce(ctx);
      if (drains.drains > 0) {
        logger.info('worker.drains', {
          drains: drains.drains,
          shipped: drains.shipped,
          failed: drains.failed,
        });
      }
    } catch (err) {
      logger.warn('worker.drain_failed', {
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
    }
  };
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = poll().finally(() => {
      inFlight = null;
    });
  }, config.WORKER_POLL_MS);
  timer.unref?.();

  const server: Server = createServer((req, res) => {
    const payload = JSON.stringify({ data: { status: 'ok', service: 'worker' } });
    if (req.url === '/api/v1/health' || req.url === '/api/v1/health/live') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }
    if (req.url === '/api/v1/health/ready') {
      const body = JSON.stringify({ data: { status: 'ok', components: { poller: !stopped } } });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });
  const listenPort = resolveListenPort(port, config.WORKER_PORT);
  await new Promise<void>(resolve => server.listen(listenPort, resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : listenPort;
  logger.info('worker listening', {
    port: actual,
    pollMs: config.WORKER_POLL_MS,
    staleMs: config.WORKER_STALE_MS,
  });
  logger.info('worker.backups_config', {
    enabled: config.BACKUP_ENABLED,
    dir: config.BACKUP_DIR,
    intervalMs: config.BACKUP_INTERVAL_MS,
    retention: config.BACKUP_RETENTION_COUNT,
    encrypted: config.BACKUP_ENCRYPTION_KEY.length > 0,
    note: 'BACKUP_DIR must be a persistent volume in production (ephemeral disk loses backups on redeploy)',
  });

  const shutdown = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) {
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise(r => setTimeout(r, config.WORKER_DRAIN_MS)),
      ]);
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (ctx.controlDb) await ctx.controlDb.close().catch(() => undefined);
    logger.info('worker stopped');
  };
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  return {
    close: shutdown,
    port: actual,
  };
}

// Entrypoint only when run directly (`node dist/worker.js` / `tsx src/worker.ts`).
const isMain = process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js');
if (isMain) {
  startWorker().catch(err => {
    const logger = createLogger({ service: 'worker' });
    logger.error('failed to start', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
