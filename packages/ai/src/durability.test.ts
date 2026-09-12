import { describe, expect, it } from 'vitest';
import { PlanStore } from './approvals.js';
import { AIAuditLog, AIUsageTracker } from './audit.js';

// Sink hooks + restore: the contract the Drizzle journal relies on.
// No database needed — verifies every mutation emits and restore replaces.
describe('ai durability hooks', () => {
  it('plan store emits every mutation and restores wholesale', () => {
    const store = new PlanStore();
    const seen: string[] = [];
    store.attachSink(p => seen.push(`${p.id}:${p.status}`));
    const created = store.create({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'add users table',
      provider: 'local',
      model: 'local-planner-v1',
      raw: {
        version: 1,
        summary: 'add users table plan',
        database: { tables: [], policies: [] },
        api: { endpoints: [] },
        auth: { providers: [], roles: [], policies: [] },
        storage: { buckets: [] },
        realtime: { channels: [] },
        functions: [],
      },
      existing: { tables: [], endpoints: [], buckets: [], channels: [], functions: [] },
    });
    expect(seen).toEqual([`${created.id}:pending`]);
    store.reject('p1', created.id);
    expect(seen.at(-1)).toBe(`${created.id}:rejected`);

    // Restore replaces contents (boot rehydrate semantics).
    const clone = new PlanStore();
    clone.restore([
      { ...created, status: 'approved' as const },
      { ...created, id: '00000000-0000-0000-0000-000000000002', status: 'applied' as const },
    ]);
    expect(clone.list('p1')).toHaveLength(2);
    expect(clone.get('p1', created.id).status).toBe('approved');
    expect(() => clone.get('other', created.id)).toThrow();
  });

  it('audit log emits redacted records and restores in order', () => {
    const log = new AIAuditLog();
    const seen: string[] = [];
    log.attachSink(e => seen.push(e.action));
    log.record({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      action: 'AI_PLAN_GENERATED',
      resource: 'plan-1',
      result: 'ok',
      detail: 'd',
      prompt: 'api_key = "sk-live-should-be-masked-anyway"',
    });
    expect(seen).toEqual(['AI_PLAN_GENERATED']);
    const history = log.history('p1');
    expect(history).toHaveLength(1);
    expect(history[0]?.prompt ?? '').not.toContain('sk-live');

    const clone = new AIAuditLog();
    clone.restore(history);
    expect(clone.history('p1')).toHaveLength(1);
    expect(clone.history('other')).toHaveLength(0);
  });

  it('usage tracker emits snapshots and restores counters', () => {
    const tracker = new AIUsageTracker();
    const seen: number[] = [];
    tracker.attachSink(u => seen.push(u.requests));
    tracker.trackRequest('p1', { promptTokens: 10, completionTokens: 20, latencyMs: 5 }, true, 'o1');
    tracker.trackApply('p1', true, 'o1');
    expect(seen).toEqual([1, 1]);
    const snap = tracker.get('p1');
    expect(snap.requests).toBe(1);
    expect(snap.plansApplied).toBe(1);
    expect(snap.promptTokens).toBe(10);
    expect(snap.organizationId).toBe('o1');

    const clone = new AIUsageTracker();
    clone.restore([snap]);
    expect(clone.get('p1').requests).toBe(1);
    expect(clone.get('p1').organizationId).toBe('o1');
  });
});
