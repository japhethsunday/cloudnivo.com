import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@cloudnivo/config';
import { createContext } from './v1.js';
import { drainOnce, startWorker } from './worker.js';
import type { ApiContext } from './v1.js';

const FUTURE = Date.now() + 10 * 60_000;

function testCtx(): ApiContext {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = 'w'.repeat(48);
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  const config = loadConfig();
  return createContext(config);
}

async function seedProject(
  ctx: ApiContext,
): Promise<{ projectId: string; organizationId: string }> {
  const { org } = await ctx.registry.createOrganization('u1', 'W Org', 'w-org');
  const project = await ctx.registry.createProject({
    userId: 'u1',
    organizationId: org.id,
    name: 'W Shop',
    slug: 'w-shop',
    region: 'local',
  });
  return { projectId: project.id, organizationId: org.id };
}

describe('background worker orphan drain', () => {
  let storageDir = '';

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'cn-worker-'));
    process.env.STORAGE_LOCAL_DIR = storageDir;
  });

  afterAll(async () => {
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('reaps stale provision jobs as safely-retryable failures', async () => {
    const ctx = testCtx();
    const { projectId, organizationId } = await seedProject(ctx);
    const stale = await ctx.jobs.create({
      projectId,
      organizationId,
      kind: 'provision',
      status: 'pending',
      idempotencyKey: 'k-stale',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      logs: [],
    });
    const fresh = await ctx.jobs.create({
      projectId,
      organizationId,
      kind: 'provision',
      status: 'pending',
      idempotencyKey: 'k-fresh',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      logs: [],
    });
    // Fresh job is untouched at real time...
    expect((await drainOnce(ctx)).reaped).toBe(0);
    // ...but visible as orphaned from the future.
    const result = await drainOnce(ctx, FUTURE);
    expect(result.reaped).toBe(2);
    const reaped = await ctx.jobs.findById(stale.id);
    expect(reaped?.status).toBe('failed');
    expect(reaped?.lastError ?? '').toContain('Safe to retry');
    // Idempotency key is reusable after the reap.
    const retry = await ctx.jobs.create({
      projectId,
      organizationId,
      kind: 'provision',
      status: 'pending',
      idempotencyKey: 'k-stale',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      logs: [],
    });
    expect(retry.id).not.toBe(stale.id);
    expect((await ctx.jobs.findById(fresh.id))?.status).toBe('failed');
  });

  it('resumes stale delete jobs against live infrastructure', async () => {
    const ctx = testCtx();
    const { projectId, organizationId } = await seedProject(ctx);
    await ctx.registry.saveDatabase({
      projectId,
      organizationId,
      databaseId: 'fake-db-1',
      host: '127.0.0.1',
      port: 15499,
      dbName: 'cn_w_shop_db',
      dbUser: 'cn_w_shop_u',
      version: '16',
      region: 'local',
      status: 'ready',
    });
    const job = await ctx.jobs.create({
      projectId,
      organizationId,
      kind: 'delete',
      status: 'pending',
      idempotencyKey: null,
      attempts: 0,
      maxAttempts: 1,
      lastError: null,
      logs: [],
    });
    const result = await drainOnce(ctx, FUTURE);
    expect(result.resumed).toBe(1);
    expect((await ctx.jobs.findById(job.id))?.status).toBe('completed');
    expect(await ctx.registry.getProject(projectId)).toBe(null);
  });

  it('fails stale jobs with missing records honestly (no fake success)', async () => {
    const ctx = testCtx();
    const { projectId, organizationId } = await seedProject(ctx);
    const job = await ctx.jobs.create({
      projectId,
      organizationId,
      kind: 'stop',
      status: 'retrying',
      idempotencyKey: null,
      attempts: 2,
      maxAttempts: 3,
      lastError: 'boom',
      logs: [],
    });
    const result = await drainOnce(ctx, FUTURE);
    expect(result.failed).toBe(1);
    const failed = await ctx.jobs.findById(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError ?? '').toContain('manual');
  });

  it('starts, serves health, and shuts down gracefully', async () => {
    const handle = await startWorker(0);
    try {
      const live = await fetch(`http://127.0.0.1:${handle.port}/api/v1/health/live`);
      expect(live.status).toBe(200);
      const ready = await fetch(`http://127.0.0.1:${handle.port}/api/v1/health/ready`);
      expect(ready.status).toBe(200);
      const missing = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await handle.close();
    }
  }, 30_000);
});
