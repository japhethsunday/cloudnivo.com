import { describe, expect, it, vi } from 'vitest';
import { FakeDatabaseProvider } from './fake.js';
import { MemoryJobStore, backoffMs, shouldRetry } from './jobs.js';
import { provisionProjectDatabase, runLifecycleJob } from './orchestrator.js';
import { ProvisionerError } from './provisioner.js';
import { assertSlug, containerNameFor, dbNameFor, dbUserFor } from './validation.js';

const audit = { record: vi.fn() };

function input(key = 'key-1') {
  return {
    projectId: 'p1',
    organizationId: 'org-a',
    userId: 'u1',
    slug: 'shop',
    password: 'supersecretpassword1',
    idempotencyKey: key,
  };
}

describe('provisioning validation (anti-injection)', () => {
  it('accepts slugs, rejects shell metacharacters', () => {
    expect(assertSlug('my-project-1')).toBe('my-project-1');
    for (const bad of ['a; rm -rf /', '$(whoami)', 'x`y`', '../etc', 'A_B', 'x']) {
      expect(() => assertSlug(bad)).toThrow();
    }
  });

  it('derives safe pg identifiers and container handles', () => {
    expect(dbNameFor('my-shop')).toBe('cn_my_shop_db');
    expect(dbUserFor('my-shop')).toBe('cn_my_shop_u');
    expect(containerNameFor('my-shop', 'abcdef12')).toBe('cn-my-shop-abcdef12');
    expect(() => containerNameFor('ok-slug', 'not-hex!')).toThrow();
  });
});

describe('job store', () => {
  it('collapses duplicate idempotency keys (no duplicate databases)', async () => {
    const store = new MemoryJobStore();
    const base = {
      projectId: 'p1',
      organizationId: 'o1',
      kind: 'provision' as const,
      status: 'running' as const,
      idempotencyKey: 'k',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      logs: [],
    };
    const a = await store.create(base);
    const b = await store.create({ ...base, projectId: 'p2' });
    expect(b.id).toBe(a.id);
    expect(b.projectId).toBe('p1');
  });

  it('lists jobs by status oldest-first with a bounded limit', async () => {
    const store = new MemoryJobStore();
    const base = {
      projectId: 'p1',
      organizationId: 'o1',
      kind: 'provision' as const,
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      logs: [],
    };
    await store.create({ ...base, status: 'completed', idempotencyKey: 'a' });
    const pending = await store.create({ ...base, status: 'pending', idempotencyKey: 'b' });
    const listed = await store.listByStatus('pending');
    expect(listed.map(j => j.id)).toEqual([pending.id]);
    expect(await store.listByStatus('pending', 0)).toHaveLength(1);
    expect(await store.listByStatus('failed')).toEqual([]);
  });

  it('retries only recoverable failures within budget', () => {
    expect(shouldRetry(1, 3, true)).toBe(true);
    expect(shouldRetry(3, 3, true)).toBe(false);
    expect(shouldRetry(1, 3, false)).toBe(false);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(99)).toBe(30_000);
  });
});

describe('orchestrator (fake provider)', () => {
  it('provisions to completed + audits start/complete', async () => {
    const provider = new FakeDatabaseProvider();
    const jobs = new MemoryJobStore();
    const out = await provisionProjectDatabase(provider, jobs, audit, input(), {
      sleep: async () => undefined,
    });
    expect(out.deduplicated).toBe(false);
    expect(out.database?.databaseId).toBe('fake-p1');
    const job = await jobs.findById(out.jobId);
    expect(job?.status).toBe('completed');
    expect(audit.record).toHaveBeenCalledWith(
      'database.provisioning.started',
      expect.objectContaining({ projectId: 'p1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      'database.provisioning.completed',
      expect.objectContaining({ projectId: 'p1' }),
    );
  });

  it('duplicate request returns live job without new infra call', async () => {
    const provider = new FakeDatabaseProvider();
    const jobs = new MemoryJobStore();
    const first = await provisionProjectDatabase(provider, jobs, audit, input('dup'), {
      sleep: async () => undefined,
    });
    const second = await provisionProjectDatabase(provider, jobs, audit, input('dup'), {
      sleep: async () => undefined,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(provider.calls.filter(c => c.startsWith('create:'))).toHaveLength(1);
  });

  it('retries transient create failures then succeeds', async () => {
    const inner = new FakeDatabaseProvider();
    let calls = 0;
    const flaky: FakeDatabaseProvider = Object.create(inner);
    flaky.createDatabase = async req => {
      calls += 1;
      if (calls < 3) throw new ProvisionerError('transient: registry busy', true);
      return inner.createDatabase(req);
    };
    flaky.getStatus = inner.getStatus.bind(inner);
    const jobs = new MemoryJobStore();
    const out = await provisionProjectDatabase(flaky, jobs, audit, input('retry-ok'), {
      sleep: async () => undefined,
    });
    expect(out.database?.databaseId).toBe('fake-p1');
    expect(calls).toBe(3);
    const job = await jobs.findById(out.jobId);
    expect(job?.status).toBe('completed');
    expect(job?.attempts).toBe(3);
  });

  it('marks failed + audits when provider permanently fails', async () => {
    const failing = new FakeDatabaseProvider();
    failing.createDatabase = async () => {
      throw new ProvisionerError('permanent: bad image', false);
    };
    const jobs = new MemoryJobStore();
    await expect(
      provisionProjectDatabase(failing, jobs, audit, input('fail-1'), {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/permanent/);
    const job = await jobs.findByKey('org-a', 'fail-1');
    expect(job?.status).toBe('failed');
    expect(audit.record).toHaveBeenCalledWith(
      'database.provisioning.failed',
      expect.objectContaining({ projectId: 'p1' }),
    );
  });

  it('runs lifecycle jobs (stop/start/delete)', async () => {
    const provider = new FakeDatabaseProvider();
    const jobs = new MemoryJobStore();
    const out = await provisionProjectDatabase(provider, jobs, audit, input('life-1'), {
      sleep: async () => undefined,
    });
    const id = out.database?.databaseId ?? '';
    await runLifecycleJob(provider, jobs, audit, {
      kind: 'stop',
      projectId: 'p1',
      organizationId: 'org-a',
      userId: 'u1',
      databaseId: id,
    });
    expect((await provider.getStatus(id, {} as never)).status).toBe('stopped');
    await runLifecycleJob(provider, jobs, audit, {
      kind: 'delete',
      projectId: 'p1',
      organizationId: 'org-a',
      userId: 'u1',
      databaseId: id,
    });
    expect((await provider.getStatus(id, {} as never)).status).toBe('deleted');
  });
});
