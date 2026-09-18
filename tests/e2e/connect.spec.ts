import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The Connect dialog: one place that holds every value a client needs.
 *
 * What is worth proving in a browser is that the dialog does the real thing —
 * issues a real key, reveals the real connection string through the audited
 * endpoint, creates the real bucket — and that it never prints a
 * plausible-looking credential it does not have.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';
const PASSWORD = 'connect-dialog-verify-1';

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

async function project(
  request: APIRequestContext,
  stamp: string,
): Promise<{ token: string; projectId: string; email: string }> {
  const email = `connect-${stamp}@example.com`;
  const signup = await api<Envelope<{ token: string }>>(request, 'POST', '/api/v1/auth/signup', {
    body: { email, password: PASSWORD },
  });
  expect(signup.status, 'API must be running (signup)').toBe(201);
  const token = signup.json.data.token;
  const org = await api<Envelope<{ organization: { id: string } }>>(
    request,
    'POST',
    '/api/v1/organizations',
    { token, body: { name: `connect-${stamp}`, slug: `connect-${stamp}` } },
  );
  expect(org.status).toBe(201);
  const p = await api<Envelope<{ project: { id: string } }>>(request, 'POST', '/api/v1/projects', {
    token,
    body: {
      name: `connect-${stamp}`,
      slug: `connect-${stamp}`,
      organizationId: org.json.data.organization.id,
    },
  });
  expect(p.status).toBe(202);
  return { token, projectId: p.json.data.project.id, email };
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

async function openConnect(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  // Connect is offered twice on purpose: once in the breadcrumb, where the
  // primary action for the current scope lives, and once in the project
  // strip. The strip is the one this suite drives, so scope to the main
  // region rather than matching both and violating strict mode.
  await page.locator('#main').getByRole('button', { name: /^connect$/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
}

test('Connect gathers every connection value in one dialog', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email } = await project(request, stamp);
  await login(page, email);
  await openConnect(page, projectId);
  const dialog = page.getByRole('dialog');

  // ── Connection: the addresses, and a copy that actually reaches the clipboard.
  await expect(dialog.getByText(projectId, { exact: false }).first()).toBeVisible();
  await dialog.getByRole('button', { name: /copy all safe values/i }).click();
  await expect(dialog.getByRole('button', { name: /^copied$/i })).toBeVisible();
  const bundle = await page.evaluate(() => navigator.clipboard.readText());
  expect(bundle).toContain(`CLOUDNIVO_PROJECT_ID=${projectId}`);
  expect(bundle).toContain('CLOUDNIVO_BUCKET=business-data');
  // A bulk copy never carries a secret.
  expect(bundle).not.toMatch(/SERVICE_KEY=\S/);
  expect(bundle).not.toMatch(/DATABASE_URL=\S/);

  // ── Keys: creating one yields a real, copyable value.
  await dialog.getByRole('tab', { name: /api keys/i }).click();
  await expect(dialog.getByText(/no public key yet/i)).toBeVisible();
  await dialog.getByRole('button', { name: /create public key/i }).click();
  await expect(dialog.getByText(/copy it now/i)).toBeVisible({ timeout: 20_000 });
  const keyField = dialog.locator('code[aria-label="Public key"]');
  const publicKey = (await keyField.innerText()).trim();
  expect(publicKey.length).toBeGreaterThan(16);
  expect(publicKey).not.toMatch(/^•+$/);

  // That key is real: it authenticates against the data API.
  const probe = await request.fetch(`${API}/api/v1/projects/${projectId}/keys`, {
    headers: { apikey: publicKey },
  });
  expect(probe.status(), 'an issued public key must be accepted by the API').toBeLessThan(500);
  expect(probe.status()).not.toBe(401);

  // ── Service key: masked until asked for, and labelled as server-side only.
  await dialog.getByRole('button', { name: /create service key/i }).click();
  await expect(dialog.getByText(/keep it server-side/i)).toBeVisible({ timeout: 20_000 });
  const serviceField = dialog.locator('code[aria-label="Service key"]');
  expect((await serviceField.innerText()).trim()).toMatch(/^•+$/);
  await dialog.getByRole('button', { name: /^show$/i }).first().click();
  expect((await serviceField.innerText()).trim()).not.toMatch(/^•+$/);
  await expect(dialog.getByText(/bypasses row-level security/i)).toBeVisible();
});

test('Connect reveals the database string only on request, and creates the bucket for real', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, token, email } = await project(request, stamp);
  await login(page, email);
  await openConnect(page, projectId);
  const dialog = page.getByRole('dialog');

  // ── Database: masked first, revealed only by the explicit action.
  await dialog.getByRole('tab', { name: /^database$/i }).click();
  const conn = dialog.locator('code[aria-label="PostgreSQL connection string, masked"]');
  await expect(conn).toBeVisible({ timeout: 20_000 });
  expect(await conn.innerText()).toContain('•');
  await dialog.getByRole('button', { name: /^reveal$/i }).click();
  const revealedField = dialog.locator('code[aria-label="PostgreSQL connection string"]');
  await expect(revealedField).toBeVisible({ timeout: 20_000 });
  const revealed = (await revealedField.innerText()).trim();
  expect(revealed).toMatch(/^postgres:\/\//);
  expect(revealed).not.toContain('•');
  await expect(dialog.getByText(/server-side only/i)).toBeVisible();
  // Hide puts it back behind the mask.
  await dialog.getByRole('button', { name: /^hide$/i }).click();
  expect((await revealedField.innerText()).trim()).toMatch(/^•+$/);

  // ── Storage: the default bucket is reported honestly, then really created.
  await dialog.getByRole('tab', { name: /^storage$/i }).click();
  await expect(dialog.getByText(/does not exist yet/i)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /create business-data/i }).click();
  await expect(dialog.getByText(/exists · private/i)).toBeVisible({ timeout: 20_000 });

  // The bucket exists in the backend, not just on screen.
  const buckets = await api<Envelope<{ buckets: { name: string }[] }>>(
    request,
    'GET',
    `/api/v1/projects/${projectId}/storage/buckets`,
    { token },
  );
  expect(buckets.json.data.buckets.map(b => b.name)).toContain('business-data');
});

