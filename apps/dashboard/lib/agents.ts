'use client';

import { apiFetch } from './api';

export interface AgentTokenView {
  id: string;
  userId: string;
  organizationId: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  projectIds: string[];
  approvalRequired: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  requestCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ScopeView {
  scope: string;
  service: string;
  description: string;
  dangerous: boolean;
  enforcedBy: string;
}

export interface ApprovalView {
  id: string;
  organizationId: string;
  projectId: string | null;
  tokenId: string;
  action: string;
  method: string;
  path: string;
  status: string;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface ActivityView {
  id: string;
  tokenId: string | null;
  organizationId: string | null;
  projectId: string | null;
  action: string;
  resource: string;
  result: string;
  reason: string;
  createdAt: string;
}

export async function listAgentTokens(orgId: string): Promise<{
  ok: boolean;
  tokens?: AgentTokenView[];
  scopes?: ScopeView[];
  error?: string | null;
}> {
  const r = await apiFetch<{ tokens: AgentTokenView[]; scopes: ScopeView[] }>(
    `/api/v1/organizations/${orgId}/agent-tokens`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, tokens: r.data.tokens, scopes: r.data.scopes };
}

export async function createAgentToken(
  orgId: string,
  input: {
    name: string;
    scopes: string[];
    projectIds: string[];
    approvalRequired: boolean;
    expiresIn: string;
  },
): Promise<{ ok: boolean; token?: AgentTokenView; raw?: string; error?: string | null }> {
  const r = await apiFetch<{ token: AgentTokenView; raw: string }>(
    `/api/v1/organizations/${orgId}/agent-tokens`,
    { method: 'POST', body: input },
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, token: r.data.token, raw: r.data.raw };
}

export async function revokeAgentToken(
  orgId: string,
  tokenId: string,
): Promise<{ ok: boolean; error?: string | null }> {
  const r = await apiFetch(`/api/v1/organizations/${orgId}/agent-tokens/${tokenId}`, {
    method: 'DELETE',
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function listApprovals(
  orgId: string,
  status?: string,
): Promise<{ ok: boolean; approvals?: ApprovalView[]; error?: string | null }> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const r = await apiFetch<{ approvals: ApprovalView[] }>(
    `/api/v1/organizations/${orgId}/approvals${q}`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, approvals: r.data.approvals };
}

export async function decideApproval(
  orgId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<{ ok: boolean; error?: string | null }> {
  const r = await apiFetch(
    `/api/v1/organizations/${orgId}/approvals/${approvalId}/${decision}`,
    { method: 'POST', body: {} },
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function listActivity(
  orgId: string,
  opts: { tokenId?: string; limit?: number } = {},
): Promise<{ ok: boolean; activity?: ActivityView[]; error?: string | null }> {
  const q = new URLSearchParams();
  if (opts.tokenId) q.set('tokenId', opts.tokenId);
  if (opts.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  const r = await apiFetch<{ activity: ActivityView[] }>(
    `/api/v1/organizations/${orgId}/agent-activity${qs ? `?${qs}` : ''}`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, activity: r.data.activity };
}
