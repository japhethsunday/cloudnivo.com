import { describe, expect, it } from 'vitest';
import { LocalProvisioningService } from './index.js';

describe('provisioning', () => {
  it('plans local infrastructure without cloud calls', async () => {
    const svc = new LocalProvisioningService();
    const plan = await svc.plan({
      projectId: 'p1',
      organizationId: 'org-a',
      environmentSlug: 'development',
      database: { engine: 'postgres', version: '16' },
    });
    expect(plan.storage.driver).toBe('local');
    const op = await svc.apply(plan);
    expect(op.status).toBe('ready');
    expect(await svc.status(op.id)).toEqual(op);
  });
});
