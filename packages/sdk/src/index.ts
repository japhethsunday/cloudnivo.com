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

  // ── Automation: queues ──
  async listQueues(projectId: string): Promise<{ queues: { id: string; name: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/queues`);
  }

  async createQueue(projectId: string, input: { name: string; maxDeliveries?: number }): Promise<{ queue: { id: string; name: string } }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/queues`, input);
  }

  async publishMessage(
    projectId: string,
    queueId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ message: { id: string }; duplicate: boolean }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/queues/${queueId}/messages`, {
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async consumeMessages(
    projectId: string,
    queueId: string,
    opts: { limit?: number; leaseMs?: number } = {},
  ): Promise<{ messages: { id: string; body: Record<string, unknown>; status: string }[] }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/queues/${queueId}/consume`, {
      limit: opts.limit ?? 1,
      leaseMs: opts.leaseMs ?? 30_000,
    });
  }

  async ackMessage(projectId: string, queueId: string, messageId: string): Promise<{ message: { id: string } }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/queues/${queueId}/messages/${messageId}/ack`, {});
  }

  async listMessages(projectId: string, queueId: string): Promise<{ messages: { id: string; status: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/queues/${queueId}/messages`);
  }

  async deleteQueue(projectId: string, queueId: string): Promise<{ deleted: boolean }> {
    return request(this.opts, 'DELETE', `/api/v1/projects/${projectId}/queues/${queueId}`);
  }

  async purgeQueue(projectId: string, queueId: string, statuses: string[]): Promise<{ purged: number }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/queues/${queueId}/purge`, { statuses });
  }

  // ── Automation: schedules ──
  async listSchedules(projectId: string): Promise<{ schedules: { id: string; name: string; cron: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/schedules`);
  }

  async createSchedule(
    projectId: string,
    input: { name: string; functionSlug: string; cron: string; payload?: Record<string, unknown> },
  ): Promise<{ schedule: { id: string; nextRunAt: string | null } }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/schedules`, input);
  }

  async triggerSchedule(projectId: string, scheduleId: string): Promise<{ ok: boolean; error: string | null }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/schedules/${scheduleId}/trigger`, {});
  }

  async patchSchedule(
    projectId: string,
    scheduleId: string,
    patch: { name?: string; cron?: string; payload?: Record<string, unknown>; enabled?: boolean },
  ): Promise<{ schedule: { id: string } }> {
    return request(this.opts, 'PATCH', `/api/v1/projects/${projectId}/schedules/${scheduleId}`, patch);
  }

  async deleteSchedule(projectId: string, scheduleId: string): Promise<{ deleted: boolean }> {
    return request(this.opts, 'DELETE', `/api/v1/projects/${projectId}/schedules/${scheduleId}`);
  }

  // ── Automation: webhooks ──
  async listWebhooks(projectId: string): Promise<{ webhooks: { id: string; name: string; url: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/webhooks`);
  }

  async createWebhook(
    projectId: string,
    input: { name: string; url: string; eventTypes: string[]; maxAttempts?: number },
  ): Promise<{ webhook: { id: string }; secret: string }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/webhooks`, input);
  }

  async listDeliveries(projectId: string, webhookId: string): Promise<{ deliveries: { id: string; status: string }[] }> {
    return request(this.opts, 'GET', `/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries`);
  }

  async testWebhook(projectId: string, webhookId: string): Promise<{ delivery: { id: string; status: string } }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/webhooks/${webhookId}/test`, {});
  }

  async replayDelivery(projectId: string, webhookId: string, deliveryId: string): Promise<{ delivery: { id: string } }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/webhooks/${webhookId}/deliveries/${deliveryId}/replay`, {});
  }

  async rotateWebhook(projectId: string, webhookId: string): Promise<{ webhook: { id: string }; secret: string }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/webhooks/${webhookId}/rotate`, {});
  }

  async patchWebhook(
    projectId: string,
    webhookId: string,
    patch: { name?: string; url?: string; eventTypes?: string[]; enabled?: boolean; maxAttempts?: number },
  ): Promise<{ webhook: { id: string } }> {
    return request(this.opts, 'PATCH', `/api/v1/projects/${projectId}/webhooks/${webhookId}`, patch);
  }

  async deleteWebhook(projectId: string, webhookId: string): Promise<{ deleted: boolean }> {
    return request(this.opts, 'DELETE', `/api/v1/projects/${projectId}/webhooks/${webhookId}`);
  }

  // ── Metrics (process-local, since boot) ──
  async projectMetrics(
    organizationId: string,
    projectId: string,
    window: string = '1h',
  ): Promise<{ requests: number; errors: number; p50Ms: number; p95Ms: number }> {
    return request(
      this.opts,
      'GET',
      `/api/v1/organizations/${organizationId}/metrics?window=${encodeURIComponent(window)}&projectId=${encodeURIComponent(projectId)}`,
    );
  }

  // ── AI Debugger (deterministic analysis over real evidence) ──
  async aiDiagnose(
    projectId: string,
    input: { ref?: string; note?: string } = {},
  ): Promise<{
    diagnosis: {
      healthy: boolean;
      probableCause: string;
      affectedService: string;
      evidence: { source: string; ref: string; excerpt: string }[];
      suggestedFix: string;
      confidence: string;
    };
  }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/ai/diagnose`, input);
  }

  // ── CSV data portability ──
  async exportTable(projectId: string, table: string): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (this.opts.token) headers['Authorization'] = `Bearer ${this.opts.token}`;
    if (this.opts.apikey) headers['apikey'] = this.opts.apikey;
    const res = await fetchImpl(
      `${this.opts.baseUrl}/api/v1/projects/${projectId}/${table}/export`,
      { headers },
    );
    if (!res.ok) throw new SdkError('EXPORT_FAILED', `Export failed: HTTP ${res.status}`, res.status);
    return res.text();
  }

  async importTable(
    projectId: string,
    table: string,
    csv: string,
  ): Promise<{ inserted: number; failed: number; errors: { row: number; error: string }[] }> {
    return request(this.opts, 'POST', `/api/v1/projects/${projectId}/${table}/import`, { csv });
  }
}
