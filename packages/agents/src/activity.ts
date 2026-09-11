/**
 * Agent activity audit. Every agent-token mutation, denial, approval
 * transition, and lifecycle event lands here (best-effort, never blocking).
 * Raw tokens are never stored — only token ids. Retention-bounded by the
 * maintenance sweep, like billing raw usage.
 */

export type ActivityResult = 'success' | 'denied' | 'blocked' | 'error';

export interface AgentActivity {
  id: string;
  tokenId: string | null;
  userId: string;
  organizationId: string | null;
  projectId: string | null;
  action: string;
  resource: string;
  result: ActivityResult;
  reason: string;
  ip: string | null;
  createdAt: string;
}

export interface ActivityFilter {
  tokenId?: string;
  organizationId?: string;
  limit?: number;
}

export interface ActivityStore {
  record(input: Omit<AgentActivity, 'id' | 'createdAt'>): Promise<AgentActivity>;
  list(filter: ActivityFilter): Promise<AgentActivity[]>;
  /** Delete entries older than the ISO cutoff; returns the removed count. */
  prune(olderThanIso: string): Promise<number>;
}

let activityCounter = 0;

export class MemoryActivityStore implements ActivityStore {
  private readonly entries: AgentActivity[] = [];

  async record(input: Omit<AgentActivity, 'id' | 'createdAt'>): Promise<AgentActivity> {
    activityCounter += 1;
    const entry: AgentActivity = {
      ...input,
      resource: input.resource.slice(0, 300),
      reason: input.reason.slice(0, 300),
      id: `act_${Date.now().toString(36)}_${activityCounter}`,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    return { ...entry };
  }

  async list(filter: ActivityFilter): Promise<AgentActivity[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.entries
      .filter(
        e =>
          (!filter.tokenId || e.tokenId === filter.tokenId) &&
          (!filter.organizationId || e.organizationId === filter.organizationId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(e => ({ ...e }));
  }

  async prune(olderThanIso: string): Promise<number> {
    const before = this.entries.length;
    const kept = this.entries.filter(e => e.createdAt >= olderThanIso);
    this.entries.length = 0;
    this.entries.push(...kept);
    return before - kept.length;
  }
}
