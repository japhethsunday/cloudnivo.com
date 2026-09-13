import { describe, expect, it } from 'vitest';
import { BranchService, MemoryBranchStore } from './branches.js';
import { FakeDatabaseProvider } from './fake.js';

const MAIN = {
  databaseId: 'fake-p1',
  password: 'long-enough-password-1',
  version: '16',
  region: 'local',
  slug: 'shop',
};

function service(provider?: FakeDatabaseProvider): { svc: BranchService; provider: FakeDatabaseProvider } {
  const fake = provider ?? new FakeDatabaseProvider();
  return { svc: new BranchService(new MemoryBranchStore(), fake), provider: fake };
}

describe('branch service', () => {
  it('creates, lists, resets, and deletes branches on the fake provider', async () => {
    const { svc, provider } = service();
    await provider.createDatabase({
      projectId: 'p1',
      organizationId: 'o1',
      slug: 'shop',
      password: MAIN.password,
      version: '16',
      region: 'local',
    });
    const { branch, database } = await svc.createBranch({
      projectId: 'p1',
      organizationId: 'o1',
      name: 'feature-a',
      sourceDatabaseId: null,
      main: MAIN,
    });
    expect(branch.status).toBe('ready');
    expect(branch.source).toBe('main');
    expect(database.dbName).toContain('feature_a');
    expect((await svc.storeRef.listByProject('p1')).map(b => b.name)).toEqual(['feature-a']);
    await expect(
      svc.createBranch({ projectId: 'p1', organizationId: 'o1', name: 'feature-a', sourceDatabaseId: null, main: MAIN }),
    ).rejects.toThrow(/already exists/);
    await expect(
      svc.createBranch({ projectId: 'p1', organizationId: 'o1', name: 'main', sourceDatabaseId: null, main: MAIN }),
    ).rejects.toThrow(/reserved/);
    const { branch: reset } = await svc.resetBranch('p1', branch.id, { password: MAIN.password, main: MAIN });
    expect(reset.status).toBe('ready');
    await svc.deleteBranch('p1', branch.id);
    expect(await svc.storeRef.listByProject('p1')).toEqual([]);
    await expect(svc.deleteBranch('p1', branch.id)).rejects.toThrow(/not found/);
  });

  it('refuses branches when the provider cannot clone', async () => {
    const noClone = { provider: 'none' } as unknown as FakeDatabaseProvider;
    const svc2 = new BranchService(new MemoryBranchStore(), noClone);
    await expect(
      svc2.createBranch({ projectId: 'p1', organizationId: 'o1', name: 'x', sourceDatabaseId: null, main: MAIN }),
    ).rejects.toThrow(/not supported/);
  });
});
