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
  private sink: ((entry: AIAuditEntry) => void) | null = null;

  /** Attach a durability journal (fire-and-forget per record). */
  attachSink(sink: ((entry: AIAuditEntry) => void) | null): void {
    this.sink = sink;
  }

  /** Replace contents (boot rehydrate from the durable journal). */
  restore(entries: AIAuditEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...entries);
  }

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
    const sink = this.sink;
    if (sink) {
      try {
        sink({ ...entry });
      } catch {
        // Never break the request on a broken sink.
      }
    }
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
  organizationId: string | null;
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
  private sink: ((record: AIUsageRecord) => void) | null = null;

  /** Attach a durability journal (fire-and-forget per update). */
  attachSink(sink: ((record: AIUsageRecord) => void) | null): void {
    this.sink = sink;
  }

  /** Replace contents (boot rehydrate from the durable journal). */
  restore(records: AIUsageRecord[]): void {
    this.usage.clear();
    for (const r of records) this.usage.set(r.projectId, { ...r });
  }

  private emit(projectId: string): void {
    const sink = this.sink;
    if (sink) {
      try {
        sink(this.get(projectId));
      } catch {
        // Never break the request on a broken sink.
      }
    }
  }

  private for(projectId: string): AIUsageRecord {
    let u = this.usage.get(projectId);
    if (!u) {
      u = {
        projectId,
        organizationId: null,
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
    organizationId?: string | null,
  ): void {
    const u = this.for(projectId);
    if (organizationId) u.organizationId = organizationId;
    u.requests += 1;
    if (generated) u.plansGenerated += 1;
    if (usage.promptTokens != null && usage.completionTokens != null) {
      u.promptTokens += usage.promptTokens;
      u.completionTokens += usage.completionTokens;
      u.tokensReported = true;
    }
    u.totalLatencyMs += usage.latencyMs;
    u.lastAt = new Date().toISOString();
    this.emit(projectId);
  }

  trackApply(projectId: string, ok: boolean, organizationId?: string | null): void {
    const u = this.for(projectId);
    if (organizationId) u.organizationId = organizationId;
    if (ok) u.plansApplied += 1;
    else u.plansFailed += 1;
    u.lastAt = new Date().toISOString();
    this.emit(projectId);
  }

  get(projectId: string): AIUsageRecord {
    return { ...this.for(projectId) };
  }
}
