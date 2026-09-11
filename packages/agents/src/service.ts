import { APPROVAL_TTL_MS, fingerprintOperation, type ApprovalRequest, type ApprovalStatus, type ApprovalStore } from './approvals.js';
import { type ActivityResult, type ActivityStore } from './activity.js';
import { isKnownScope } from './scopes.js';
import {
  AgentTokenError,
  buildTokenRecord,
  createAgentTokenValue,
  exposeToken,
  hashAgentToken,
  looksLikeAgentToken,
  type AgentToken,
  type AgentTokenStore,
  type CreateTokenInput,
  type ExposedAgentToken,
} from './tokens.js';

/**
 * Central agent-token service. Owns issuance, verification, scope checks,
 * the approval gate, and activity recording. Organization membership and
 * project existence are verified by the API layer (it owns the registry);
 * this service decides purely on token state + scopes.
 */

export interface ApprovalGate {
  allowed: boolean;
  /** Set when the call must go through approval instead of executing. */
  needsApproval: boolean;
}

export class AgentService {
  constructor(
    private readonly tokens: AgentTokenStore,
    private readonly approvals: ApprovalStore,
    private readonly activity: ActivityStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Issuance ──────────────────────────────────────────────

  async createToken(
    input: CreateTokenInput,
  ): Promise<{ token: ExposedAgentToken; raw: string }> {
    const record = buildTokenRecord(input, this.now());
    const value = createAgentTokenValue();
    const saved = await this.tokens.save({ ...record, prefix: value.prefix, hash: value.hash });
    await this.activity
      .record({
        tokenId: saved.id,
        userId: saved.userId,
        organizationId: saved.organizationId,
        projectId: saved.projectIds[0] ?? null,
        action: 'token.created',
        resource: saved.name,
        result: 'success',
        reason: `${saved.scopes.length} scopes`,
        ip: null,
      })
      .catch(() => undefined);
    return { token: exposeToken(saved), raw: value.raw };
  }

  async revokeToken(id: string, userId: string): Promise<ExposedAgentToken> {
    const existing = await this.tokens.get(id);
    if (!existing || existing.userId !== userId) {
      throw new AgentTokenError('NOT_FOUND', 'Agent token not found', 404);
    }
    const revoked = await this.tokens.revoke(id);
    if (!revoked) throw new AgentTokenError('NOT_FOUND', 'Agent token not found', 404);
    await this.activity
      .record({
        tokenId: id,
        userId,
        organizationId: existing.organizationId,
        projectId: null,
        action: 'token.revoked',
        resource: existing.name,
        result: 'success',
        reason: '',
        ip: null,
      })
      .catch(() => undefined);
    return revoked;
  }

  async listTokens(userId: string): Promise<ExposedAgentToken[]> {
    return this.tokens.listByUser(userId);
  }

  async getToken(userId: string, id: string): Promise<ExposedAgentToken> {
    const token = await this.tokens.get(id);
    if (!token || token.userId !== userId) {
      throw new AgentTokenError('NOT_FOUND', 'Agent token not found', 404);
    }
    return exposeToken(token);
  }

  // ── Verification (per request) ────────────────────────────

  /**
   * Verify a raw bearer value → live token. Single store lookup, no extra
   * queries: revocation and expiry are evaluated inline so every request is
   * gated on fresh state.
   */
  async verifyToken(raw: string): Promise<AgentToken> {
    if (!looksLikeAgentToken(raw)) {
      throw new AgentTokenError('INVALID_TOKEN', 'Invalid agent token', 401);
    }
    const found = await this.tokens.findByHash(hashAgentToken(raw));
    if (!found) throw new AgentTokenError('INVALID_TOKEN', 'Invalid agent token', 401);
    if (found.revokedAt) throw new AgentTokenError('TOKEN_REVOKED', 'Agent token revoked', 403);
    if (found.expiresAt && Date.parse(found.expiresAt) <= this.now().getTime()) {
      throw new AgentTokenError('TOKEN_EXPIRED', 'Agent token expired', 401);
    }
    await this.tokens.touch(found.id).catch(() => undefined);
    return { ...found, requestCount: found.requestCount + 1, lastUsedAt: this.now().toISOString() };
  }

  // ── Scope + resource checks (pure) ────────────────────────

  hasScope(token: AgentToken, scope: string): boolean {
    if (!isKnownScope(scope)) return false;
    return token.scopes.includes(scope);
  }

  requireScope(token: AgentToken, scope: string, resource = ''): void {
    if (!this.hasScope(token, scope)) {
      throw new AgentTokenError(
        'FORBIDDEN_SCOPE',
        `Agent token lacks required scope: ${scope}${resource ? ` (${resource})` : ''}`,
        403,
      );
    }
  }

  /**
   * Resource scoping: an org-bound token serves only that org; projectIds
   * empty means every project in scope, otherwise the project must be listed.
   * Account-wide tokens (organizationId null) rely on the caller's membership
   * check — this method only narrows, never widens.
   */
  inScope(token: AgentToken, organizationId: string, projectId?: string): boolean {
    if (token.organizationId && token.organizationId !== organizationId) return false;
    if (projectId && token.projectIds.length > 0 && !token.projectIds.includes(projectId)) {
      return false;
    }
    return true;
  }

  requireInScope(token: AgentToken, organizationId: string, projectId?: string): void {
    if (!this.inScope(token, organizationId, projectId)) {
      throw new AgentTokenError('TENANT_FORBIDDEN', 'Agent token is not scoped to this resource', 403);
    }
  }

  /**
   * Destructive gate: standing scope allows directly; otherwise an
   * approval-required token yields needsApproval (caller answers 428 +
   * records the request), and anything else is denied.
   */
  gate(token: AgentToken, scope: string): ApprovalGate {
    if (this.hasScope(token, scope)) return { allowed: true, needsApproval: false };
    if (token.approvalRequired) return { allowed: false, needsApproval: true };
    return { allowed: false, needsApproval: false };
  }

  // ── Approvals ─────────────────────────────────────────────

  async listApprovalsByOrganization(organizationId: string, status?: ApprovalStatus) {
    return this.approvals.listByOrganization(organizationId, status);
  }

  async listApprovalsByToken(tokenId: string, status?: ApprovalStatus) {
    return this.approvals.listByToken(tokenId, status);
  }

  async getApproval(id: string) {
    return this.approvals.get(id);
  }

  async requestApproval(input: {
    organizationId: string;
    projectId: string | null;
    token: AgentToken;
    action: string;
    method: string;
    path: string;
    body: unknown;
  }): Promise<ApprovalRequest> {
    return this.approvals.create({
      organizationId: input.organizationId,
      projectId: input.projectId,
      tokenId: input.token.id,
      userId: input.token.userId,
      action: input.action,
      method: input.method.toUpperCase(),
      path: input.path,
      bodyHash: fingerprintOperation(input.method, input.path, input.body),
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
    });
  }

  /** Human decision; only the token owner's org managers may call (enforced by routes). */
  async decideApproval(id: string, decision: 'approved' | 'rejected'): Promise<ApprovalRequest> {
    const current = await this.approvals.get(id);
    if (!current) throw new AgentTokenError('NOT_FOUND', 'Approval request not found', 404);
    if (current.status !== 'pending') {
      throw new AgentTokenError('CONFLICT', `Approval is already ${current.status}`, 409);
    }
    if (Date.parse(current.expiresAt) <= this.now().getTime()) {
      await this.approvals.markExpired(id);
      throw new AgentTokenError('GONE', 'Approval request expired', 410);
    }
    const next = await this.approvals.decide(id, decision);
    if (!next) throw new AgentTokenError('CONFLICT', 'Approval is no longer pending', 409);
    await this.activity
      .record({
        tokenId: next.tokenId,
        userId: next.userId,
        organizationId: next.organizationId,
        projectId: next.projectId,
        action: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
        resource: `${next.action} ${next.path}`,
        result: 'success',
        reason: '',
        ip: null,
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * Consume an approval for the exact request being retried. The fingerprint
   * must match byte-for-byte, the token must own it, and it must be approved
   * and fresh — then it is consumed so it cannot be replayed.
   */
  async consumeApproval(input: {
    approvalId: string;
    token: AgentToken;
    method: string;
    path: string;
    body: unknown;
  }): Promise<ApprovalRequest> {
    const current = await this.approvals.get(input.approvalId);
    if (!current || current.tokenId !== input.token.id) {
      throw new AgentTokenError('FORBIDDEN_SCOPE', 'Approval does not apply to this token', 403);
    }
    if (current.status !== 'approved') {
      throw new AgentTokenError('CONFLICT', `Approval is ${current.status}`, 409);
    }
    if (Date.parse(current.expiresAt) <= this.now().getTime()) {
      await this.approvals.markExpired(current.id);
      throw new AgentTokenError('GONE', 'Approval request expired', 410);
    }
    const fingerprint = fingerprintOperation(input.method, input.path, input.body);
    if (fingerprint !== current.bodyHash) {
      throw new AgentTokenError('FORBIDDEN_SCOPE', 'Approval does not match this operation', 403);
    }
    const consumed = await this.approvals.markConsumed(current.id);
    if (!consumed) throw new AgentTokenError('CONFLICT', 'Approval was already used', 409);
    return consumed;
  }

  // ── Activity + maintenance ────────────────────────────────

  async log(input: {
    tokenId: string | null;
    userId: string;
    organizationId: string | null;
    projectId: string | null;
    action: string;
    resource?: string;
    result: ActivityResult;
    reason?: string;
    ip?: string | null;
  }): Promise<void> {
    await this.activity
      .record({
        tokenId: input.tokenId,
        userId: input.userId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        action: input.action,
        resource: input.resource ?? '',
        result: input.result,
        reason: input.reason ?? '',
        ip: input.ip ?? null,
      })
      .catch(() => undefined);
  }

  async listActivity(filter: { tokenId?: string; organizationId?: string; limit?: number }) {
    return this.activity.list(filter);
  }

  /**
   * Recurring maintenance: expire stale pending approvals and prune old
   * activity. Idempotent; safe on any schedule.
   */
  async runMaintenance(
    organizationIds: string[],
    opts: { activityRetentionDays?: number } = {},
  ): Promise<{ expired: number; pruned: number }> {
    const nowMs = this.now().getTime();
    let expired = 0;
    for (const organizationId of organizationIds.slice(0, 10_000)) {
      const pending = await this.approvals.listByOrganization(organizationId, 'pending').catch(() => []);
      for (const item of pending) {
        if (Date.parse(item.expiresAt) <= nowMs) {
          await this.approvals.markExpired(item.id).catch(() => undefined);
          expired += 1;
        }
      }
    }
    const retentionDays = opts.activityRetentionDays ?? 180;
    const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    const pruned = await this.activity.prune(cutoff).catch(() => 0);
    return { expired, pruned };
  }
}
