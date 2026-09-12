import type { DbAuditEvent } from '@cloudnivo/database';
import type { DatabaseProvisioner, ProvisionedDatabase, ProvisionRequest } from './provisioner.js';
import { ProvisionerError } from './provisioner.js';
import type { JobKind, JobStore } from './jobs.js';
import { backoffMs, shouldRetry } from './jobs.js';

export interface AuditSink {
  record(event: DbAuditEvent, fields: Record<string, unknown>): void;
}

export interface OrchestratorOptions {
  maxAttempts?: number;
  /** Skip real sleeping in tests (still records attempts). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Drive a pre-created job (e.g. the API creates the row so it can return
   * 202 immediately, then hands ownership here). Skips idempotency lookup.
   */
  resumeJobId?: string;
}

export interface ProvisionOutcome {
  jobId: string;
  /** Present when the job already completed; null while a live job is in flight. */
  database: ProvisionedDatabase | null;
  deduplicated: boolean;
}

function databaseFromLogs(logs: string[]): ProvisionedDatabase | null {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = logs[i] ?? '';
    const jsonStart = line.indexOf('{');
    if (jsonStart === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(jsonStart)) as ProvisionedDatabase;
      if (parsed && typeof parsed.databaseId === 'string') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Idempotent project-database provisioning:
 * create job → enforce attempts → provider.create → health-verify → ready.
 * A repeated call with the same idempotency key returns the live job without
 * touching infrastructure twice.
 */
export async function provisionProjectDatabase(
  provider: DatabaseProvisioner,
  jobs: JobStore,
  audit: AuditSink,
  input: {
    projectId: string;
    organizationId: string;
    userId: string;
    slug: string;
    password: string;
    version?: string;
    region?: string;
    idempotencyKey: string;
  },
  opts: OrchestratorOptions = {},
): Promise<ProvisionOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  if (!opts.resumeJobId) {
    const existing = await jobs.findByKey(input.organizationId, input.idempotencyKey);
    if (existing && existing.status !== 'failed') {
      return {
        jobId: existing.id,
        database: existing.status === 'completed' ? databaseFromLogs(existing.logs) : null,
        deduplicated: true,
      };
    }
  }
  const req: ProvisionRequest = {
    projectId: input.projectId,
    organizationId: input.organizationId,
    slug: input.slug,
    password: input.password,
    version: input.version ?? '16',
    region: input.region ?? 'local',
  };
  // In-flight drives by org+key: concurrent same-key storms collapse onto one
  // driver instead of each driving the same row (and the provider) twice.
  // The store-level pending map covers row creation; this covers the drive.
  const scope = `${input.organizationId}\n${input.idempotencyKey}`;
  if (!opts.resumeJobId) {
    const inflight = provisionInflight.get(scope);
    if (inflight) {
      const first = await inflight;
      return { ...first, deduplicated: true };
    }
  }
  const drive = driveProvision(
    provider,
    jobs,
    audit,
    input,
    req,
    maxAttempts,
    sleep,
    opts.resumeJobId,
  );
  if (!opts.resumeJobId) {
    provisionInflight.set(scope, drive);
    try {
      return await drive;
    } finally {
      if (provisionInflight.get(scope) === drive) provisionInflight.delete(scope);
    }
  }
  return drive;
}

const provisionInflight = new Map<string, Promise<ProvisionOutcome>>();

async function driveProvision(
  provider: DatabaseProvisioner,
  jobs: JobStore,
  audit: AuditSink,
  input: {
    projectId: string;
    organizationId: string;
    userId: string;
    slug: string;
    password: string;
    idempotencyKey: string;
  },
  req: ProvisionRequest,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
  resumeJobId?: string,
): Promise<ProvisionOutcome> {
  const job = resumeJobId
    ? await jobs.findById(resumeJobId).then(j => {
        if (!j) throw new Error('Provisioning job not found');
        return j;
      })
    : await jobs.create({
        projectId: input.projectId,
        organizationId: input.organizationId,
        kind: 'provision',
        status: 'pending',
        idempotencyKey: input.idempotencyKey,
        attempts: 0,
        maxAttempts,
        lastError: null,
        logs: [],
      });
  audit.record('database.provisioning.started', {
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.userId,
    jobId: job.id,
  });
  await jobs.update(job.id, { status: 'running' });
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await jobs.update(job.id, { attempts: attempt });
    await jobs.appendLog(job.id, `attempt ${attempt}: creating database`);
    try {
      const database = await provider.createDatabase(req);
      // Health-verify through the real probe before declaring ready.
      const status = await provider.getStatus(database.databaseId, {
        host: database.host,
        port: database.port,
        database: database.dbName,
        user: database.dbUser,
        password: req.password,
      });
      if (status.health !== 'healthy') {
        throw new ProvisionerError(`Database unhealthy after create (${status.health})`, true);
      }
      await jobs.update(job.id, { status: 'completed', lastError: null });
      // ProvisionedDatabase carries identity only (no password field by type);
      // credentials are never written to durable job logs.
      await jobs.appendLog(job.id, JSON.stringify(database));
      audit.record('database.provisioning.completed', {
        projectId: input.projectId,
        organizationId: input.organizationId,
        userId: input.userId,
        jobId: job.id,
      });
      return { jobId: job.id, database, deduplicated: false };
    } catch (err) {
      const recoverable = err instanceof ProvisionerError ? err.recoverable : false;
      const message = err instanceof Error ? err.message : String(err);
      await jobs.appendLog(job.id, `attempt ${attempt} failed: ${message.slice(0, 200)}`);
      if (shouldRetry(attempt, maxAttempts, recoverable)) {
        await jobs.update(job.id, { status: 'retrying', lastError: message.slice(0, 300) });
        await sleep(backoffMs(attempt));
        continue;
      }
      await jobs.update(job.id, { status: 'failed', lastError: message.slice(0, 500) });
      audit.record('database.provisioning.failed', {
        projectId: input.projectId,
        organizationId: input.organizationId,
        userId: input.userId,
        jobId: job.id,
      });
      throw err;
    }
  }
}

export async function runLifecycleJob(
  provider: DatabaseProvisioner,
  jobs: JobStore,
  audit: AuditSink,
  input: {
    kind: Extract<JobKind, 'delete' | 'restart' | 'stop' | 'start'>;
    projectId: string;
    organizationId: string;
    userId: string;
    databaseId: string;
  },
): Promise<string> {
  const auditEvent: DbAuditEvent =
    input.kind === 'delete'
      ? 'database.deleted'
      : input.kind === 'restart'
        ? 'database.restarted'
        : input.kind === 'stop'
          ? 'database.stopped'
          : 'database.started';
  const job = await jobs.create({
    projectId: input.projectId,
    organizationId: input.organizationId,
    kind: input.kind,
    status: 'running',
    idempotencyKey: null,
    attempts: 1,
    maxAttempts: 1,
    lastError: null,
    logs: [],
  });
  try {
    if (input.kind === 'delete') await provider.deleteDatabase(input.databaseId);
    else if (input.kind === 'restart') await provider.restartDatabase(input.databaseId);
    else if (input.kind === 'stop') await provider.stopDatabase(input.databaseId);
    else await provider.startDatabase(input.databaseId);
    await jobs.update(job.id, { status: 'completed' });
    audit.record(auditEvent, {
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      jobId: job.id,
    });
    return job.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobs.update(job.id, { status: 'failed', lastError: message.slice(0, 500) });
    throw err;
  }
}
