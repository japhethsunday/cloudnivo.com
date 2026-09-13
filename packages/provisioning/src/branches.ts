import { randomUUID } from 'node:crypto';
import type { CloneRequest, DatabaseProvisioner, ProvisionedDatabase } from './provisioner.js';
import { ProvisionerError } from './provisioner.js';
import { assertSlug } from './validation.js';

/**
 * Database branching: copy-on-write (TEMPLATE) where the engine supports it,
 * dump/restore otherwise. Branches are full databases with their own
 * provider handles; connection credentials follow the same storage posture
 * as project credentials (control-plane store, never logged).
 */

export type BranchStatus = 'ready' | 'creating' | 'failed' | 'deleting';

export interface BranchRecord {
  id: string;
  projectId: string;
  organizationId: string;
  /** Branch name (slug-shaped, `main` reserved for the primary database). */
  name: string;
  databaseId: string;
  dbName: string;
  dbUser: string;
  /** Branch-local password (managed reuses the project role password). */
  dbPassword: string | null;
  host: string;
  port: number;
  source: string;
  status: BranchStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BranchStore {
  create(input: Omit<BranchRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BranchRecord>;
  get(id: string): Promise<BranchRecord | null>;
  listByProject(projectId: string): Promise<BranchRecord[]>;
  update(id: string, patch: Partial<Pick<BranchRecord, 'status' | 'lastError' | 'databaseId' | 'dbName' | 'dbUser' | 'dbPassword' | 'host' | 'port'>>): Promise<BranchRecord | null>;
  remove(id: string): Promise<boolean>;
}

function now(): string {
  return new Date().toISOString();
}

export class MemoryBranchStore implements BranchStore {
  private readonly branches = new Map<string, BranchRecord>();
  async create(input: Omit<BranchRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BranchRecord> {
    const record: BranchRecord = { ...input, id: randomUUID(), createdAt: now(), updatedAt: now() };
    this.branches.set(record.id, record);
    return { ...record };
  }
  async get(id: string): Promise<BranchRecord | null> {
    const b = this.branches.get(id);
    return b ? { ...b } : null;
  }
  async listByProject(projectId: string): Promise<BranchRecord[]> {
    return [...this.branches.values()]
      .filter(b => b.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map(b => ({ ...b }));
  }
  async update(
    id: string,
    patch: Partial<Pick<BranchRecord, 'status' | 'lastError' | 'databaseId' | 'dbName' | 'dbUser' | 'dbPassword' | 'host' | 'port'>>,
  ): Promise<BranchRecord | null> {
    const b = this.branches.get(id);
    if (!b) return null;
    const next = { ...b, ...patch, id: b.id, projectId: b.projectId, updatedAt: now() };
    this.branches.set(id, next);
    return { ...next };
  }
  async remove(id: string): Promise<boolean> {
    return this.branches.delete(id);
  }
}

export interface CreateBranchInput {
  projectId: string;
  organizationId: string;
  name: string;
  /** Source provider handle. Null = the project's main database. */
  sourceDatabaseId: string | null;
  /** Resolved main-database handle + password (for clone input). */
  main: { databaseId: string; password: string; version: string; region: string; slug: string };
}

function assertBranchName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (clean === 'main') throw new ProvisionerError('Branch name "main" is reserved', false);
  assertSlug(clean);
  if (clean.length > 40) throw new ProvisionerError('Branch name must be at most 40 chars', false);
  return clean;
}

export class BranchService {
  constructor(
    private readonly store: BranchStore,
    private readonly provider: DatabaseProvisioner,
  ) {}

  get storeRef(): BranchStore {
    return this.store;
  }

  async createBranch(input: CreateBranchInput): Promise<{ branch: BranchRecord; database: ProvisionedDatabase }> {
    const clone = this.provider.cloneDatabase;
    if (!clone) {
      throw new ProvisionerError(`Branches are not supported by the ${this.provider.provider} provider`, false);
    }
    const name = assertBranchName(input.name);
    const existing = await this.store.listByProject(input.projectId);
    if (existing.some(b => b.name === name)) {
      throw new ProvisionerError(`Branch "${name}" already exists`, false);
    }
    const sourceDatabaseId = input.sourceDatabaseId ?? input.main.databaseId;
    const targetPassword = input.main.password;
    const cloneReq: CloneRequest = {
      sourceDatabaseId,
      sourcePassword: input.main.password,
      target: {
        projectId: input.projectId,
        organizationId: input.organizationId,
        slug: `${input.main.slug}-${name}`.slice(0, 60),
        password: targetPassword,
        version: input.main.version,
        region: input.main.region,
      },
      branch: name,
    };
    let branch = await this.store.create({
      projectId: input.projectId,
      organizationId: input.organizationId,
      name,
      databaseId: '',
      dbName: '',
      dbUser: '',
      dbPassword: null,
      host: '',
      port: 0,
      source: input.sourceDatabaseId ?? 'main',
      status: 'creating',
      lastError: null,
    });
    try {
      const database = await clone.call(this.provider, cloneReq);
      const updated = await this.store.update(branch.id, {
        status: 'ready',
        databaseId: database.databaseId,
        dbName: database.dbName,
        dbUser: database.dbUser,
        dbPassword: targetPassword,
        host: database.host,
        port: database.port,
        lastError: null,
      });
      branch = updated ?? branch;
      return { branch, database };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.update(branch.id, { status: 'failed', lastError: message.slice(0, 300) });
      throw err;
    }
  }

  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    const branch = await this.store.get(branchId);
    if (!branch || branch.projectId !== projectId) {
      throw new ProvisionerError('Branch not found', false);
    }
    await this.store.update(branchId, { status: 'deleting' });
    if (branch.databaseId) {
      await this.provider.deleteDatabase(branch.databaseId).catch(() => undefined);
    }
    await this.store.remove(branchId);
  }

  /** Reset = drop the clone and re-copy from source (fresh password required). */
  async resetBranch(
    projectId: string,
    branchId: string,
    input: { password: string; main: CreateBranchInput['main'] },
  ): Promise<{ branch: BranchRecord; database: ProvisionedDatabase }> {
    const branch = await this.store.get(branchId);
    if (!branch || branch.projectId !== projectId) {
      throw new ProvisionerError('Branch not found', false);
    }
    const clone = this.provider.cloneDatabase;
    if (!clone) {
      throw new ProvisionerError(`Branches are not supported by the ${this.provider.provider} provider`, false);
    }
    if (branch.databaseId) {
      await this.provider.deleteDatabase(branch.databaseId).catch(() => undefined);
    }
    await this.store.update(branchId, { status: 'creating', lastError: null });
    try {
      const database = await clone.call(this.provider, {
        sourceDatabaseId: input.main.databaseId,
        sourcePassword: input.main.password,
        target: {
          projectId,
          organizationId: branch.organizationId,
          slug: `${input.main.slug}-${branch.name}`.slice(0, 60),
          password: input.password,
          version: input.main.version,
          region: input.main.region,
        },
        branch: branch.name,
      });
      const updated = await this.store.update(branchId, {
        status: 'ready',
        databaseId: database.databaseId,
        dbName: database.dbName,
        dbUser: database.dbUser,
        dbPassword: input.password,
        host: database.host,
        port: database.port,
        lastError: null,
      });
      return { branch: updated ?? branch, database };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.update(branchId, { status: 'failed', lastError: message.slice(0, 300) });
      throw err;
    }
  }
}