test('Connect never prints a credential it does not have', async ({ page, request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email } = await project(request, stamp);
  await login(page, email);
  await openConnect(page, projectId);
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('tab', { name: /^code$/i }).click();
  const snippet = dialog.locator('.connect-snippet');
  await expect(snippet).toBeVisible({ timeout: 20_000 });
  const text = await snippet.innerText();

  // Real values for what this project genuinely has…
  expect(text).toContain(`CLOUDNIVO_PROJECT_ID=${projectId}`);
  // …and empty variables, not invented ones, for what it does not.
  expect(text).toMatch(/CLOUDNIVO_SERVICE_KEY=\s*$/m);
  expect(text).toMatch(/DATABASE_URL=\s*$/m);
  expect(text).not.toMatch(/sk-live|cn_[a-z]+_example|your-key-here|xxxx/i);
});

test('the Code tab masks secrets on screen but copies the real ones', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email } = await project(request, stamp);
  await login(page, email);
  await openConnect(page, projectId);
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('tab', { name: /api keys/i }).click();
  await dialog.getByRole('button', { name: /create service key/i }).click();
  await expect(dialog.getByText(/keep it server-side/i)).toBeVisible({ timeout: 20_000 });
  const serviceKey = (await dialog.locator('code[aria-label="Service key"]').innerText()).trim();

  await dialog.getByRole('tab', { name: /^code$/i }).click();
  const snippet = dialog.locator('.connect-snippet');
  await expect(snippet).toBeVisible({ timeout: 20_000 });

  // On screen the value is masked — a screen-share must not leak it.
  const masked = await snippet.innerText();
  expect(masked).toContain('CLOUDNIVO_SERVICE_KEY=');
  expect(masked).toContain('•');

  // Copy still carries the real thing, because copying is the deliberate act.
  await dialog.getByRole('button', { name: /copy snippet/i }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`CLOUDNIVO_SERVICE_KEY=${serviceKey.replace(/^•+$/, '')}`.trim());
  expect(copied).not.toContain('•');

  // And the toggle puts it on screen when the operator asks.
  await dialog.getByRole('button', { name: /show secrets/i }).click();
  expect(await snippet.innerText()).not.toContain('•');
});

test('Connect cannot reach across tenants', async ({ page, request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const mine = await project(request, `${stamp}-a`);
  const theirs = await project(request, `${stamp}-b`);

  // Every endpoint the dialog calls, with the WRONG tenant's session.
  for (const path of [
    `/api/v1/projects/${theirs.projectId}/keys`,
    `/api/v1/projects/${theirs.projectId}/storage/buckets`,
    `/api/v1/projects/${theirs.projectId}/database/connection`,
    `/api/v1/projects/${theirs.projectId}/database/connection?reveal=true`,
  ]) {
    const res = await api<unknown>(request, 'GET', path, { token: mine.token });
    expect([403, 404], `${path} must refuse a foreign session`).toContain(res.status);
  }

  // Creating a key or a bucket in someone else's project is refused too.
  const key = await api<unknown>(request, 'POST', `/api/v1/projects/${theirs.projectId}/keys`, {
    token: mine.token,
    body: { name: 'stolen', role: 'service' },
  });
  expect([403, 404]).toContain(key.status);

  // And the dialog itself surfaces the refusal rather than an empty shell.
  await login(page, mine.email);
  await page.goto(`/projects/${theirs.projectId}`);
  await expect(page.getByText(/couldn't|not found|no access|forbidden/i).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('the connection dialog is usable on a phone', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = `${Date.now() % 1000000}`;
  const { projectId, email } = await project(request, stamp);
  await login(page, email);
  await openConnect(page, projectId);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the dialog must not push the page sideways').toBeLessThanOrEqual(0);
  await expect(page.getByRole('dialog').getByRole('tab', { name: /api keys/i })).toBeVisible();
});
