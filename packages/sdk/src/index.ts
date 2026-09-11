/**
 * CloudNivo typed HTTP client (server-side / CLI use).
 *
 * WARNING: never bundle a session token or service key into browser code —
 * browser clients must go through the dashboard backend or short-lived
 * customer tokens. This client is for CLIs, workers, and server integrations
 * that can hold credentials safely.
 */

export interface ClientOptions {
  baseUrl: string;
  /** Session JWT or `cn_agent_…` agent token (same Bearer header). */
  token?: string;
  apikey?: string;
  fetchImpl?: typeof fetch;
}

export interface AIPlanSummary {
  id: string;
  summary: string;
  status: string;
  validation: { ok: boolean; errors: string[]; warnings: string[]; destructive: string[] };
  changes: { op: string; section: string; text: string }[];
  estimate: Record<string, number>;
  provider: string;
  model: string;
}

export interface AIApplyResult {
  ok: boolean;
  rolledBack: boolean;
  error: string | null;
  steps: { step: string; ok: boolean; detail: string }[];
}

export class SdkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  opts: ClientOptions,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...extraHeaders };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.apikey) headers['apikey'] = opts.apikey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SdkError('UNREACHABLE', 'API unreachable', 0);
  }
  let json: { data?: T; error?: { code?: string; message?: string } } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new SdkError('BAD_RESPONSE', `HTTP ${res.status}`, res.status);
  }
  if (!res.ok)
    throw new SdkError(
      json.error?.code ?? 'REQUEST_FAILED',
      json.error?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  return (json.data ?? {}) as T;
}

export interface AgentTokenView {
  id: string;
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

export interface ApprovalView {
  id: string;
  organizationId: string;
  projectId: string | null;
  tokenId: string;
  action: string;
  method: string;
  path: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export class CloudNivoClient {
  constructor(private readonly opts: ClientOptions) {}

  // ── Projects ──
  async listProjects(): Promise<{ projects: { id: string; slug: string }[] }> {
    return request(this.opts, 'GET', '/api/v1/projects');
  }

  // ── Functions ──
  async listFunctions(
    projectId: string,
  ): Promise<{ functions: { slug: string; status: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/functions`);
  }

  async deployFunction(
    projectId: string,
    slug: string,
    source: string,
    approvalId?: string,
  ): Promise<{ function: { slug: string }; job: { id: string } }> {
    const out = await request<{ function: { slug: string }; job: { id: string } }>(
      this.opts,
      'POST',
      `/api/v1/projects/${projectId}/functions/${slug}/deploy`,
      { source },
      approvalId ? { 'X-Approval-Id': approvalId } : undefined,
    );
    return out;
  }

  async invokeFunction(
    projectId: string,
    slug: string,
    body?: unknown,
  ): Promise<{ result: unknown }> {
    return request(
      this.opts,
      'POST',
      `/api/v1/projects/${projectId}/functions/${slug}/invoke`,
      body ?? {},
    );
  }

  // ── Storage ──
  async listBuckets(projectId: string): Promise<{ buckets: { name: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/storage/buckets`);
  }

  // ── AI Builder (server-side callers hold the session; never browsers) ──
  async aiPlan(projectId: string, prompt: string): Promise<AIPlanSummary> {
    const out = await request<{ plan: AIPlanSummary }>(
      this.opts,
      'POST',
      `/api/v1/projects/${projectId}/ai/plan`,
      { prompt },
    );
    return out.plan;
  }

  async aiPlanStatus(
    projectId: string,
    planId: string,
  ): Promise<AIPlanSummary & { steps: unknown[] }> {
    const out = await request<{ plan: AIPlanSummary & { steps: unknown[] } }>(
      this.opts,
      'GET',
      `/api/v1/projects/${projectId}/ai/plans/${planId}`,
    );
    return out.plan;
  }

  async aiApprove(
    projectId: string,
    planId: string,
    confirmations: string[] = [],
  ): Promise<AIPlanSummary> {
    const out = await request<{ plan: AIPlanSummary }>(
      this.opts,
      'POST',
      `/api/v1/projects/${projectId}/ai/plans/${planId}/approve`,
      { confirmations },
    );
    return out.plan;
  }

  async aiApply(projectId: string, planId: string): Promise<AIApplyResult> {
    return request<AIApplyResult>(
      this.opts,
      'POST',
      `/api/v1/projects/${projectId}/ai/plans/${planId}/apply`,
      {},
    );
  }

  async aiUsage(
    projectId: string,
  ): Promise<{ requests: number; plansApplied: number; plansFailed: number }> {
    const out = await request<{
      usage: { requests: number; plansApplied: number; plansFailed: number };
    }>(this.opts, 'GET', `/api/v1/projects/${projectId}/ai/usage`);
    return out.usage;
  }

  // ── Agent access (works with session JWTs for management; agent tokens
  // authenticate with the same Bearer header for self-service calls) ──
  async agentWhoami(): Promise<{ token: AgentTokenView; scopes: string[] }> {
    return request(this.opts, 'GET', '/api/v1/agent/whoami');
  }

  async listAgentTokens(organizationId: string): Promise<{ tokens: AgentTokenView[] }> {
    return request(this.opts, 'GET', `/api/v1/organizations/${organizationId}/agent-tokens`);
  }

  async createAgentToken(
    organizationId: string,
    input: {
      name: string;
      scopes: string[];
      projectIds?: string[];
      approvalRequired?: boolean;
      expiresIn?: string;
    },
  ): Promise<{ token: AgentTokenView; raw: string }> {
    return request(this.opts, 'POST', `/api/v1/organizations/${organizationId}/agent-tokens`, input);
  }

  async revokeAgentToken(organizationId: string, tokenId: string): Promise<{ token: AgentTokenView }> {
    return request(this.opts, 'DELETE', `/api/v1/organizations/${organizationId}/agent-tokens/${tokenId}`);
  }

  async listApprovals(
    organizationId: string,
    status?: string,
  ): Promise<{ approvals: ApprovalView[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(this.opts, 'GET', `/api/v1/organizations/${organizationId}/approvals${q}`);
  }

  async decideApproval(
    organizationId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
  ): Promise<{ approval: ApprovalView }> {
    return request(
      this.opts,
      'POST',
      `/api/v1/organizations/${organizationId}/approvals/${approvalId}/${decision}`,
      {},
    );
  }

  async agentApprovals(status?: string): Promise<{ approvals: ApprovalView[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(this.opts, 'GET', `/api/v1/agent/approvals${q}`);
  }

  async deleteProject(projectId: string, approvalId?: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(
      this.opts,
      'DELETE',
      `/api/v1/projects/${projectId}`,
      undefined,
      approvalId ? { 'X-Approval-Id': approvalId } : undefined,
    );
  }

  /** Create a project (agents need the projects.create scope). */
  async createProject(input: {
    name: string;
    slug: string;
    organizationId: string;
    region?: string;
  }): Promise<{ project: { id: string }; jobId: string }> {
    return request(this.opts, 'POST', '/api/v1/projects', input);
  }
}
