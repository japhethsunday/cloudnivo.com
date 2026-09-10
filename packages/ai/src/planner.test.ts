import { describe, expect, it } from 'vitest';
import { AIAuditLog, AIUsageTracker } from './audit.js';
import { PlanStore } from './approvals.js';
import { EMPTY_STATE } from './validate.js';
import { LocalPlannerProvider } from './provider.js';
import { AIBackendBuilder, scaffoldFunctionSource } from './planner.js';
import { checkToolPermission, executeTool, type ToolAdapters } from './tools.js';
import { scanGeneratedCode } from './scanner.js';

function builder(): AIBackendBuilder {
  return new AIBackendBuilder({
    provider: new LocalPlannerProvider(),
    plans: new PlanStore(),
    audit: new AIAuditLog(),
    usage: new AIUsageTracker(),
  });
}

const ADAPTERS: ToolAdapters = {
  inspectProject: async () => ({
    projectId: 'p',
    tables: [],
    buckets: [],
    functions: [],
    channels: [],
    roles: [],
    recentChanges: [],
  }),
  inspectDatabase: async () => [],
  executeMigration: async statements => ({ executed: statements.length }),
  rollbackMigration: async statements => ({ rolledBack: statements.length }),
  createBucket: async input => ({ name: input.name }),
  createFunction: async input => ({ slug: input.name, jobId: 'job_1' }),
  enableRealtime: async input => ({ topic: input.topic }),
};

describe('approvals lifecycle', () => {
  it('pending → approved → applied with audit trail', async () => {
    const b = builder();
    const stored = await b.requestPlan({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'I need tasks.',
      existing: EMPTY_STATE,
      context: {},
    });
    expect(stored.status).toBe('pending');
    // Non-admin cannot approve.
    expect(() => b['opts'].plans.approve('p1', stored.id, 'APPROVAL_REQUIRED', [])).toThrow();
    const approved = b['opts'].plans.approve('p1', stored.id, 'ADMIN', []);
    expect(approved.status).toBe('approved');
    const out = await b.applyPlan({
      projectId: 'p1',
      planId: stored.id,
      adapters: ADAPTERS,
      level: 'ADMIN',
      userId: 'u1',
      organizationId: 'o1',
    });
    expect(out.ok).toBe(true);
    expect(out.plan.status).toBe('applied');
    expect(out.steps.length).toBeGreaterThan(0);
  });

  it('destructive plans require explicit confirmation', async () => {
    const b = builder();
    const stored = await b.requestPlan({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'Drop table tasks to start over.',
      existing: { ...EMPTY_STATE, tables: ['tasks'] },
      context: {},
    });
    expect(stored.validation.destructive).toContain('DROP TABLE');
    expect(() => b['opts'].plans.approve('p1', stored.id, 'ADMIN', [])).toThrow(
      /confirmation required/i,
    );
    const approved = b['opts'].plans.approve('p1', stored.id, 'ADMIN', ['DROP TABLE']);
    expect(approved.status).toBe('approved');
  });

  it('failed applies stop and report honestly (rollback when only migration ran)', async () => {
    const b = builder();
    const stored = await b.requestPlan({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'I need tasks.',
      existing: EMPTY_STATE,
      context: {},
    });
    b['opts'].plans.approve('p1', stored.id, 'ADMIN', []);
    const failing: ToolAdapters = {
      ...ADAPTERS,
      executeMigration: async () => {
        throw new Error('disk full (simulated)');
      },
    };
    const out = await b.applyPlan({
      projectId: 'p1',
      planId: stored.id,
      adapters: failing,
      level: 'ADMIN',
      userId: 'u1',
      organizationId: 'o1',
    });
    expect(out.ok).toBe(false);
    expect(out.plan.status).toBe('rolled_back');
    expect(out.error).toContain('disk full');
  });

  it('rejects unapproved applies and cross-project access', async () => {
    const b = builder();
    const stored = await b.requestPlan({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'I need tasks.',
      existing: EMPTY_STATE,
      context: {},
    });
    await expect(
      b.applyPlan({
        projectId: 'p1',
        planId: stored.id,
        adapters: ADAPTERS,
        level: 'ADMIN',
        userId: 'u1',
        organizationId: 'o1',
      }),
    ).rejects.toThrow();
    expect(() => b['opts'].plans.get('other-project', stored.id)).toThrow();
  });
});

describe('tool boundary', () => {
  it('enforces permission levels independently', async () => {
    expect(() => checkToolPermission('create_bucket', 'READ_ONLY')).toThrow();
    checkToolPermission('inspect_project', 'READ_ONLY');
    await expect(
      executeTool(ADAPTERS, 'READ_ONLY', { tool: 'create_bucket', args: { name: 'x' } }),
    ).rejects.toThrow();
    await expect(
      executeTool(ADAPTERS, 'ADMIN', { tool: 'create_bucket', args: { name: 'BAD NAME!' } }),
    ).rejects.toThrow();
    await expect(
      executeTool(ADAPTERS, 'ADMIN', { tool: 'nope' as never, args: {} }),
    ).rejects.toThrow();
  });
});

describe('function scaffolds', () => {
  it('generated scaffolds pass the safety scan', () => {
    const src = scaffoldFunctionSource(
      'notify-new-order',
      'Send mail on new orders via provider.',
      'database_insert',
      'orders',
    );
    expect(scanGeneratedCode(src).safe).toBe(true);
    expect(src).toContain('module.exports.handler');
  });
});

describe('audit + usage honesty', () => {
  it('redacts prompts and never fabricates tokens', async () => {
    const audit = new AIAuditLog();
    const usage = new AIUsageTracker();
    const b = new AIBackendBuilder({
      provider: new LocalPlannerProvider(),
      plans: new PlanStore(),
      audit,
      usage,
    });
    await b.requestPlan({
      projectId: 'p1',
      organizationId: 'o1',
      userId: 'u1',
      prompt: 'Build tasks. My password = hunter2-secret!',
      existing: EMPTY_STATE,
      context: {},
    });
    const history = audit.history('p1');
    expect(history.length).toBeGreaterThan(0);
    expect(JSON.stringify(history)).not.toContain('hunter2');
    const u = usage.get('p1');
    expect(u.requests).toBe(1);
    expect(u.tokensReported).toBe(false);
    expect(u.promptTokens).toBe(0);
  });
});
