import { and, desc, eq, lte } from 'drizzle-orm';
import {
  agentActivity,
  agentApprovals,
  agentTokens,
  type Database,
} from '@cloudnivo/database';
import type { ActivityStore, AgentActivity } from './activity.js';
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals.js';
import type { AgentToken, AgentTokenStore, ExposedAgentToken } from './tokens.js';
import { exposeToken } from './tokens.js';

/**
 * Drizzle-backed agent stores. Same contracts as the memory stores;
 * selected with CONTROL_STORE=drizzle like billing.
 */

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToToken(row: typeof agentTokens.$inferSelect): AgentToken {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    name: row.name,
    prefix: row.prefix,
    hash: row.keyHash,
    scopes: [...(row.scopes ?? [])],
    projectIds: [...(row.projectIds ?? [])],
    approvalRequired: row.approvalRequired,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    requestCount: row.requestCount,
    lastUsedAt: iso(row.lastUsedAt),
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

function rowToApproval(row: typeof agentApprovals.$inferSelect): ApprovalRequest {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    tokenId: row.tokenId,
    userId: row.userId,
    action: row.action,
    method: row.method,
    path: row.path,
    bodyHash: row.bodyHash,
    status: row.status as ApprovalStatus,
    decidedAt: iso(row.decidedAt),
    expiresAt: iso(row.expiresAt) ?? new Date().toISOString(),
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

function rowToActivity(row: typeof agentActivity.$inferSelect): AgentActivity {
  return {
    id: row.id,
    tokenId: row.tokenId,
    userId: row.userId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    action: row.action,
    resource: row.resource,
    result: row.result as AgentActivity['result'],
    reason: row.reason,
    ip: row.ip,
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

export class DrizzleAgentTokenStore implements AgentTokenStore {
  constructor(private readonly db: Database) {}

  async save(token: AgentToken): Promise<AgentToken> {
    // The id column is a database uuid: inserts omit it so Postgres assigns
    // one (memory ids like `agent_…` are opaque to callers either way).
    const rows = await this.db
      .insert(agentTokens)
      .values({
        userId: token.userId,
        organizationId: token.organizationId,
        name: token.name,
        prefix: token.prefix,
        keyHash: token.hash,
        scopes: [...token.scopes],
        projectIds: [...token.projectIds],
        approvalRequired: token.approvalRequired,
        expiresAt: token.expiresAt ? new Date(token.expiresAt) : null,
      })
      .onConflictDoUpdate({
        target: agentTokens.keyHash,
        set: {
          name: token.name,
          scopes: [...token.scopes],
          projectIds: [...token.projectIds],
          approvalRequired: token.approvalRequired,
          expiresAt: token.expiresAt ? new Date(token.expiresAt) : null,
          revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Agent token upsert failed');
    return rowToToken(row);
  }

  async findByHash(hash: string): Promise<AgentToken | null> {
    if (!hash) return null;
    const rows = await this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.keyHash, hash))
      .limit(1);
    const row = rows[0];
    return row ? rowToToken(row) : null;
  }

  async get(id: string): Promise<AgentToken | null> {
    const rows = await this.db.select().from(agentTokens).where(eq(agentTokens.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToToken(row) : null;
  }

  async listByUser(userId: string): Promise<ExposedAgentToken[]> {
    const rows = await this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.userId, userId))
      .orderBy(desc(agentTokens.createdAt));
    return rows.map(r => exposeToken(rowToToken(r)));
  }

  async revoke(id: string): Promise<ExposedAgentToken | null> {
    const current = await this.get(id);
    if (!current || current.revokedAt) return null;
    const rows = await this.db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(eq(agentTokens.id, id))
      .returning();
    const row = rows[0];
    return row ? exposeToken(rowToToken(row)) : null;
  }

  async touch(id: string): Promise<void> {
    const current = await this.get(id);
    if (!current) return;
    await this.db
      .update(agentTokens)
      .set({ requestCount: current.requestCount + 1, lastUsedAt: new Date() })
      .where(eq(agentTokens.id, id));
  }
}

export class DrizzleApprovalStore implements ApprovalStore {
  constructor(private readonly db: Database) {}

  async create(
    input: Omit<ApprovalRequest, 'id' | 'status' | 'decidedAt' | 'createdAt'>,
  ): Promise<ApprovalRequest> {
    const rows = await this.db
      .insert(agentApprovals)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        tokenId: input.tokenId,
        userId: input.userId,
        action: input.action,
        method: input.method,
        path: input.path,
        bodyHash: input.bodyHash,
        expiresAt: new Date(input.expiresAt),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Approval insert failed');
    return rowToApproval(row);
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const rows = await this.db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToApproval(row) : null;
  }

  private async listWhere(
    conditions: ReturnType<typeof eq>[],
    status?: ApprovalStatus,
  ): Promise<ApprovalRequest[]> {
    const all = status ? [...conditions, eq(agentApprovals.status, status)] : conditions;
    const rows = await this.db
      .select()
      .from(agentApprovals)
      .where(and(...all))
      .orderBy(desc(agentApprovals.createdAt));
    return rows.map(rowToApproval);
  }

  async listByOrganization(organizationId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.listWhere([eq(agentApprovals.organizationId, organizationId)], status);
  }

  async listByToken(tokenId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.listWhere([eq(agentApprovals.tokenId, tokenId)], status);
  }

  private async transition(
    id: string,
    from: ApprovalStatus,
    set: Partial<{ status: ApprovalStatus; decidedAt: Date }>,
  ): Promise<ApprovalRequest | null> {
    const rows = await this.db
      .update(agentApprovals)
      .set(set)
      .where(and(eq(agentApprovals.id, id), eq(agentApprovals.status, from)))
      .returning();
    const row = rows[0];
    return row ? rowToApproval(row) : null;
  }

  async decide(id: string, status: 'approved' | 'rejected'): Promise<ApprovalRequest | null> {
    return this.transition(id, 'pending', { status, decidedAt: new Date() });
  }

  async markConsumed(id: string): Promise<ApprovalRequest | null> {
    return this.transition(id, 'approved', { status: 'consumed' });
  }

  async markExpired(id: string): Promise<ApprovalRequest | null> {
    return this.transition(id, 'pending', { status: 'expired' });
  }
}

export class DrizzleActivityStore implements ActivityStore {
  constructor(private readonly db: Database) {}

  async record(input: Omit<AgentActivity, 'id' | 'createdAt'>): Promise<AgentActivity> {
    const rows = await this.db
      .insert(agentActivity)
      .values({
        tokenId: input.tokenId,
        userId: input.userId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        action: input.action,
        resource: input.resource.slice(0, 300),
        result: input.result,
        reason: input.reason.slice(0, 300),
        ip: input.ip,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Activity insert failed');
    return rowToActivity(row);
  }

  async list(filter: { tokenId?: string; organizationId?: string; limit?: number }): Promise<AgentActivity[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const conditions = [];
    if (filter.tokenId) conditions.push(eq(agentActivity.tokenId, filter.tokenId));
    if (filter.organizationId) conditions.push(eq(agentActivity.organizationId, filter.organizationId));
    const rows =
      conditions.length > 0
        ? await this.db
            .select()
            .from(agentActivity)
            .where(and(...conditions))
            .orderBy(desc(agentActivity.createdAt))
            .limit(limit)
        : await this.db.select().from(agentActivity).orderBy(desc(agentActivity.createdAt)).limit(limit);
    return rows.map(rowToActivity);
  }

  async prune(olderThanIso: string): Promise<number> {
    const cutoff = new Date(olderThanIso);
    if (Number.isNaN(cutoff.getTime())) throw new Error('Invalid cutoff timestamp');
    const doomed = await this.db
      .select({ id: agentActivity.id })
      .from(agentActivity)
      .where(lte(agentActivity.createdAt, cutoff));
    if (doomed.length === 0) return 0;
    await this.db.delete(agentActivity).where(lte(agentActivity.createdAt, cutoff));
    return doomed.length;
  }
}
