import type {
  DatabaseProvisioner,
  ProvisionedDatabase,
  ProvisionRequest,
  ProviderMetrics,
  ProviderStatus,
} from './provisioner.js';
import { ProvisionerError } from './provisioner.js';

/**
 * TEST-ONLY in-memory provider. Implements `DatabaseProvisioner` with identical
 * lifecycle semantics so unit/integration tests run without Docker. Production
 * code paths NEVER select this provider (see factory in docker-provider.ts).
 */

interface FakeDb {
  req: ProvisionRequest;
  provisioned: ProvisionedDatabase;
  containerState: 'running' | 'exited' | 'restarting' | 'removed';
  failNext: number;
}

export class FakeDatabaseProvider implements DatabaseProvisioner {
  readonly provider = 'fake';
  private readonly dbs = new Map<string, FakeDb>();
  readonly calls: string[] = [];

  /** Fail the next N operations with a recoverable error (retry tests). */
  failNextOps(_databaseId: string, n: number): void {
    for (const db of this.dbs.values()) db.failNext = n;
  }

  private maybeFail(id: string): void {
    const db = this.dbs.get(id);
    if (db && db.failNext > 0) {
      db.failNext -= 1;
      throw new ProvisionerError('injected transient failure', true);
    }
  }

  async createDatabase(req: ProvisionRequest): Promise<ProvisionedDatabase> {
    this.calls.push(`create:${req.projectId}`);
    const existing = [...this.dbs.values()].find(d => d.req.projectId === req.projectId);
    if (existing && existing.containerState !== 'removed') return existing.provisioned;
    const provisioned: ProvisionedDatabase = {
      databaseId: `fake-${req.projectId}`,
      host: '127.0.0.1',
      port: 15499,
      dbName: `cn_${req.slug.replace(/-/g, '_')}_db`,
      dbUser: `cn_${req.slug.replace(/-/g, '_')}_u`,
      version: req.version,
    };
    this.dbs.set(provisioned.databaseId, {
      req,
      provisioned,
      containerState: 'running',
      failNext: 0,
    });
    return provisioned;
  }

  async deleteDatabase(databaseId: string): Promise<void> {
    this.calls.push(`delete:${databaseId}`);
    this.maybeFail(databaseId);
    const db = this.dbs.get(databaseId);
    if (!db) return;
    db.containerState = 'removed';
  }

  async startDatabase(databaseId: string): Promise<void> {
    this.calls.push(`start:${databaseId}`);
    this.maybeFail(databaseId);
    const db = this.dbs.get(databaseId);
    if (!db || db.containerState === 'removed')
      throw new ProvisionerError('database not found', false);
    db.containerState = 'running';
  }

  async stopDatabase(databaseId: string): Promise<void> {
    this.calls.push(`stop:${databaseId}`);
    this.maybeFail(databaseId);
    const db = this.dbs.get(databaseId);
    if (!db || db.containerState === 'removed')
      throw new ProvisionerError('database not found', false);
    db.containerState = 'exited';
  }

  async restartDatabase(databaseId: string): Promise<void> {
    this.calls.push(`restart:${databaseId}`);
    this.maybeFail(databaseId);
    const db = this.dbs.get(databaseId);
    if (!db || db.containerState === 'removed')
      throw new ProvisionerError('database not found', false);
    db.containerState = 'running';
  }

  async getStatus(
    databaseId: string,
    _conn: { host: string; port: number; database: string; user: string; password: string },
  ): Promise<ProviderStatus> {
    const db = this.dbs.get(databaseId);
    if (!db || db.containerState === 'removed') {
      return { status: 'deleted', health: 'unavailable', detail: 'not found' };
    }
    if (db.containerState === 'exited') return { status: 'stopped', health: 'unavailable' };
    if (db.containerState === 'restarting') return { status: 'restarting', health: 'starting' };
    return { status: 'running', health: 'healthy' };
  }

  async getMetrics(_conn: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }): Promise<ProviderMetrics> {
    return { version: 'PostgreSQL 16 (fake)', sizeBytes: 8192, connectionCount: 1 };
  }
}
