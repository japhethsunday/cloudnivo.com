import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { checkProjectDbHealth, getProjectDbMetrics } from '@cloudnivo/database';

const execFileAsync = promisify(execFile);
import type {
  DatabaseProvisioner,
  ProvisionedDatabase,
  ProvisionRequest,
  ProviderMetrics,
  ProviderStatus,
} from './provisioner.js';
import { ProviderUnavailableError, ProvisionerError } from './provisioner.js';
import {
  assertContainerName,
  assertDbPassword,
  assertImageVersion,
  assertSlug,
  containerNameFor,
  dbNameFor,
  dbUserFor,
} from './validation.js';

export interface DockerProviderOptions {
  image?: string;
  network?: string;
  basePort?: number;
  healthTimeoutMs?: number;
  /**
   * loopback (default): reach DBs via 127.0.0.1:mapped-port — for host-run API.
   * container: reach DBs via container-name:5432 — for containerized API on
   * the same Docker network (compose `api` service, Railway private net).
   */
  hostMode?: 'loopback' | 'container';
}

const DOCKER_TIMEOUT_MS = 60_000;

function classifyDockerError(err: unknown): ProvisionerError {
  const msg = err instanceof Error ? err.message : String(err);
  const clean = msg.replace(/POSTGRES_PASSWORD=[^\s]*/g, 'POSTGRES_PASSWORD=•••').slice(0, 300);
  if (/ENOENT|not found|command not found|Cannot connect to the Docker/i.test(msg)) {
    return new ProviderUnavailableError(`Docker unavailable: ${clean}`);
  }
  if (/port is already allocated|address already in use/i.test(msg)) {
    return new ProvisionerError(`Host port collision: ${clean}`, true);
  }
  if (/No such container|No such image|not found/i.test(msg)) {
    return new ProvisionerError(clean, false);
  }
  return new ProvisionerError(clean, true);
}

async function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (err) {
    throw classifyDockerError(err);
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(true);
    });
  });
}

/**
 * Local Docker implementation of `DatabaseProvisioner`.
 * One `postgres:16-alpine` container per project database, bound to
 * 127.0.0.1 only, labeled for ownership. All docker invocations use
 * `execFile` (argv, never a shell) with allow-listed identifiers.
 */
export class DockerDatabaseProvider implements DatabaseProvisioner {
  readonly provider = 'docker';
  private readonly image: string;
  private readonly network: string;
  private readonly basePort: number;
  private readonly healthTimeoutMs: number;
  private readonly hostMode: 'loopback' | 'container';
  private dockerChecked = false;
  private dockerOk = false;

  constructor(opts: DockerProviderOptions = {}) {
    this.image = opts.image ?? 'postgres:16-alpine';
    this.network = opts.network ?? 'cloudnivo';
    this.basePort = opts.basePort ?? 15432;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;
    this.hostMode = opts.hostMode ?? 'loopback';
  }

  /** Connection endpoint for a container, per host mode. */
  private endpoint(container: string, mappedPort: number): { host: string; port: number } {
    return this.hostMode === 'container'
      ? { host: container, port: 5432 }
      : { host: '127.0.0.1', port: mappedPort };
  }

  async isAvailable(): Promise<boolean> {
    if (this.dockerChecked) return this.dockerOk;
    try {
      await docker(['version', '--format', '{{.Server.Version}}'], 10_000);
      this.dockerOk = true;
    } catch {
      this.dockerOk = false;
    }
    this.dockerChecked = true;
    return this.dockerOk;
  }

