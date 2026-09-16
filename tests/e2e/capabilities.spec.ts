import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Capabilities are a product-requirements checklist, NOT a page.
 * The 100 capabilities live as real workflows inside their product areas
 * (Database → Table Editor, Authentication → OTP/MFA, Storage → buckets,
 * Realtime → channels, …). `/capabilities` is an INTERNAL tracking index
 * only — never the primary experience, never a card grid.
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

test('capability registry is an internal tracking index, not the product', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email, password } = await signupOrgProject(request, stamp);
  await login(page, email, password);

  // The catalog is NOT in the primary navigation.
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Capabilities' })).toHaveCount(0);
  // …nor promoted on the dashboard or project overview.
  await expect(page.getByText(/100 capabilities/i)).toHaveCount(0);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: /capabilit/i })).toHaveCount(0);

  // The internal registry still tracks all 100 with working deep-links.
  await page.goto('/capabilities');
  await expect(page.getByRole('heading', { name: /capability registry \(internal\)/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('caps-count')).toContainText('100 of 100', { timeout: 15_000 });
  await expect(page.locator('[data-testid^="cap-"]')).toHaveCount(100);

  // Search narrows the registry.
  await page.getByLabel(/filter capability registry/i).fill('vault');
  await expect(page.getByTestId('cap-env-vault')).toBeVisible({ timeout: 10_000 });

  // Registry rows link into the real product area.
  await page.getByLabel(/filter capability registry/i).fill('');
  const href = await page
    .getByTestId('cap-db-guarded-sql')
    .getByRole('link', { name: /open/i })
    .getAttribute('href');
  expect(href).toBe(`/projects/${projectId}/sql`);
});

test('capabilities live as real workflows in their product areas', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, orgId: _orgId, email, password } = await signupOrgProject(request, stamp);
  void _orgId;
  await login(page, email, password);

  // Project settings: branches, vault, power tools.
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole('heading', { name: /database branches/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: /project vault/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /database power tools/i })).toBeVisible();

  // Database: one subject per view. The panels used to render together down a
  // single scroll; each is now a deep-linkable `?tab=` section, so the check
  // is that every section is reachable and renders its own panel.
  await page.goto(`/projects/${projectId}/database`);
  const dbTabs = page.getByRole('tablist', { name: /database sections/i });
  await expect(dbTabs.getByRole('tab', { name: /^connection$/i })).toBeVisible({
    timeout: 20_000,
  });
  // Connection is the landing view: the database's own facts and its secrets.
  const dbPanel = page.getByRole('tabpanel');
  await expect(dbPanel.getByRole('heading', { name: /^database$/i })).toBeVisible();
  await expect(dbPanel.getByRole('heading', { name: /^credentials$/i })).toBeVisible();

  for (const [tab, heading] of [
    [/^table editor$/i, /^rows$/i],
    [/^row-level security$/i, /^row-level security$/i],
    [/^extensions$/i, /^extensions$/i],
    [/^backups$/i, /^backups$/i],
  ] as [RegExp, RegExp][]) {
    await dbTabs.getByRole('tab', { name: tab }).click();
    await expect(dbPanel.getByRole('heading', { name: heading })).toBeVisible({ timeout: 20_000 });
  }

  // The section deep-links: a sidebar child lands directly on its own view.
  await page.goto(`/projects/${projectId}/database?tab=backups`);
  await expect(page.getByRole('heading', { name: /^backups$/i })).toBeVisible({ timeout: 20_000 });

  // Authentication: tabbed workspace with users, sign-in, MFA, sessions, security.
  await page.goto(`/projects/${projectId}/auth`);
  const tabs = page.getByRole('tablist', { name: /authentication sections/i });
  await expect(tabs.getByRole('tab', { name: /^users/i })).toBeVisible({ timeout: 20_000 });
  await expect(tabs.getByRole('tab', { name: /sign-in methods/i })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /^mfa$/i })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /^sessions$/i })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /^security$/i })).toBeVisible();

  // Storage. Move and copy used to be a standalone panel of three empty path
  // inputs; they are now actions on the file they act on, inside each row's
  // menu, so the page's own subject is the bucket list and its usage.
  await page.goto(`/projects/${projectId}/storage`);
  await expect(page.getByRole('heading', { name: /^buckets$/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('list', { name: /storage usage/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /create bucket/i })).toBeVisible();
  await page.goto(`/projects/${projectId}/realtime`);
  await expect(page.getByRole('heading', { name: /publish to a channel/i })).toBeVisible({
    timeout: 20_000,
  });

  // Integrations: repository subscriptions. Billing: spend budgets.
  await page.goto(`/projects/${projectId}/integrations`);
  await expect(page.getByRole('button', { name: /subscribe repository/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: /spend budgets/i })).toBeVisible({
    timeout: 20_000,
  });

  // Organizations: custom domains, log drains, platform status.
  await page.goto('/organizations');
  await expect(
    page.getByRole('heading', { name: 'Custom domains', exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { name: 'Log drains', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Platform status', exact: true })).toBeVisible();

  // No capability-catalog headings anywhere in the product experience.
  for (const url of [`/projects/${projectId}`, `/projects/${projectId}/database`, '/billing']) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: /capabilit/i })).toHaveCount(0);
  }
});
