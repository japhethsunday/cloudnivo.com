import { describe, expect, it } from 'vitest';
import { createDatabaseService, organizations, users } from '@cloudnivo/database';
import { DrizzleActivityStore, DrizzleAgentTokenStore, DrizzleApprovalStore } from './store-drizzle.js';
import { AgentService } from './service.js';
import { MemoryActivityStore, MemoryApprovalStore, MemoryAgentTokenStore } from './index.js';

// Live round-trip against real PostgreSQL (migrated control schema).
// Runs only with LIVE_PG_URL set — same convention as the billing live test.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('agents drizzle stores on live postgres', () => {
  it('persists tokens, approvals, and activity with real foreign keys', async () => {
    const svc = createDatabaseService(LIVE_PG_URL);
    try {
      const stamp = Date.now() % 1000000;
      const [user] = await svc.db
        .insert(users)
        .values({ email: `agent-live-${stamp}@example.com`, passwordHash: 'x', displayName: null })
        .returning();
      if (!user) throw new Error('user insert failed');
      const [org] = await svc.db
        .insert(organizations)
        .values({ name: `live-${stamp}`, slug: `live-${stamp}`, createdBy: user.id })
        .returning();
      if (!org) throw new Error('org insert failed');

      const service = new AgentService(
        new DrizzleAgentTokenStore(svc.db),
        new DrizzleApprovalStore(svc.db),
        new DrizzleActivityStore(svc.db),
      );
      const { token, raw } = await service.createToken({
        userId: user.id,
        organizationId: org.id,
        name: 'live',
        scopes: ['projects.read'],
        projectIds: [],
      });
      expect(raw.startsWith('cn_agent_')).toBe(true);
      expect((await service.verifyToken(raw)).id).toBe(token.id);
      expect(token.id).toMatch(/^[0-9a-f-]{36}$/);

      const req = await service.requestApproval({
        organizationId: org.id,
        projectId: null,
        token: await service.verifyToken(raw),
        action: 'project.delete',
        method: 'DELETE',
        path: '/api/v1/projects/p1',
        body: undefined,
      });
      expect((await service.decideApproval(req.id, 'approved')).status).toBe('approved');
      const consumed = await service.consumeApproval({
        approvalId: req.id,
        token: await service.verifyToken(raw),
        method: 'DELETE',
        path: '/api/v1/projects/p1',
        body: undefined,
      });
      expect(consumed.status).toBe('consumed');

      await service.log({
        tokenId: token.id,
        userId: user.id,
        organizationId: org.id,
        projectId: null,
        action: 'test.ping',
        result: 'success',
      });
      const entries = await service.listActivity({ tokenId: token.id });
      expect(entries.length).toBeGreaterThan(0);

      await service.revokeToken(token.id, user.id);
      await expect(service.verifyToken(raw)).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });

      // Memory fallback parity for the pure paths.
      const mem = new AgentService(new MemoryAgentTokenStore(), new MemoryApprovalStore(), new MemoryActivityStore());
      expect((await mem.listTokens(user.id)).length).toBe(0);
    } finally {
      await svc.close();
    }
  }, 60_000);
});
