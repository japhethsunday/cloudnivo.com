import { createHash } from 'node:crypto';
import { AgentTokenError } from './tokens.js';

/**
 * Approval workflow for destructive agent operations. When a token has
 * `approvalRequired`, destructive calls are NOT executed — the API answers
 * 428 with an approval request id. After a human approves, the agent repeats
 * the exact request with `X-Approval-Id`; the server re-verifies the
 * operation fingerprint (method + path + canonical body) before executing
 * exactly once (consumed approvals cannot be replayed).
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export interface ApprovalRequest {
  id: string;
  organizationId: string;
  projectId: string | null;
  tokenId: string;
  userId: string;
  action: string;
  method: string;
  path: string;
  bodyHash: string;
  status: ApprovalStatus;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface ApprovalStore {
  create(input: Omit<ApprovalRequest, 'id' | 'status' | 'decidedAt' | 'createdAt'>): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | null>;
  listByOrganization(organizationId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]>;
  listByToken(tokenId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]>;
  decide(id: string, status: 'approved' | 'rejected'): Promise<ApprovalRequest | null>;
  markConsumed(id: string): Promise<ApprovalRequest | null>;
  markExpired(id: string): Promise<ApprovalRequest | null>;
}

/** Canonical JSON: sorted keys, no whitespace — identical bodies hash alike. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  const asJson = JSON.stringify(value);
  return typeof asJson === 'string' ? asJson : 'null';
}

export function fingerprintOperation(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableStringify(body)}`, 'utf8')
    .digest('hex');
}

export const APPROVAL_TTL_MS = 24 * 3_600_000;

let approvalCounter = 0;

export class MemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRequest>();

  async create(
    input: Omit<ApprovalRequest, 'id' | 'status' | 'decidedAt' | 'createdAt'>,
  ): Promise<ApprovalRequest> {
    approvalCounter += 1;
    const now = new Date().toISOString();
    const record: ApprovalRequest = {
      ...input,
      id: `apr_${Date.now().toString(36)}_${approvalCounter}`,
      status: 'pending',
      decidedAt: null,
      createdAt: now,
    };
    this.approvals.set(record.id, record);
    return { ...record };
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const record = this.approvals.get(id);
    return record ? { ...record } : null;
  }

  private static visible(record: ApprovalRequest): ApprovalRequest {
    return { ...record };
  }

  async listByOrganization(organizationId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter(r => r.organizationId === organizationId && (!status || r.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(MemoryApprovalStore.visible);
  }

  async listByToken(tokenId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter(r => r.tokenId === tokenId && (!status || r.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(MemoryApprovalStore.visible);
  }

  async decide(id: string, status: 'approved' | 'rejected'): Promise<ApprovalRequest | null> {
    const record = this.approvals.get(id);
    if (!record || record.status !== 'pending') return null;
    const next = { ...record, status, decidedAt: new Date().toISOString() };
    this.approvals.set(id, next);
    return { ...next };
  }

  async markConsumed(id: string): Promise<ApprovalRequest | null> {
    const record = this.approvals.get(id);
    if (!record || record.status !== 'approved') return null;
    const next = { ...record, status: 'consumed' as ApprovalStatus };
    this.approvals.set(id, next);
    return { ...next };
  }

  async markExpired(id: string): Promise<ApprovalRequest | null> {
    const record = this.approvals.get(id);
    if (!record || record.status !== 'pending') return null;
    const next = { ...record, status: 'expired' as ApprovalStatus };
    this.approvals.set(id, next);
    return { ...next };
  }
}

export function approvalError(code: string, message: string, status = 400): AgentTokenError {
  return new AgentTokenError(code, message, status);
}
