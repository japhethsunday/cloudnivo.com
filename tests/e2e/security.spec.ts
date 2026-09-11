import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Security Center: seeds a public bucket and a never-expiring service key
 * through the real API, then asserts the scanner surfaces both as findings
 * with a computed score — no staged data anywhere in the chain.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

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

test('security scan surfaces seeded public bucket and immortal service key', async ({
  page,
  request,
}) => {
  const stamp = Date.now() % 1000000;
  const signup = await api<{ data: { token: string } }>(request, 'POST', '/api/v1/auth/signup', {
    body: { email: `sec-${stamp}@example.com`, password: 'security-scan-11' },
  });
  expect(signup.status).toBe(201);
  const token = signup.json.data.token;
  const org = await api<{ data: { organization: { id: string } } }>(request, 'POST', '/api/v1/organizations', {
    token,
    body: { name: `Sec ${stamp}`, slug: `sec${stamp}` },
  });
  expect(org.status).toBe(201);
  const created = await api<{ data: { project: { id: string } } }>(request, 'POST', '/api/v1/projects', {
    token,
    body: { name: `Sec ${stamp}`, slug: `sec${stamp}`, organizationId: org.json.data.organization.id },
  });
  expect(created.status).toBe(202);
  const projectId = created.json.data.project.id;

  const bucket = await api(request, 'POST', `/api/v1/projects/${projectId}/storage/buckets`, {
    token,
    body: { name: `leaky-${stamp}`, visibility: 'public' },
  });
  expect(bucket.status).toBe(201);
  const key = await api(request, 'POST', `/api/v1/projects/${projectId}/keys`, {
    token,
    body: { name: `immortal-${stamp}`, role: 'service' },
  });
  expect(key.status).toBe(201);

  await page.addInitScript(t => window.localStorage.setItem('cn_token', t), token);
  await page.goto('/security');
  await expect(page.getByRole('heading', { name: /^security$/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/public bucket/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/never expires/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/security score/i)).toBeVisible();
});
