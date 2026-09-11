import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Project lifecycle regression (exact user workflow):
 * Create (wizard UI) → Open → Leave → Return → Open again → Refresh →
 * Open again. The wizard's organization choice persists to the workspace
 * selection immediately, so the projects list never loses the new project.
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

test('create → open → leave → return → refresh → open keeps working', async ({
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

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(`scope-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('scope-regression-1');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  // CREATE through the real wizard in org B.
  await page.goto('/projects/new');
  await page.locator('#np-org').selectOption(orgB!.id);
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('cn_org')), { timeout: 5_000 })
    .toBe(orgB!.id);

  // A reload mid-wizard must keep the scope.
  await page.reload();
  await expect(page.locator('#np-org')).toHaveValue(orgB!.id);

  await page.getByLabel(/project name/i).fill(`Scope ${stamp}`);
  await page.getByRole('button', { name: /create project and provision/i }).click();
  // OPEN: provisioning (fake driver locally, real drivers stage it) → open.
  await page.getByRole('button', { name: /open project/i }).click({ timeout: 120_000 });
  await expect(page).toHaveURL(new RegExp(`/projects/[0-9a-f-]{36}$`));

  // LEAVE → RETURN → OPEN again.
  await page.goto('/settings');
  await page.goto('/projects');
  await expect(page.getByLabel('Filter by organization')).toHaveValue(orgB!.id);
  await page.getByRole('link', { name: new RegExp(`Scope ${stamp}`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/[0-9a-f-]{36}$`));

  // REFRESH → OPEN again.
  await page.reload();
  await page.goto('/projects');
  await page.getByRole('link', { name: new RegExp(`Scope ${stamp}`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/[0-9a-f-]{36}$`));
});
