import {
  checkProjectDbHealth,
  getProjectDbMetrics,
  queryProjectDb,
  type ProjectConnectionInfo,
} from '@cloudnivo/database';
import type {
  DatabaseProvisioner,
  ProvisionedDatabase,
  ProvisionRequest,
  ProviderMetrics,
  ProviderStatus,
} from './provisioner.js';
import { ProviderUnavailableError, ProvisionerError } from './provisioner.js';
import {
  InvalidProvisionInputError,
  assertDbPassword,
  assertImageVersion,
  assertPostgresIdent,
  assertSlug,
  dbNameFor,
  dbUserFor,
} from './validation.js';

export interface ManagedPostgresOptions {
  /**
   * Privileged connection string for the shared Postgres server
   * (MANAGED_PG_URL). Used ONLY for DDL (roles/databases) — never handed to
   * customers. Customer connections use per-project roles/databases below.
   */
  connectionString: string;
  healthTimeoutMs?: number;
}

interface ManagedHandle {
  dbName: string;
  dbUser: string;
}

const HANDLE_RE = /^managed:([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/;

function parseHandle(databaseId: string): ManagedHandle {
  const m = HANDLE_RE.exec(databaseId);
  if (!m?.[1] || !m[2]) {
    throw new ProvisionerError('Unknown managed database handle', false);
  }
  return { dbName: m[1], dbUser: m[2] };
}

function parseAdminUrl(connectionString: string): { controlDb: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new InvalidProvisionInputError('MANAGED_PG_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new InvalidProvisionInputError('MANAGED_PG_URL must be a postgres:// URL');
  }
  const controlDb = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(controlDb)) {
    throw new InvalidProvisionInputError('MANAGED_PG_URL database name looks unsafe');
  }
  return { controlDb };
}

/**
 * Managed-Postgres implementation of `DatabaseProvisioner`.
 *
 * Provisions one database + one locked-down role per project inside a SHARED
 * Postgres server (Railway PG plugin, RDS, compose postgres) — the production
 * story where no Docker daemon exists. Isolation is real: separate databases,
 * per-project roles that own only their database, and an explicit REVOKE of
 * every privilege on the control database.
 *
 * Lifecycle mapping onto shared infrastructure:
 * - start/stop toggle `datallowconn` (+ backend termination on stop);
 *   restart = stop + start. Status reads the flag + a live probe.
 * - No shell, no Docker, no host mounts. Identifiers are allow-listed;
 *   the password travels as a `$1` bind parameter only.
 */
export class ManagedPostgresProvider implements DatabaseProvisioner {
  readonly provider = 'managed';
  private readonly connectionString: string;
  private readonly controlDb: string;
  private readonly healthTimeoutMs: number;

  constructor(opts: ManagedPostgresOptions) {
    if (!opts.connectionString) {
      throw new InvalidProvisionInputError('MANAGED_PG_URL is required for the managed provider');
    }
    this.connectionString = opts.connectionString;
    this.controlDb = parseAdminUrl(opts.connectionString).controlDb;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;
  }

  private adminConn(database?: string): ProjectConnectionInfo {
    const url = new URL(this.connectionString);
    const user = decodeURIComponent(url.username || 'postgres');
    return {
      host: url.hostname || 'localhost',
      port: url.port ? Number(url.port) : 5432,
      database: database ?? this.controlDb,
      user,
      password: decodeURIComponent(url.password || ''),
    };
  }

  private async adminQuery<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
    database?: string,
  ): Promise<T[]> {
    try {
      return (await queryProjectDb(this.adminConn(database), text, params, 15_000)) as T[];
    } catch (err) {
      throw this.classify(err);
    }
  }

  private classify(err: unknown): ProvisionerError {
    if (err instanceof ProvisionerError) return err;
    if (err instanceof InvalidProvisionInputError) {
      return new ProvisionerError(err.message, false);
    }
    const msg = err instanceof Error ? err.message : String(err);
    // NOTE: bare `timeout` is deliberately absent — server rejections mention
    // `statement_timeout` (e.g. set_config failures), which is a query error,
    // not an unreachable server. Only transport-level markers map here.
    if (
      /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connect timeout|connection timeout|password authentication failed|no pg_hba/i.test(
        msg,
      )
    ) {
      return new ProviderUnavailableError('Managed Postgres is unreachable');
    }
    // Never leak connection details; identifiers are already validated.
    return new ProvisionerError('Managed Postgres operation failed', true);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.adminQuery('select 1');
      return true;
    } catch {
      return false;
    }
  }

  private async requireAvailable(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new ProviderUnavailableError('Managed Postgres is unreachable');
    }
  }

  async createDatabase(req: ProvisionRequest): Promise<ProvisionedDatabase> {
    await this.requireAvailable();
    assertSlug(req.slug);
    assertDbPassword(req.password);
    assertImageVersion(req.version);
    const dbName = assertPostgresIdent(dbNameFor(req.slug), 'Database name');
    const dbUser = assertPostgresIdent(dbUserFor(req.slug), 'Database user');
    const databaseId = `managed:${dbName}:${dbUser}`;

    // Idempotency: adopt a previous attempt's database instead of failing.
    const existing = await this.describeIfExists(dbName, dbUser, req.password);
    if (existing) return existing;

    await this.adminQuery(`CREATE ROLE "${dbUser}" WITH LOGIN PASSWORD $1`, [req.password]);
    try {
      await this.adminQuery(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
    } catch (err) {
      await this.adminQuery(`DROP ROLE IF EXISTS "${dbUser}"`).catch(() => undefined);
      throw err;
    }
    // Lockdown: the project role sees ONLY its own database.
    await this.adminQuery(`REVOKE ALL ON DATABASE "${this.controlDb}" FROM "${dbUser}"`);

    const conn = this.projectConn(dbName, dbUser, req.password);
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      const { health } = await checkProjectDbHealth(conn, 3000).catch(() => ({
        health: 'unavailable' as const,
      }));
      if (health === 'healthy') break;
      if (Date.now() > deadline) {
        await this.deleteDatabase(databaseId).catch(() => undefined);
        throw new ProvisionerError('Database did not become healthy in time', true);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    const admin = new URL(this.connectionString);
    return {
      databaseId,
      host: admin.hostname || 'localhost',
      port: admin.port ? Number(admin.port) : 5432,
      dbName,
      dbUser,
      version: req.version,
    };
  }

  private projectConn(dbName: string, dbUser: string, password: string): ProjectConnectionInfo {
    const admin = new URL(this.connectionString);
    return {
      host: admin.hostname || 'localhost',
      port: admin.port ? Number(admin.port) : 5432,
      database: dbName,
      user: dbUser,
      password,
    };
  }

  /** Adopt a fully-created database from a previous attempt (crash recovery). */
  private async describeIfExists(
    dbName: string,
    dbUser: string,
    password: string,
  ): Promise<ProvisionedDatabase | null> {
    const dbs = await this.adminQuery<{ datname: string }>(
      'select datname from pg_database where datname = $1',
      [dbName],
    ).catch(() => []);
    if (dbs.length === 0) return null;
    const roles = await this.adminQuery<{ rolname: string }>(
      'select rolname from pg_roles where rolname = $1',
      [dbUser],
    ).catch(() => []);
    if (roles.length === 0) return null;
    const { health } = await checkProjectDbHealth(
      this.projectConn(dbName, dbUser, password),
      3000,
    ).catch(() => ({
      health: 'unavailable' as const,
    }));
    if (health !== 'healthy') return null;
    const admin = new URL(this.connectionString);
    return {
      databaseId: `managed:${dbName}:${dbUser}`,
      host: admin.hostname || 'localhost',
      port: admin.port ? Number(admin.port) : 5432,
      dbName,
      dbUser,
      version: '16',
    };
  }

  async deleteDatabase(databaseId: string): Promise<void> {
    await this.requireAvailable();
    const { dbName, dbUser } = parseHandle(databaseId);
    await this.adminQuery(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [dbName],
    ).catch(() => undefined);
    await this.adminQuery(`DROP DATABASE IF EXISTS "${dbName}"`);
    await this.adminQuery(`DROP ROLE IF EXISTS "${dbUser}"`);
  }

  async startDatabase(databaseId: string): Promise<void> {
    await this.requireAvailable();
    const { dbName } = parseHandle(databaseId);
    await this.adminQuery('update pg_database set datallowconn = true where datname = $1', [
      dbName,
    ]);
  }

  async stopDatabase(databaseId: string): Promise<void> {
    await this.requireAvailable();
    const { dbName } = parseHandle(databaseId);
    await this.adminQuery('update pg_database set datallowconn = false where datname = $1', [
      dbName,
    ]);
    await this.adminQuery(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [dbName],
    ).catch(() => undefined);
  }

  async restartDatabase(databaseId: string): Promise<void> {
    await this.stopDatabase(databaseId);
    await this.startDatabase(databaseId);
  }

  async getStatus(
    databaseId: string,
    conn: { host: string; port: number; database: string; user: string; password: string },
  ): Promise<ProviderStatus> {
    await this.requireAvailable();
    const { dbName } = parseHandle(databaseId);
    const rows = await this.adminQuery<{ datallowconn: boolean }>(
      'select datallowconn from pg_database where datname = $1',
      [dbName],
    );
    if (rows.length === 0) {
      return { status: 'deleted', health: 'unavailable', detail: 'database not found' };
    }
    if (rows[0]?.datallowconn === false) {
      return { status: 'stopped', health: 'unavailable', detail: 'connections disabled' };
    }
    const { health } = await checkProjectDbHealth(conn, 5000).catch(() => ({
      health: 'unavailable' as const,
    }));
    if (health === 'healthy') return { status: 'running', health };
    if (health === 'unavailable')
      return { status: 'running', health, detail: 'pg not accepting yet' };
    return { status: 'running', health };
  }

  async getMetrics(conn: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }): Promise<ProviderMetrics> {
    await this.requireAvailable();
    const m = await getProjectDbMetrics(conn, 10_000).catch(err => {
      throw this.classify(err);
    });
    return { version: m.version, sizeBytes: m.sizeBytes, connectionCount: m.connectionCount };
  }
}
