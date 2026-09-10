import { and, desc, eq } from 'drizzle-orm';
import { provisioningJobs, type Database } from '@cloudnivo/database';
import type { JobStatus, JobStore, ProvisioningJob } from './jobs.js';

/**
 * Drizzle-backed provisioning job store (`provisioning_jobs` table).
 * Idempotency mirrors memory: same org+key with a live job wins instead of
 * creating a duplicate (table unique constraint backs the race).
 */

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToJob(row: typeof provisioningJobs.$inferSelect): ProvisioningJob {
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId,
    kind: row.kind as ProvisioningJob['kind'],
    status: row.status as JobStatus,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    logs: [...(row.logs ?? [])],
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date().toISOString(),
  };
}

export class DrizzleJobStore implements JobStore {
  constructor(private readonly db: Database) {}

  async create(
    job: Omit<ProvisioningJob, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ProvisioningJob> {
    if (job.idempotencyKey) {
      const existing = await this.findByKey(job.organizationId, job.idempotencyKey);
      if (existing && existing.status !== 'failed') return existing;
    }
    try {
      const rows = await this.db
        .insert(provisioningJobs)
        .values({
          projectId: job.projectId,
          organizationId: job.organizationId,
          kind: job.kind,
          status: job.status,
          idempotencyKey: job.idempotencyKey,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          lastError: job.lastError,
          logs: job.logs,
        })
        .returning();
      const saved = rows[0];
      if (!saved) throw new Error('Job insert failed');
      return rowToJob(saved);
    } catch (err) {
      // Lost the unique race: return the live winner like memory does.
      if (job.idempotencyKey && String((err as { code?: unknown }).code) === '23505') {
        const existing = await this.findByKey(job.organizationId, job.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async findById(id: string): Promise<ProvisioningJob | null> {
    const rows = await this.db
      .select()
      .from(provisioningJobs)
      .where(eq(provisioningJobs.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToJob(row) : null;
  }

  async findByKey(organizationId: string, key: string): Promise<ProvisioningJob | null> {
    const rows = await this.db
      .select()
      .from(provisioningJobs)
      .where(
        and(
          eq(provisioningJobs.organizationId, organizationId),
          eq(provisioningJobs.idempotencyKey, key),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToJob(row) : null;
  }

  async listByProject(projectId: string): Promise<ProvisioningJob[]> {
    const rows = await this.db
      .select()
      .from(provisioningJobs)
      .where(eq(provisioningJobs.projectId, projectId))
      .orderBy(desc(provisioningJobs.createdAt));
    return rows.map(rowToJob);
  }

  async listByStatus(status: JobStatus, limit = 100): Promise<ProvisioningJob[]> {
    const rows = await this.db
      .select()
      .from(provisioningJobs)
      .where(eq(provisioningJobs.status, status))
      .orderBy(desc(provisioningJobs.createdAt))
      .limit(Math.max(1, Math.min(limit, 1000)));
    return rows.map(rowToJob);
  }

  async update(
    id: string,
    patch: Partial<Pick<ProvisioningJob, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<ProvisioningJob> {
    const rows = await this.db
      .update(provisioningJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(provisioningJobs.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Job not found');
    return rowToJob(row);
  }

  async appendLog(id: string, line: string): Promise<void> {
    const current = await this.findById(id);
    if (!current) throw new Error('Job not found');
    const logs = [...current.logs, `[${new Date().toISOString()}] ${line.slice(0, 500)}`];
    await this.db
      .update(provisioningJobs)
      .set({ logs, updatedAt: new Date() })
      .where(eq(provisioningJobs.id, id));
  }
}
