import { describe, expect, it } from 'vitest';
import { createDatabaseService, organizations, users } from '@cloudnivo/database';
import { AIAuditLog, AIUsageTracker, PlanStore } from './index.js';
import { DrizzleAIJournal } from './store-drizzle.js';

// Live journal round-trip against real PostgreSQL (migrated control schema
// incl. migration 0008 ai_* tables). Runs only with LIVE_PG_URL set — same
// convention as the agents live test.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('ai drizzle journal on live postgres', () => {
  it('journals plans, audits, and usage; rehydrates with tenant isolation', async () => {
    const svc = createDatabaseService(LIVE_PG_URL);
    try {
      const stamp = Date.now() % 1000000;
      const [user] = await svc.db
        .insert(users)
        .values({ email: `ai-live-${stamp}@example.com`, passwordHash: 'x', displayName: null })
        .returning();
      if (!user) throw new Error('user insert failed');
      const [org] = await svc.db
        .insert(organizations)
        .values({ name: `ai-live-${stamp}`, slug: `ai-live-${stamp}`, createdBy: user.id })
        .returning();
      if (!org) throw new Error('org insert failed');
      const projectA = `ai-live-proj-a-${stamp}`;
      const projectB = `ai-live-proj-b-${stamp}`;

      const errors: string[] = [];
      const journal = new DrizzleAIJournal(svc.db, err => {
        errors.push(String(err).slice(0, 200));
      });

      // Journal through the same sink path the API uses.
      const plans = new PlanStore();
      const audit = new AIAuditLog();
      const usage = new AIUsageTracker();
      plans.attachSink(p => void journal.savePlan(p));
      audit.attachSink(e => void journal.saveAudit(e));
      usage.attachSink(u => void journal.saveUsage(u));

      const created = plans.create({
        projectId: projectA,
        organizationId: org.id,
        userId: user.id,
        prompt: 'live journal plan',
        provider: 'local',
        model: 'local-planner-v1',
        raw: {
          version: 1,
          summary: 'live journal plan body',
          database: { tables: [], policies: [] },
          api: { endpoints: [] },
          auth: { providers: [], roles: [], policies: [] },
          storage: { buckets: [] },
          realtime: { channels: [] },
          functions: [],
        },
        existing: { tables: [], endpoints: [], buckets: [], channels: [], functions: [] },
      });
      audit.record({
        projectId: projectA,
        organizationId: org.id,
        userId: user.id,
        action: 'AI_PLAN_GENERATED',
        resource: created.id,
        result: 'ok',
        detail: 'live',
        prompt: 'api_key = "sk-live-must-stay-masked"',
      });
      usage.trackRequest(
        projectA,
        { promptTokens: 11, completionTokens: 22, latencyMs: 7 },
        true,
        org.id,
      );
      // Let fire-and-forget journal writes land.
      await new Promise(r => setTimeout(r, 1500));
      expect(errors).toEqual([]);

      // Simulate a restart: fresh stores rehydrate from the journal.
      const snapshot = await journal.loadAll();
      const plans2 = new PlanStore();
      const audit2 = new AIAuditLog();
      const usage2 = new AIUsageTracker();
      plans2.restore(snapshot.plans);
      audit2.restore(snapshot.audits);
      usage2.restore(snapshot.usage);
      expect(plans2.get(projectA, created.id).prompt).toBe('live journal plan');
      expect(audit2.history(projectA)).toHaveLength(1);
      expect(audit2.history(projectA)[0]?.prompt ?? '').not.toContain('sk-live');
      expect(usage2.get(projectA).requests).toBe(1);
      expect(usage2.get(projectA).promptTokens).toBe(11);
      expect(usage2.get(projectA).organizationId).toBe(org.id);

      // Tenant isolation: project B sees nothing of project A.
      const scoped = await journal.loadProject(projectB);
      expect(scoped.plans).toHaveLength(0);
      expect(scoped.audits).toHaveLength(0);
      const scopedA = await journal.loadProject(projectA);
      expect(scopedA.plans.map(p => p.id)).toContain(created.id);

      await svc.close().catch(() => undefined);
    } finally {
      await svc.close().catch(() => undefined);
    }
  });
});
