import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Capabilities index: all 100 capabilities are discoverable from the UI,
 * each links to the console where it runs, and previously backend-only
 * surfaces (branches, vault, power tools, budgets, domains, drains)
 * render functional panels in their sections.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

interface Envelope<T> {
  data: T;
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

async function signupOrgProject(
  request: APIRequestContext,
  stamp: string,
): Promise<{ token: string; orgId: string; projectId: string; email: string; password: string }> {
  const email = `caps-${stamp}@example.com`;
  const password = 'capabilities-verify-1';
  const signup = await api<Envelope<{ token: string }>>(request, 'POST', '/api/v1/auth/signup', {
    body: { email, password },
  });
  expect(signup.status, 'API must be running (signup)').toBe(201);
  const token = signup.json.data.token;
  const org = await api<Envelope<{ organization: { id: string } }>>(
    request,
    'POST',
    '/api/v1/organizations',
    { token, body: { name: `caps-${stamp}`, slug: `caps-${stamp}` } },
  );
  expect(org.status).toBe(201);
  const orgId = org.json.data.organization.id;
  const project = await api<Envelope<{ project: { id: string } }>>(request, 'POST', '/api/v1/projects', {
    token,
    body: { name: `caps-${stamp}`, slug: `caps-${stamp}`, organizationId: orgId },
  });
  expect(project.status).toBe(202);
  return { token, orgId, projectId: project.json.data.project.id, email, password };
}

async function login(page: Parameters<Parameters<typeof test>[1]>[0]['page'], email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

test('capabilities index shows all 100 with search, filter and working links', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email, password } = await signupOrgProject(request, stamp);
  await login(page, email, password);

  // Sidebar entry point (no duplicates: exactly one Capabilities nav item).
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Capabilities' })).toHaveCount(
    1,
  );

  await page.goto('/capabilities');
  await expect(page.getByRole('heading', { name: /capabilities · 100/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('caps-count')).toContainText('100 of 100', { timeout: 15_000 });
  await expect(page.locator('[data-testid^="cap-"]')).toHaveCount(100);

  // Category filter narrows to the 11 Auth capabilities.
  await page.getByLabel(/filter by category/i).selectOption('Auth');
  await expect(page.getByTestId('caps-count')).toContainText('11 of 100');
  await expect(page.locator('[data-testid^="cap-"]')).toHaveCount(11);
  await expect(page.getByTestId('cap-auth-app-users')).toBeVisible();

  // Search finds the vault capability.
  await page.getByLabel(/filter by category/i).selectOption('');
  await page.getByLabel(/search capabilities/i).fill('vault');
  await expect(page.getByTestId('cap-env-vault')).toBeVisible({ timeout: 10_000 });

  // Capability links resolve into the project console when a project is in context.
  await page.getByLabel(/search capabilities/i).fill('');
  await page.getByLabel(/filter by category/i).selectOption('');
  const href = await page
    .getByTestId('cap-db-guarded-sql')
    .getByRole('link', { name: /open in console/i })
    .getAttribute('href');
  expect(href).toBe(`/projects/${projectId}/sql`);

  // Command palette surfaces the catalog and individual capabilities.
  await page.keyboard.press('Control+k');
  await page.getByLabel(/search commands/i).fill('capabilities · 100');
  await expect(page.getByRole('option', { name: /capabilities · 100/i })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('previously backend-only capabilities render functional panels', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, orgId: _orgId, email, password } = await signupOrgProject(request, stamp);
  void _orgId;
  await login(page, email, password);

  // Project settings: branches, vault, power tools + environments strip.
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole('heading', { name: /database branches/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: /project vault/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /database power tools/i })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /environments capabilities/i }),
  ).toBeVisible();

  // Section strips appear across the console without duplicating existing UI.
  await page.goto(`/projects/${projectId}/database`);
  await expect(page.getByRole('heading', { name: /database capabilities/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(`/projects/${projectId}/automations`);
  await expect(page.getByRole('heading', { name: /automation capabilities/i })).toBeVisible({
    timeout: 20_000,
  });

  // Billing: spend budgets panel + strip.
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: /spend budgets/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: /billing capabilities/i })).toBeVisible();

  // Organizations: custom domains, log drains, platform status.
  await page.goto('/organizations');
  await expect(
    page.getByRole('heading', { name: 'Custom domains', exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: 'Log drains', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Platform status', exact: true })).toBeVisible();

  // Project overview links the catalog.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: /capabilities · 100/i })).toBeVisible({
    timeout: 20_000,
  });
});