  private async requireDocker(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new ProviderUnavailableError('Docker engine is not reachable');
    }
  }

  async createDatabase(req: ProvisionRequest): Promise<ProvisionedDatabase> {
    await this.requireDocker();
    assertSlug(req.slug);
    assertDbPassword(req.password);
    assertImageVersion(req.version);
    const container = containerNameFor(req.slug, randomBytes(4).toString('hex'));
    const dbName = dbNameFor(req.slug);
    const dbUser = dbUserFor(req.slug);
    const image =
      req.version === '16'
        ? this.image
        : `postgres:${req.version.endsWith('-alpine') ? req.version : `${req.version}-alpine`}`;

    // Idempotency: a previous attempt may have created the container already.
    const existing = await this.findByProject(req.projectId);
    if (existing) return existing;

    let port = this.basePort;
    for (let i = 0; i < 500; i += 1) {
      if (await isPortFree(port)) break;
      port += 1;
      if (i === 499) throw new ProvisionerError('No free host port for database', true);
    }
    const volume = `${container}-data`;
    await docker([
      'run',
      '-d',
      '--name',
      container,
      '--network',
      this.network,
      '--restart',
      'unless-stopped',
      '-e',
      `POSTGRES_DB=${dbName}`,
      '-e',
      `POSTGRES_USER=${dbUser}`,
      '-e',
      `POSTGRES_PASSWORD=${req.password}`,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-v',
      `${volume}:/var/lib/postgresql/data`,
      '--label',
      'cloudnivo.managed=true',
      '--label',
      `cloudnivo.project=${req.projectId}`,
      '--label',
      `cloudnivo.org=${req.organizationId}`,
      image,
    ]);
    const conn = {
      ...this.endpoint(container, port),
      database: dbName,
      user: dbUser,
      password: req.password,
    };
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      const { health } = await checkProjectDbHealth(conn, 3000);
      if (health === 'healthy') break;
      if (Date.now() > deadline) {
        await docker(['rm', '-f', container]).catch(() => undefined);
        throw new ProvisionerError('Database did not become healthy in time', true);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    return {
      databaseId: container,
      ...this.endpoint(container, port),
      dbName,
      dbUser,
      version: req.version,
    };
  }

  /** Find a live container previously created for this project (crash recovery). */
  private async findByProject(projectId: string): Promise<ProvisionedDatabase | null> {
    const out = await docker([
      'ps',
      '-a',
      '--filter',
      'label=cloudnivo.managed=true',
      '--filter',
      `label=cloudnivo.project=${projectId}`,
      '--format',
      '{{.Names}}',
    ]).catch(() => '');
    const name = out
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)[0];
    if (!name) return null;
    return this.describe(assertContainerName(name));
  }

  private async describe(container: string): Promise<ProvisionedDatabase> {
    const [portOut, envOut] = await Promise.all([
      docker(['port', container, '5432/tcp']),
      docker(['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', container]).catch(
        () => '',
      ),
    ]);
    const m = /127\.0\.0\.1:(\d+)/.exec(portOut);
    const env = Object.fromEntries(
      envOut
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.includes('='))
        .map(l => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
    );
    const mappedPort = m?.[1] ? Number(m[1]) : this.basePort;
    return {
      databaseId: container,
      ...this.endpoint(container, mappedPort),
      dbName: env['POSTGRES_DB'] || 'app',
      dbUser: env['POSTGRES_USER'] || 'app',
      version: '16',
    };
  }

  async deleteDatabase(databaseId: string): Promise<void> {
    await this.requireDocker();
    const container = assertContainerName(databaseId);
    await docker(['rm', '-f', container]);
    await docker(['volume', 'rm', `${container}-data`]).catch(() => undefined);
  }

  async startDatabase(databaseId: string): Promise<void> {
    await this.requireDocker();
    await docker(['start', assertContainerName(databaseId)]);
  }

  async stopDatabase(databaseId: string): Promise<void> {
    await this.requireDocker();
    await docker(['stop', '-t', '10', assertContainerName(databaseId)]);
  }

  async restartDatabase(databaseId: string): Promise<void> {
    await this.requireDocker();
    await docker(['restart', '-t', '10', assertContainerName(databaseId)]);
  }

  async getStatus(
    databaseId: string,
    conn: { host: string; port: number; database: string; user: string; password: string },
  ): Promise<ProviderStatus> {
    await this.requireDocker();
    const container = assertContainerName(databaseId);
    let state = '';
    try {
      state = await docker(['inspect', '-f', '{{.State.Status}}', container], 10_000);
    } catch (err) {
      if (err instanceof ProvisionerError && !err.recoverable) {
        return { status: 'deleted', health: 'unavailable', detail: 'container not found' };
      }
      throw err;
    }
    if (state === 'exited' || state === 'created') {
      return { status: 'stopped', health: 'unavailable', detail: `container ${state}` };
    }
    if (state === 'restarting' || state === 'paused') {
      return { status: 'restarting', health: 'starting', detail: `container ${state}` };
    }
    if (state === 'dead' || state === 'removing') {
      return { status: 'failed', health: 'unhealthy', detail: `container ${state}` };
    }
    const { health } = await checkProjectDbHealth(conn, 5000);
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
    await this.requireDocker();
    const m = await getProjectDbMetrics(conn, 10_000);
    return { version: m.version, sizeBytes: m.sizeBytes, connectionCount: m.connectionCount };
  }
}
