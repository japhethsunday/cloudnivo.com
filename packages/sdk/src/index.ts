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
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
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
}
