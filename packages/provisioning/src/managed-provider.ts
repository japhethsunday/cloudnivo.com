import {
  checkProjectDbHealth,
  getProjectDbMetrics,
  queryProjectDb,
  type ProjectConnectionInfo,
} from '@cloudnivo/database';
import type {
  CloneRequest,
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
  quoteLiteral,
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
 *   the password travels as a `$1` bind parameter wherever the server accepts
 *   one; `CREATE ROLE ... PASSWORD` accepts no parameters, so that single
 *   statement uses an escaped literal (see quoteLiteral).
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

  /**
   * Close a freshly created database to everyone except its owner.
   *
   * Postgres grants CONNECT on every new database to PUBLIC, and a grant held
   * through PUBLIC is not removed by revoking from a role — which is why the
   * previous `REVOKE ALL ... FROM "<role>"` left every project role able to
   * open every other project's database and the control database. Revoke from
   * PUBLIC, then grant back only the owner (and the admin connection, so the
   * control plane never locks itself out).
   */
  private async lockDownDatabase(dbName: string, owner: string): Promise<void> {
    await this.adminQuery(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
    await this.adminQuery(`GRANT ALL ON DATABASE "${dbName}" TO "${owner}"`);
    await this.adminQuery(
      `GRANT CONNECT ON DATABASE "${dbName}" TO CURRENT_USER`,
    ).catch(() => undefined);
  }

  /**
   * Same treatment for the control database: PUBLIC must not hold CONNECT on
   * the database that stores platform users, sessions and SSO secrets.
   * Idempotent, and the admin role keeps its own access explicitly.
   */
  private async lockDownControlDb(): Promise<boolean> {
    await this.adminQuery(
      `GRANT CONNECT ON DATABASE "${this.controlDb}" TO CURRENT_USER`,
    ).catch(() => undefined);
    const revoked = await this.adminQuery(
      `REVOKE CONNECT ON DATABASE "${this.controlDb}" FROM PUBLIC`,
    )
      .then(() => true)
      .catch(() => false);
    // Report the real state rather than the attempt: a silent failure here
    // leaves every project role able to open the control database.
    const rows = await this.adminQuery<{ open: boolean }>(
      `SELECT has_database_privilege('public', $1, 'CONNECT') AS open`,
      [this.controlDb],
    ).catch(() => null);
    const open = rows?.[0]?.open;
    return revoked && open === false;
  }

  /**
   * Repair databases provisioned before the PUBLIC-grant lockdown existed.
   *
   * Idempotent and safe to run on every boot: it only revokes the PUBLIC
   * grants Postgres adds by default and re-grants the database to its own
   * owner, so a correctly locked database is left exactly as it is.
   */
  async hardenExistingDatabases(): Promise<{
    checked: number;
    hardened: number;
    controlDbClosed: boolean;
    skipped: string[];
  }> {
    const controlDbClosed = await this.lockDownControlDb().catch(() => false);
    const rows = await this.adminQuery<{ datname: string; owner: string }>(
      `SELECT d.datname AS datname, pg_get_userbyid(d.datdba) AS owner
         FROM pg_database d
        WHERE NOT d.datistemplate
          AND d.datname <> $1
          AND has_database_privilege('public', d.datname, 'CONNECT')`,
      [this.controlDb],
    ).catch(() => []);
    let hardened = 0;
    const skipped: string[] = [];
    for (const row of rows) {
      // Only databases this provisioner owns follow the managed handle shape.
      // Anything else (the platform's own maintenance databases) is named so
      // an operator can see what was left open instead of guessing.
      if (
        !/^[a-z][a-z0-9_]*$/.test(row.datname) ||
        !/^[a-z][a-z0-9_]*$/.test(row.owner) ||
        !row.datname.startsWith('cn_')
      ) {
        if (skipped.length < 20) skipped.push(row.datname);
        continue;
      }
      await this.lockDownDatabase(row.datname, row.owner)
        .then(() => {
          hardened += 1;
        })
        .catch(() => undefined);
    }
    return { checked: rows.length, hardened, controlDbClosed, skipped };
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

    await this.adminQuery(
      `CREATE ROLE "${dbUser}" WITH LOGIN PASSWORD ${quoteLiteral(req.password)}`,
    );
    try {
      await this.adminQuery(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
    } catch (err) {
      await this.adminQuery(`DROP ROLE IF EXISTS "${dbUser}"`).catch(() => undefined);
      throw err;
    }
    // Lockdown: the project role sees ONLY its own database.
    await this.adminQuery(`REVOKE ALL ON DATABASE "${this.controlDb}" FROM "${dbUser}"`);
    await this.lockDownDatabase(dbName, dbUser);
    await this.lockDownControlDb();

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

  /**
   * Branch clone via TEMPLATE copy on the shared server. Terminates other
   * backends on the source first (TEMPLATE requires zero sessions), copies
   * with the project role as owner so grants travel with the data, and
   * re-applies the control-DB lockdown.
   */
  async cloneDatabase(req: CloneRequest): Promise<ProvisionedDatabase> {
    await this.requireAvailable();
    const source = parseHandle(req.sourceDatabaseId);
    assertSlug(req.branch);
    assertDbPassword(req.target.password);
    const branchDb = assertPostgresIdent(`${source.dbName}__${req.branch.replace(/-/g, '_')}`, 'Branch database');
    const dbUser = source.dbUser;
    const databaseId = `managed:${branchDb}:${dbUser}`;
    const existing = await this.describeIfExists(branchDb, dbUser, req.target.password);
    if (existing) return existing;
    // TEMPLATE needs no other sessions on the source (never our own pid).
    await this.adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [source.dbName],
    );
    try {
      await this.adminQuery(`CREATE DATABASE "${branchDb}" TEMPLATE "${source.dbName}" OWNER "${dbUser}"`);
    } catch (err) {
      throw this.classify(err);
    }
    await this.adminQuery(`REVOKE ALL ON DATABASE "${this.controlDb}" FROM "${dbUser}"`).catch(() => undefined);
    await this.lockDownDatabase(branchDb, dbUser).catch(() => undefined);
    await this.lockDownControlDb();
    const conn = this.projectConn(branchDb, dbUser, req.target.password);
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      const { health } = await checkProjectDbHealth(conn, 3000).catch(() => ({
        health: 'unavailable' as const,
      }));
      if (health === 'healthy') break;
      if (Date.now() > deadline) {
        await this.deleteDatabase(databaseId).catch(() => undefined);
        throw new ProvisionerError('Branch database did not become healthy in time', true);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    const admin = new URL(this.connectionString);
    return {
      databaseId,
      host: admin.hostname || 'localhost',
      port: admin.port ? Number(admin.port) : 5432,
      dbName: branchDb,
      dbUser,
      version: req.target.version,
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
