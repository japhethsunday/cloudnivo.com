import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';
import { loadConfig } from '@cloudnivo/config';
import { createContext, initControlPlane } from './v1.js';
import { MemoryRegistry } from './registry.js';

const JWT_SECRET = 'r'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    JWT_SECRET,
    CORS_ORIGINS: 'http://localhost:3000',
    CACHE_DRIVER: 'memory',
    PROVISION_DRIVER: 'fake',
  };
}

async function bootServer(): Promise<{ base: string; close: () => Promise<void> }> {
  for (const [k, v] of Object.entries(baseEnv())) process.env[k] = v;
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

describe('phase 10 reliability (failure paths + recovery)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const b = await bootServer();
    base = b.base;
    close = b.close;
  });

  afterAll(async () => {
    await close();
  });

  it('initControlPlane fails fast on unreachable control DB (no hang, memory intact)', async () => {
    const config = loadConfig({
      ...baseEnv(),
      NODE_ENV: 'development',
      CONTROL_STORE: 'drizzle',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
    });
    const ctx = createContext(config);
    await expect(initControlPlane(ctx)).rejects.toThrow('Control database unreachable');
    expect(ctx.registry).toBeInstanceOf(MemoryRegistry);
    expect(ctx.controlDb).toBe(null);
  }, 30_000);

  it('initControlPlane is a no-op in test env even when drizzle is configured', async () => {
    const config = loadConfig({ ...baseEnv(), CONTROL_STORE: 'drizzle' });
    const ctx = createContext(config);
    await initControlPlane(ctx);
    expect(ctx.registry).toBeInstanceOf(MemoryRegistry);
    expect(ctx.controlDb).toBe(null);
  });

  it('restart recovers honestly: healthy, fresh state, old IDs 404 (never 500)', async () => {
    const token = await signSession(
      { sub: USER_A, email: `${USER_A}@example.com` },
      { jwtSecret: JWT_SECRET },
    );
    const org = await (
      await fetch(`${base}/api/v1/organizations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rec', slug: 'rec' }),
      })
    ).json();
    const orgId = (org as { data: { organization: { id: string } } }).data.organization.id;
    const p = await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rec', slug: 'rec', organizationId: orgId }),
      })
    ).json();
    const oldProjectId = (p as { data: { project: { id: string } } }).data.project.id;

    await close();
    const b = await bootServer();
    base = b.base;
    close = b.close;

    const health = await fetch(`${base}/api/v1/health/ready`);
    expect(health.status).toBe(200);
    // Same secret verifies the old JWT, but the rebooted memory store has no
    // such project: honest 404, never a 500 or leaked data.
    const gone = await fetch(`${base}/api/v1/projects/${oldProjectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(gone.status).toBe(404);
    const me = await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(401);
  }, 30_000);
});
