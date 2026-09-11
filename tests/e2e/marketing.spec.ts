import { expect, test, type APIRequestContext } from '@playwright/test';

/** Homepage + auth journey: public pages, failed login, next-redirect, sidebar persistence. */

const API = process.env.API_URL ?? 'http://localhost:3001';

async function signup(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const res = await request.fetch(`${API}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ email, password: 'marketing-journey-1' }),
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

test('homepage renders the full story without overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /build, deploy and scale/i })).toBeVisible({ timeout: 15_000 });
  for (const name of [/one platform, every primitive/i, /describe it/i, /everything a backend needs/i, /from idea to scale/i, /your backend. one platform./i]) {
    await expect(page.getByRole('heading', { name }).first()).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /^start building$/i }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('homepage theme toggle switches light and dark', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /build, deploy and scale/i })).toBeVisible({ timeout: 15_000 });
  const header = page.locator('header').first();
  await header.getByRole('button', { name: /^dark theme$/i }).click();
  await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: /build, deploy and scale/i })).toBeVisible();
  await header.getByRole('button', { name: /^light theme$/i }).click();
  await expect(page.locator('html[data-theme="light"]')).toHaveCount(1);
});

test('mobile menu opens and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /open menu/i }).click();
  await page.getByRole('navigation', { name: /mobile/i }).getByRole('link', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('failed login explains the problem without internals', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('nobody@example.com');
  await page.getByLabel(/password/i).fill('wrong-password-123');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 15_000 });
  const text = (await alert.innerText()).toLowerCase();
  expect(text).not.toContain('stack');
  expect(text).not.toContain('something went wrong');
});

test('login honors next and sidebar collapse persists', async ({ page, request }) => {
  const stamp = Date.now() % 1000000;
  await signup(request, `mkt-${stamp}@example.com`);

  await page.goto('/projects/new');
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 15_000 });
  await page.getByLabel(/email/i).fill(`mkt-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('marketing-journey-1');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/projects\/new$/, { timeout: 15_000 });

  const shell = page.locator('.shell');
  await page.getByRole('button', { name: /collapse sidebar/i }).click();
  await expect(shell).toHaveClass(/collapsed/);
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('cn_sidebar')), { timeout: 5_000 })
    .toBe('collapsed');
  await page.reload();
  await expect(page.getByRole('heading', { name: /create project/i })).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveClass(/collapsed/);
  await page.getByRole('button', { name: /expand sidebar/i }).click();
  await expect(shell).not.toHaveClass(/collapsed/);
});
