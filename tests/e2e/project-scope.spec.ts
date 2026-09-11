import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Wizard org-scope regression: the organization chosen in the new-project
 * wizard must persist to the workspace selection immediately, so the
 * projects list (which filters by that selection) keeps showing the new
 * project's scope after creation, reloads, and navigation.
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

test('wizard org choice persists across reload and drives the projects filter', async ({
  page,
  request,
}) => {
  const stamp = Date.now() % 1000000;
  const signup = await api<{ data: { token: string } }>(request, 'POST', '/api/v1/auth/signup', {
    body: { email: `scope-${stamp}@example.com`, password: 'scope-regression-1' },
  });
  expect(signup.status).toBe(201);
  const setupToken = signup.json.data.token;
  for (const suffix of ['a', 'b']) {
    const org = await api(request, 'POST', '/api/v1/organizations', {
      token: setupToken,
      body: { name: `Scope ${stamp} ${suffix}`, slug: `scope${stamp}${suffix}` },
    });
    expect(org.status).toBe(201);
  }
  const orgs = await api<{ data: { organizations: { id: string; slug: string }[] } }>(
    request,
    'GET',
    '/api/v1/organizations',
    { token: setupToken },
  );
  const orgB = orgs.json.data.organizations.find(o => o.slug === `scope${stamp}b`);
  expect(orgB).toBeDefined();
  const created = await api<{ data: { project: { id: string } } }>(
    request,
    'POST',
    '/api/v1/projects',
    {
      token: setupToken,
      body: { name: `Scope ${stamp}`, slug: `scope${stamp}`, organizationId: orgB!.id },
    },
  );
  expect(created.status).toBe(202);

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(`scope-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('scope-regression-1');
  await page.getByRole('button', { name: /^log in$/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  // Pick org B in the wizard: the persisted selection must follow at once.
  await page.goto('/projects/new');
  await page.locator('#np-org').selectOption(orgB!.id);
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('cn_org')), { timeout: 5_000 })
    .toBe(orgB!.id);

  // A reload mid-wizard must keep the scope (root cause of "lost" projects).
  await page.reload();
  await expect(page.locator('#np-org')).toHaveValue(orgB!.id);

  // The projects list filter follows the same selection, and the project
  // created in org B stays visible + openable under it.
  await page.goto('/projects');
  await expect(page.getByLabel('Filter by organization')).toHaveValue(orgB!.id);
  await page.getByRole('link', { name: new RegExp(`Scope ${stamp}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${created.json.data.project.id}$`));
});
