import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Project navigation regression: a project must stay openable through
 * dashboard → projects → detail cycles, refreshes, and direct URLs.
 * Uses the API for setup (fast, few requests); the UI for every click.
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

test('project stays clickable across navigation, refresh, and direct URL', async ({
  page,
  request,
}) => {
  const stamp = Date.now() % 1000000;
  const signup = await api<{ data: { token: string } }>(request, 'POST', '/api/v1/auth/signup', {
    body: { email: `nav-${stamp}@example.com`, password: 'nav-regression-1' },
  });
  expect(signup.status).toBe(201);
  const setupToken = signup.json.data.token;
  const org = await api<{ data: { organization: { id: string } } }>(
    request,
    'POST',
    '/api/v1/organizations',
    { token: setupToken, body: { name: `Nav ${stamp}`, slug: `nav${stamp}` } },
  );
  expect(org.status).toBe(201);
  const created = await api<{ data: { project: { id: string }; jobId: string } }>(
    request,
    'POST',
    '/api/v1/projects',
    {
      token: setupToken,
      body: { name: `Nav ${stamp}`, slug: `nav${stamp}`, organizationId: org.json.data.organization.id },
    },
  );
  expect(created.status).toBe(202);
  const projectId = created.json.data.project.id;

  // Sign in through the real login form once (proves the auth UI works).
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(`nav-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('nav-regression-1');
  await page.getByRole('button', { name: /^log in$/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  // Dashboard → projects → click project.
  await page.goto('/dashboard');
  await page.goto('/projects');
  await page.getByRole('link', { name: new RegExp(`Nav ${stamp}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));

  // Leave, return, click again.
  await page.goto('/settings');
  await page.goto('/projects');
  await page.getByRole('link', { name: new RegExp(`Nav ${stamp}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));

  // Refresh, click again — the session and links must survive.
  await page.reload();
  await page.goto('/projects');
  await page.getByRole('link', { name: new RegExp(`Nav ${stamp}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));

  // Direct deep URL renders the workspace, not the login page.
  await page.goto(`/projects/${projectId}/usage`);
  await expect(page.getByRole('heading', { name: /period|plan|usage/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: /log in/i })).toHaveCount(0);
});
