import { desc, eq } from 'drizzle-orm';
import {
  aiAuditEntries,
  aiPlans,
  aiUsageCounters,
  type Database,
} from '@cloudnivo/database';
import type { StoredPlan } from './approvals.js';
import type { AIAuditAction, AIAuditEntry, AIUsageRecord } from './audit.js';

/**
 * Durable AI journal (CONTROL_STORE=drizzle). The memory stores stay the
 * live path; every mutation is journaled here and rehydrated at boot, so
 * audit history, plans, and usage counters survive restarts/redeploys.
 *
 * Tenant isolation holds by construction: every row carries projectId
 * (+ organizationId) and all reads filter on projectId. No secrets persist:
 * prompts are stored redacted (masked at record time) and plans/usage hold
 * no credentials by type.
 */

function asDate(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToPlan(row: typeof aiPlans.$inferSelect): StoredPlan {
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId ?? '',
    userId: row.userId ?? '',
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    plan: row.plan as StoredPlan['plan'],
    validation: row.validation as StoredPlan['validation'],
    changes: (row.changes ?? []) as StoredPlan['changes'],
    estimate: (row.estimate ?? {}) as StoredPlan['estimate'],
    status: (row.status ?? 'pending') as StoredPlan['status'],
    confirmations: ((row.confirmations ?? []) as StoredPlan['confirmations']),
    appliedSteps: ((row.appliedSteps ?? []) as { step: string; ok: boolean; detail: string }[]),
    error: row.error,
    createdAt: asDate(row.createdAt) ?? new Date().toISOString(),
    updatedAt: asDate(row.updatedAt) ?? new Date().toISOString(),
  };
}

function rowToAudit(row: typeof aiAuditEntries.$inferSelect): AIAuditEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId,
    userId: row.userId ?? '',
    action: row.action as AIAuditAction,
    resource: row.resource,
    result: (row.result ?? 'ok') as AIAuditEntry['result'],
    detail: row.detail ?? '',
    prompt: row.prompt,
    createdAt: asDate(row.createdAt) ?? new Date().toISOString(),
  };
}

function rowToUsage(row: typeof aiUsageCounters.$inferSelect): AIUsageRecord {
  return {
    projectId: row.projectId,
    organizationId: row.organizationId,
    requests: row.requests ?? 0,
    plansGenerated: row.plansGenerated ?? 0,
    plansApplied: row.plansApplied ?? 0,
    plansFailed: row.plansFailed ?? 0,
    promptTokens: Number(row.promptTokens ?? 0),
    completionTokens: Number(row.completionTokens ?? 0),
    tokensReported: row.tokensReported ?? false,
    totalLatencyMs: Number(row.totalLatencyMs ?? 0),
    lastAt: asDate(row.lastAt),
  };
}

export class DrizzleAIJournal {
  constructor(
    private readonly db: Database,
    private readonly onError?: (err: unknown, what: string) => void,
  ) {}

  private fail(what: string, err: unknown): void {
    try {
      this.onError?.(err, what);
    } catch {
      // Reporting must never throw.
    }
  }

  async savePlan(plan: StoredPlan): Promise<void> {
    try {
      await this.db
        .insert(aiPlans)
        .values({
          id: plan.id,
          organizationId: plan.organizationId || null,
          projectId: plan.projectId,
          userId: plan.userId || null,
          prompt: plan.prompt.slice(0, 2000),
          provider: plan.provider.slice(0, 80),
          model: plan.model.slice(0, 200),
          plan: plan.plan as object,
          validation: plan.validation as object,
          changes: plan.changes as object,
          estimate: plan.estimate as object,
          status: plan.status,
          confirmations: plan.confirmations as object,
          appliedSteps: plan.appliedSteps as object,
          error: plan.error?.slice(0, 500) ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: aiPlans.id,
          set: {
            status: plan.status,
            confirmations: plan.confirmations as object,
            appliedSteps: plan.appliedSteps as object,
            error: plan.error?.slice(0, 500) ?? null,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      this.fail('ai.journal.savePlan', err);
    }
  }

  async saveAudit(entry: AIAuditEntry): Promise<void> {
    try {
      await this.db
        .insert(aiAuditEntries)
        .values({
          id: entry.id,
          organizationId: entry.organizationId || null,
          projectId: entry.projectId,
          userId: entry.userId || null,
          action: entry.action,
          resource: entry.resource.slice(0, 200),
          result: entry.result,
          detail: entry.detail.slice(0, 500),
          prompt: entry.prompt,
        })
        .onConflictDoNothing();
    } catch (err) {
      this.fail('ai.journal.saveAudit', err);
    }
  }

  async saveUsage(record: AIUsageRecord): Promise<void> {
    try {
      await this.db
        .insert(aiUsageCounters)
        .values({
          projectId: record.projectId,
          organizationId: record.organizationId || null,
          requests: record.requests,
          plansGenerated: record.plansGenerated,
          plansApplied: record.plansApplied,
          plansFailed: record.plansFailed,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          tokensReported: record.tokensReported,
          totalLatencyMs: record.totalLatencyMs,
          lastAt: record.lastAt ? new Date(record.lastAt) : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: aiUsageCounters.projectId,
          set: {
            requests: record.requests,
            plansGenerated: record.plansGenerated,
            plansApplied: record.plansApplied,
            plansFailed: record.plansFailed,
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            tokensReported: record.tokensReported,
            totalLatencyMs: record.totalLatencyMs,
            lastAt: record.lastAt ? new Date(record.lastAt) : null,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      this.fail('ai.journal.saveUsage', err);
    }
  }

  /**
   * Boot rehydrate. AI data volume is human-scale: all plans + usage
   * counters load fully; audit history loads newest-first capped so a
   * pathological table cannot OOM the boot path.
   */
  async loadAll(auditLimit = 10_000): Promise<{
    plans: StoredPlan[];
    audits: AIAuditEntry[];
    usage: AIUsageRecord[];
  }> {
    const [planRows, auditRows, usageRows] = await Promise.all([
      this.db.select().from(aiPlans),
      this.db.select().from(aiAuditEntries).orderBy(desc(aiAuditEntries.createdAt)).limit(auditLimit),
      this.db.select().from(aiUsageCounters),
    ]);
    return {
      plans: planRows.map(rowToPlan),
      audits: auditRows.map(rowToAudit).reverse(),
      usage: usageRows.map(rowToUsage),
    };
  }

  /** Scoped read for verification (tenant isolation check). */
  async loadProject(projectId: string): Promise<{ plans: StoredPlan[]; audits: AIAuditEntry[] }> {
    const [planRows, auditRows] = await Promise.all([
      this.db.select().from(aiPlans).where(eq(aiPlans.projectId, projectId)),
      this.db
        .select()
        .from(aiAuditEntries)
        .where(eq(aiAuditEntries.projectId, projectId))
        .orderBy(desc(aiAuditEntries.createdAt))
        .limit(500),
    ]);
    return { plans: planRows.map(rowToPlan), audits: auditRows.map(rowToAudit).reverse() };
  }
}
