import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * AI Builder flow: plan → preview → approve → apply → verify, plus the
 * dashboard AI Builder console driving the same backend.
 *
 * API base comes from API_URL (default localhost:3001); dashboard base comes
 * from the Playwright baseURL (DASHBOARD_URL, default localhost:3000).
 * Fails fast with a clear message when the stack is not running.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

interface Envelope<T> {
  data: T;
}

interface PlanSummary {
  id: string;
  summary: string;
  status: string;
  validation: { ok: boolean; errors: string[]; warnings: string[]; destructive: string[] };
  changes: { op: string; section: string; text: string }[];
}

async function api<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const res = await request.fetch(`${API}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    data: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status(), json: (await res.json()) as T };
}

async function setupProject(
  request: APIRequestContext,
  stamp: string,
  email: string,
): Promise<{ token: string; projectId: string }> {
  const signup = await api<Envelope<{ user: { id: string }; token: string }>>(
    request,
    'POST',
    '/api/v1/auth/signup',
    { body: { email, password: 'ai-flow-password-1' } },
  );
  expect(signup.status, 'API must be running (signup)').toBe(201);
  const token = signup.json.data.token;
  const org = await api<Envelope<{ organization: { id: string } }>>(request, 'POST', '/api/v1/organizations', {
    token,
    body: { name: `ai-${stamp}`, slug: `ai-${stamp}` },
  });
  expect(org.status).toBe(201);
  const created = await api<Envelope<{ project: { id: string }; jobId: string }>>(
    request,
    'POST',
    '/api/v1/projects',
    { token, body: { name: `ai-${stamp}`, slug: `ai-${stamp}`, organizationId: org.json.data.organization.id } },
  );
  expect(created.status).toBe(202);
  const projectId = created.json.data.project.id;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const job = await api<Envelope<{ job: { status: string } }>>(
      request,
      'GET',
      `/api/v1/projects/${projectId}/jobs/${created.json.data.jobId}`,
      { token },
    );
    const status = job.json.data.job.status;
    expect(status).not.toBe('failed');
    if (status === 'completed') break;
    if (Date.now() > deadline) throw new Error('provisioning did not complete in time');
    await new Promise(r => setTimeout(r, 1000));
  }
  return { token, projectId };
}

test('ai flow: plan → preview → approve → apply → verify real resources', async ({ request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const { token, projectId } = await setupProject(request, stamp, `ai-flow-${stamp}@example.com`);

  const planned = await api<Envelope<{ plan: PlanSummary }>>(request, 'POST', `/api/v1/projects/${projectId}/ai/plan`, {
    token,
    body: { prompt: 'Build a task backend with tasks, priorities, and email reminders when tasks are created.' },
  });
  expect(planned.status).toBe(201);
  const plan = planned.json.data.plan;
  expect(plan.status).toBe('pending');
  expect(plan.validation.ok).toBe(true);
  expect(plan.changes.length).toBeGreaterThan(0);

  const detail = await api<Envelope<{ plan: PlanSummary & { migrationSql: string[] } }>>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/ai/plans/${plan.id}`,
    { token },
  );
  expect(detail.status).toBe(200);
  expect(detail.json.data.plan.migrationSql.join('\n')).toContain('CREATE TABLE');

  const approved = await api(request, 'POST', `/api/v1/projects/${projectId}/ai/plans/${plan.id}/approve`, {
    token,
    body: {},
  });
  expect(approved.status).toBe(200);

  const applied = await api<Envelope<{ ok: boolean; rolledBack: boolean; error: string | null; steps: { step: string; ok: boolean }[] }>>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/ai/plans/${plan.id}/apply`,
    { token, body: {} },
  );
  expect(applied.status).toBe(200);
  expect(applied.json.data.ok).toBe(true);
  expect(applied.json.data.steps.every(s => s.ok)).toBe(true);

  // Real resources behind the standard APIs.
  const buckets = await api<Envelope<{ buckets: unknown[] }>>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/storage/buckets`,
    { token },
  );
  expect(buckets.status).toBe(200);
  const functions = await api<Envelope<{ functions: unknown[] }>>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/functions`,
    { token },
  );
  expect(functions.status).toBe(200);
  const usage = await api<Envelope<{ usage: { plansApplied: number } }>>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/ai/usage`,
    { token },
  );
  expect(usage.json.data.usage.plansApplied).toBe(1);
});

test('ai flow: destructive plan requires explicit confirmation', async ({ request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const { token, projectId } = await setupProject(request, stamp, `ai-des-${stamp}@example.com`);

  const planned = await api<Envelope<{ plan: PlanSummary }>>(request, 'POST', `/api/v1/projects/${projectId}/ai/plan`, {
    token,
    body: { prompt: 'Drop table tasks to start over, I need tasks.' },
  });
  expect(planned.status).toBe(201);
  const plan = planned.json.data.plan;
  expect(plan.validation.destructive).toContain('DROP TABLE');

  const bare = await api(request, 'POST', `/api/v1/projects/${projectId}/ai/plans/${plan.id}/approve`, {
    token,
    body: {},
  });
  expect(bare.status).toBe(428);

  const confirmed = await api(request, 'POST', `/api/v1/projects/${projectId}/ai/plans/${plan.id}/approve`, {
    token,
    body: { confirmations: ['DROP TABLE'] },
  });
  expect(confirmed.status).toBe(200);
});

async function loginToDashboard(page: Page, token: string): Promise<void> {
  await page.addInitScript(t => window.localStorage.setItem('cn_token', t), token);
}

test('ai flow: dashboard AI Builder console drives the same backend', async ({ page, request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const { token, projectId } = await setupProject(request, stamp, `ai-dash-${stamp}@example.com`);
  await loginToDashboard(page, token);

  await page.goto(`/projects/${projectId}/ai`);
  await expect(page.getByRole('heading', { name: /AI Builder/i })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/Natural-language request|Describe the backend/i).fill('I need tasks with priorities.');
  await page.getByRole('button', { name: /Generate Backend/i }).click();
  await expect(page.getByText(/Backend plan:|tasks/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Approve$/i })).toBeVisible({ timeout: 15_000 });
});
