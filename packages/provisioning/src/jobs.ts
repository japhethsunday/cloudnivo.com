/**
 * Provisioning job system. HTTP creates a job and returns immediately; the
 * orchestrator drives it PENDING → RUNNING → COMPLETED (or FAILED/RETRYING).
 *
 * Idempotency: jobs carry a client key unique per organization. A repeated
 * request with the same key returns the existing non-failed job instead of
 * provisioning a duplicate database.
 */

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'retrying'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ['provision', 'delete', 'restart', 'stop', 'start'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface ProvisioningJob {
  id: string;
  projectId: string;
  organizationId: string;
  kind: JobKind;
  status: JobStatus;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JobStore {
  create(job: Omit<ProvisioningJob, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProvisioningJob>;
  findById(id: string): Promise<ProvisioningJob | null>;
  findByKey(organizationId: string, key: string): Promise<ProvisioningJob | null>;
  listByProject(projectId: string): Promise<ProvisioningJob[]>;
  /** Worker drain: jobs in a given status, oldest first (bounded). */
  listByStatus(status: JobStatus, limit?: number): Promise<ProvisioningJob[]>;
  update(
    id: string,
    patch: Partial<Pick<ProvisioningJob, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<ProvisioningJob>;
  appendLog(id: string, line: string): Promise<void>;
}

let counter = 0;

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, ProvisioningJob>();

  async create(
    job: Omit<ProvisioningJob, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ProvisioningJob> {
    // Idempotency: same org+key with a live job wins — no duplicate database.
    if (job.idempotencyKey) {
      const existing = await this.findByKey(job.organizationId, job.idempotencyKey);
      if (existing && existing.status !== 'failed') return existing;
    }
    counter += 1;
    const now = new Date().toISOString();
    const full: ProvisioningJob = { ...job, id: `job_${counter}`, createdAt: now, updatedAt: now };
    this.jobs.set(full.id, full);
    return full;
  }

  async findById(id: string): Promise<ProvisioningJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async findByKey(organizationId: string, key: string): Promise<ProvisioningJob | null> {
    for (const j of this.jobs.values()) {
      if (j.organizationId === organizationId && j.idempotencyKey === key) return j;
    }
    return null;
  }

  async listByProject(projectId: string): Promise<ProvisioningJob[]> {
    return [...this.jobs.values()]
      .filter(j => j.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async listByStatus(status: JobStatus, limit = 100): Promise<ProvisioningJob[]> {
    return [...this.jobs.values()]
      .filter(j => j.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async update(
    id: string,
    patch: Partial<Pick<ProvisioningJob, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<ProvisioningJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, next);
    return next;
  }

  async appendLog(id: string, line: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    job.logs.push(`[${new Date().toISOString()}] ${line.slice(0, 500)}`);
    job.updatedAt = new Date().toISOString();
  }
}

/** Retry only recoverable failures, up to maxAttempts (no endless loops). */
export function shouldRetry(attempts: number, maxAttempts: number, recoverable: boolean): boolean {
  return recoverable && attempts < maxAttempts;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
