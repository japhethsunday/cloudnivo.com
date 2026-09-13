import type { DatabaseHealth, DatabaseStatus } from '@cloudnivo/database';

/**
 * DatabaseProvisioner — the infrastructure adapter boundary.
 *
 * Business logic (orchestrator, API, dashboard) programs against this
 * interface. `DockerDatabaseProvider` is the local implementation; future
 * `VpsDatabaseProvider` / `CloudDatabaseProvider` / `KubernetesDatabaseProvider`
 * slot in without touching the control plane.
 *
 * Rules for every implementation:
 * - No shell string interpolation — safe process APIs + validated names only.
 * - Status comes from REAL infrastructure (container runtime + pg probe),
 *   never invented. When infra is unreachable, throw `ProviderUnavailableError`.
 * - Errors carry `recoverable: boolean` so the job system retries only what
 *   can succeed later. Messages never include passwords.
 */

export interface ProvisionRequest {
  projectId: string;
  organizationId: string;
  slug: string;
  /** User-supplied or server-generated. Never logged. */
  password: string;
  version: string;
  region: string;
}

export interface CloneRequest {
  /** Source provider handle (databaseId of main or another branch). */
  sourceDatabaseId: string;
  /** Source password when socket-trust is unavailable (env-only, never logged). */
  sourcePassword?: string;
  /** New database request (fresh slug/password for the branch). */
  target: ProvisionRequest;
  /** Branch name for handles/labels. Validated slug-shaped. */
  branch: string;
}

export interface ProvisionedDatabase {
  /** Provider handle, e.g. Docker container name. Opaque to callers. */
  databaseId: string;
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
  version: string;
}

export interface ProviderStatus {
  status: DatabaseStatus;
  health: DatabaseHealth;
  detail?: string;
}

export interface ProviderMetrics {
  version: string;
  sizeBytes: number;
  connectionCount: number;
}

export interface DatabaseProvisioner {
  readonly provider: string;
  createDatabase(req: ProvisionRequest): Promise<ProvisionedDatabase>;
  deleteDatabase(databaseId: string): Promise<void>;
  startDatabase(databaseId: string): Promise<void>;
  stopDatabase(databaseId: string): Promise<void>;
  restartDatabase(databaseId: string): Promise<void>;
  /**
   * Clone a database for branching (copy-on-write where the engine
   * supports it, dump/restore otherwise). Optional: providers without a
   * safe clone path omit it and branches report unsupported.
   */
  cloneDatabase?(req: CloneRequest): Promise<ProvisionedDatabase>;
  getStatus(
    databaseId: string,
    conn: { host: string; port: number; database: string; user: string; password: string },
  ): Promise<ProviderStatus>;
  getMetrics(conn: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }): Promise<ProviderMetrics>;
}

export class ProvisionerError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable = false) {
    super(message);
    this.name = 'ProvisionerError';
    this.recoverable = recoverable;
  }
}

export class ProviderUnavailableError extends ProvisionerError {
  constructor(message = 'Database infrastructure is unavailable') {
    super(message, true);
    this.name = 'ProviderUnavailableError';
  }
}
