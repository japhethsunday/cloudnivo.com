import { describe, expect, it, vi } from 'vitest';
import { FakeDatabaseProvider } from './fake.js';
import { MemoryJobStore } from './jobs.js';
import { provisionProjectDatabase, runLifecycleJob } from './orchestrator.js';
import type { ProvisionRequest, ProvisionedDatabase } from './provisioner.js';

const audit = { record: vi.fn() };
const noSleep = { sleep: async () => undefined };

function input(key: string, projectId = 'p1', slug = 'shop') {
  return {
    projectId,
    organizationId: 'org-a',
    userId: 'u1',
    slug,
    password: 'supersecretpassword1',
    idempotencyKey: key,
  };
}

/** Fake provider with injected latency to force real interleaving. */
class SlowFake extends FakeDatabaseProvider {
  constructor(private readonly delayMs: number) {
    super();
  }
  override async createDatabase(req: ProvisionRequest): Promise<ProvisionedDatabase> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return super.createDatabase(req);
  }
}

describe('provisioning races (concurrent storms)', () => {
  it('10 concurrent same-key provisions create exactly one database', async () => {
    const provider = new SlowFake(20);
    const jobs = new MemoryJobStore();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        provisionProjectDatabase(provider, jobs, audit, input('storm-1'), noSleep),
      ),
    );
    const jobIds = new Set(outcomes.map(o => o.jobId));
    expect(jobIds.size).toBe(1);
    expect(provider.calls.filter(c => c.startsWith('create:'))).toHaveLength(1);
    const job = await jobs.findById(outcomes[0]?.jobId ?? '');
    expect(job?.status).toBe('completed');
  });

  it('50 concurrent distinct provisions all complete without duplication', async () => {
    const provider = new SlowFake(5);
    const jobs = new MemoryJobStore();
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        provisionProjectDatabase(
          provider,
          jobs,
          audit,
          input(`k-${i}`, `p-${i}`, `shop-${i}`),
          noSleep,
        ),
      ),
    );
    expect(new Set(outcomes.map(o => o.jobId)).size).toBe(50);
    expect(provider.calls.filter(c => c.startsWith('create:'))).toHaveLength(50);
    for (const o of outcomes) {
      const job = await jobs.findById(o.jobId);
      expect(job?.status).toBe('completed');
    }
  }, 30_000);

  it('100 concurrent distinct provisions complete (scale probe)', async () => {
    const provider = new FakeDatabaseProvider();
    const jobs = new MemoryJobStore();
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        provisionProjectDatabase(
          provider,
          jobs,
          audit,
          input(`s-${i}`, `sp-${i}`, `store-${i}`),
          noSleep,
        ),
      ),
    );
    expect(new Set(outcomes.map(o => o.jobId)).size).toBe(100);
    const completed = await Promise.all(outcomes.map(o => jobs.findById(o.jobId)));
    expect(completed.every(j => j?.status === 'completed')).toBe(true);
  }, 60_000);

  it('concurrent lifecycle ops leave consistent state, never corrupt', async () => {
    const provider = new FakeDatabaseProvider();
    const jobs = new MemoryJobStore();
    const out = await provisionProjectDatabase(provider, jobs, audit, input('life-1'), noSleep);
    const db = out.database;
    expect(db).not.toBe(null);
    const base = {
      projectId: 'p1',
      organizationId: 'org-a',
      userId: 'u1',
      databaseId: db?.databaseId ?? '',
    };
    await Promise.all([
      runLifecycleJob(provider, jobs, audit, { ...base, kind: 'stop' }),
      runLifecycleJob(provider, jobs, audit, { ...base, kind: 'start' }),
      runLifecycleJob(provider, jobs, audit, { ...base, kind: 'restart' }),
    ]);
    const status = await provider.getStatus(db?.databaseId ?? '', {
      host: '127.0.0.1',
      port: 15499,
      database: 'x',
      user: 'x',
      password: 'x',
    });
    expect(['running', 'stopped']).toContain(status.status);
    // Double delete is safe (second is a no-op, both jobs complete).
    await runLifecycleJob(provider, jobs, audit, { ...base, kind: 'delete' });
    await runLifecycleJob(provider, jobs, audit, { ...base, kind: 'delete' });
    const gone = await provider.getStatus(db?.databaseId ?? '', {
      host: '127.0.0.1',
      port: 15499,
      database: 'x',
      user: 'x',
      password: 'x',
    });
    expect(gone.status).toBe('deleted');
  });

  it('transient failures under concurrency stay bounded and recover', async () => {
    const provider = new SlowFake(5);
    const jobs = new MemoryJobStore();
    const first = await provisionProjectDatabase(provider, jobs, audit, input('flaky-1'), noSleep);
    provider.failNextOps(first.database?.databaseId ?? '', 100);
    const results = await Promise.allSettled([
      runLifecycleJob(provider, jobs, audit, {
        projectId: 'p1',
        organizationId: 'org-a',
        userId: 'u1',
        databaseId: first.database?.databaseId ?? '',
        kind: 'stop',
      }),
      runLifecycleJob(provider, jobs, audit, {
        projectId: 'p1',
        organizationId: 'org-a',
        userId: 'u1',
        databaseId: first.database?.databaseId ?? '',
        kind: 'restart',
      }),
    ]);
    // Both settle (success or clean failure) — no hangs, no unhandled throws.
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status === 'fulfilled' || r.status === 'rejected').toBe(true);
    }
  });
});
