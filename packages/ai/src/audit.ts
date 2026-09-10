import { redactPrompt } from './provider.js';

/**
 * AI audit log + usage tracking. Every lifecycle transition records who, what
 * project, what action, when, on which resource, and the result. Prompts are
 * stored redacted (secret assignments masked, bounded length) — raw prompts
 * with potential secrets never persist.
 */

export type AIAuditAction =
  | 'AI_REQUEST_CREATED'
  | 'AI_PLAN_GENERATED'
  | 'AI_PLAN_VALIDATED'
  | 'AI_PLAN_APPROVED'
  | 'AI_PLAN_REJECTED'
  | 'AI_CHANGE_APPLIED'
  | 'AI_CHANGE_FAILED'
  | 'AI_CHANGE_ROLLED_BACK';

export interface AIAuditEntry {
  id: string;
  projectId: string;
  organizationId: string | null;
  userId: string;
  action: AIAuditAction;
  resource: string;
  result: 'ok' | 'denied' | 'error';
  detail: string;
  prompt: string | null;
  createdAt: string;
}

let auditCounter = 0;

export class AIAuditLog {
  private readonly entries: AIAuditEntry[] = [];

  record(input: {
    projectId: string;
    organizationId?: string | null;
    userId: string;
    action: AIAuditAction;
    resource: string;
    result: 'ok' | 'denied' | 'error';
    detail?: string;
    prompt?: string | null;
  }): AIAuditEntry {
    auditCounter += 1;
    const entry: AIAuditEntry = {
      id: `ai_audit_${auditCounter}`,
      projectId: input.projectId,
      organizationId: input.organizationId ?? null,
      userId: input.userId,
      action: input.action,
      resource: input.resource.slice(0, 200),
      result: input.result,
      detail: (input.detail ?? '').slice(0, 500),
      prompt: input.prompt == null ? null : redactPrompt(input.prompt),
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  history(projectId: string, limit = 100): AIAuditEntry[] {
    return this.entries
      .filter(e => e.projectId === projectId)
      .slice(-Math.min(Math.max(limit, 1), 500))
      .reverse();
  }
}

export interface AIUsageRecord {
  projectId: string;
  requests: number;
  plansGenerated: number;
  plansApplied: number;
  plansFailed: number;
  promptTokens: number;
  completionTokens: number;
  tokensReported: boolean;
  totalLatencyMs: number;
  lastAt: string | null;
}

/**
 * Usage counters. Token counts are summed ONLY as reported by the provider
 * (null-safe); local-planner runs report no tokens — never fabricated.
 */
export class AIUsageTracker {
  private readonly usage = new Map<string, AIUsageRecord>();

  private for(projectId: string): AIUsageRecord {
    let u = this.usage.get(projectId);
    if (!u) {
      u = {
        projectId,
        requests: 0,
        plansGenerated: 0,
        plansApplied: 0,
        plansFailed: 0,
        promptTokens: 0,
        completionTokens: 0,
        tokensReported: false,
        totalLatencyMs: 0,
        lastAt: null,
      };
      this.usage.set(projectId, u);
    }
    return u;
  }

  trackRequest(
    projectId: string,
    usage: { promptTokens: number | null; completionTokens: number | null; latencyMs: number },
    generated: boolean,
  ): void {
    const u = this.for(projectId);
    u.requests += 1;
    if (generated) u.plansGenerated += 1;
    if (usage.promptTokens != null && usage.completionTokens != null) {
      u.promptTokens += usage.promptTokens;
      u.completionTokens += usage.completionTokens;
      u.tokensReported = true;
    }
    u.totalLatencyMs += usage.latencyMs;
    u.lastAt = new Date().toISOString();
  }

  trackApply(projectId: string, ok: boolean): void {
    const u = this.for(projectId);
    if (ok) u.plansApplied += 1;
    else u.plansFailed += 1;
    u.lastAt = new Date().toISOString();
  }

  get(projectId: string): AIUsageRecord {
    return { ...this.for(projectId) };
  }
}
