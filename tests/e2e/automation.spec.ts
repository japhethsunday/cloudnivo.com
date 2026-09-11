import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Automation backend: queues publish/consume, cron schedules, signed webhook
 * deliveries with history, request metrics, CSV round-trip, and AI diagnose —
 * all through the real HTTP API. External delivery targets are unreachable
 * from CI, so the webhook assertion covers the honest failure path
 * (attempt recorded, retry scheduled) while the signed-success path is
 * covered by unit tests with a stub transport.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

async function api<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: boolean } = {},
): Promise<{ status: number; json: T; text: string; headers: Headers }> {
  const res = await request.fetch(`${API}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    data: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json = {} as T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    // Non-JSON bodies (CSV export) stay as text.
  }
  return { status: res.status(), json, text, headers: res.headers() };
}

test('automation: queues, schedules, webhooks, metrics, csv, diagnose', async ({
  page,
  request,
}) => {
  const stamp = Date.now() % 1000000;
  const signup = await api<{ data: { token: string } }>(request, 'POST', '/api/v1/auth/signup', {
    body: { email: `auto-${stamp}@example.com`, password: 'automation-e2e-11' },
  });
  expect(signup.status).toBe(201);
  const token = signup.json.data.token;
  const org = await api<{ data: { organization: { id: string } } }>(request, 'POST', '/api/v1/organizations', {
    token,
    body: { name: `Auto ${stamp}`, slug: `auto${stamp}` },
  });
  const orgId = org.json.data.organization.id;
  const created = await api<{ data: { project: { id: string } } }>(request, 'POST', '/api/v1/projects', {
    token,
    body: { name: `Auto ${stamp}`, slug: `auto${stamp}`, organizationId: orgId },
  });
  expect(created.status).toBe(202);
  const projectId = created.json.data.project.id;

  // Queues: publish → consume → ack.
  const q = await api<{ data: { queue: { id: string } } }>(request, 'POST', `/api/v1/projects/${projectId}/queues`, {
    token,
    body: { name: 'work' },
  });
  expect(q.status).toBe(201);
  const queueId = q.json.data.queue.id;
  expect(
    (
      await api(request, 'POST', `/api/v1/projects/${projectId}/queues/${queueId}/messages`, {
        token,
        body: { body: { n: 1 } },
      })
    ).status,
  ).toBe(201);
  const leased = await api<{ data: { messages: { id: string }[] } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/queues/${queueId}/consume`,
    { token, body: {} },
  );
  expect(leased.json.data.messages).toHaveLength(1);
  expect(
    (
      await api(
        request,
        'POST',
        `/api/v1/projects/${projectId}/queues/${queueId}/messages/${leased.json.data.messages[0]?.id}/ack`,
        { token, body: {} },
      )
    ).status,
  ).toBe(200);

  // Schedules: invalid cron rejected, valid stored with a next run.
  expect(
    (
      await api(request, 'POST', `/api/v1/projects/${projectId}/schedules`, {
        token,
        body: { name: 'bad', functionSlug: 'x', cron: 'nope' },
      })
    ).status,
  ).toBe(400);
  const sched = await api<{ data: { schedule: { id: string; nextRunAt: string } } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/schedules`,
    { token, body: { name: 'hourly', functionSlug: 'reporter', cron: '0 * * * *' } },
  );
  expect(sched.status).toBe(201);
  expect(sched.json.data.schedule.nextRunAt).toBeTruthy();

  // Webhooks: secret once, test delivery attempts honestly, history records.
  const hook = await api<{ data: { webhook: { id: string }; secret: string } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/webhooks`,
    { token, body: { name: 'ops', url: 'https://example.com/hook', eventTypes: ['job.failed'] } },
  );
  expect(hook.status).toBe(201);
  expect(hook.json.data.secret.startsWith('whsec_')).toBe(true);
  const hookId = hook.json.data.webhook.id;
  const tested = await api<{ data: { delivery: { attempts: unknown[] } } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/webhooks/${hookId}/test`,
    { token, body: {} },
  );
  expect(tested.status).toBe(200);
  expect(tested.json.data.delivery.attempts).toHaveLength(1);
  const history = await api<{ data: { deliveries: unknown[] } }>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/webhooks/${hookId}/deliveries`,
    { token },
  );
  expect(history.json.data.deliveries.length).toBeGreaterThan(0);

  // Metrics: this traffic is counted.
  const metrics = await api<{ data: { requests: number; projects: string[] } }>(
    request,
    'GET',
    `/api/v1/organizations/${orgId}/metrics?window=1h&projectId=${projectId}`,
    { token },
  );
  expect(metrics.status).toBe(200);
  expect(metrics.json.data.requests).toBeGreaterThan(0);
  expect(metrics.json.data.projects).toEqual([projectId]);

  // CSV: import then export the same row.
  const rowId = '22222222-3333-4444-8555-666666666666';
  const imp = await api<{ data: { inserted: number; failed: number } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/users/import`,
    { token, body: { csv: `id,email,age\r\n${rowId},auto${stamp}@example.com,3\r\n` } },
  );
  expect(imp.json.data).toMatchObject({ inserted: 1, failed: 0 });
  const exp = await api(request, 'GET', `/api/v1/projects/${projectId}/users/export`, { token });
  expect(exp.status).toBe(200);
  expect(exp.headers['content-type'] ?? '').toContain('text/csv');
  expect(exp.text).toContain(`auto${stamp}@example.com`);

  // Diagnose: structured, honest shape.
  const diag = await api<{ data: { diagnosis: { healthy: boolean; confidence: string } } }>(
    request,
    'POST',
    `/api/v1/projects/${projectId}/ai/diagnose`,
    { token, body: {} },
  );
  expect(diag.status).toBe(200);
  expect(['low', 'medium', 'high']).toContain(diag.json.data.diagnosis.confidence);

  // Dashboard: the new planes render.
  await page.addInitScript(t => window.localStorage.setItem('cn_token', t), token);
  await page.goto(`/projects/${projectId}/automations`);
  await expect(page.getByRole('heading', { name: /^automations$/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /^queues$/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^schedules$/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^webhooks$/i })).toBeVisible();
  await page.goto(`/projects/${projectId}/metrics`);
  await expect(page.getByRole('heading', { name: /^metrics$/i })).toBeVisible({ timeout: 15_000 });
});
