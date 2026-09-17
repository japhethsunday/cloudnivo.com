import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The operator console, end to end.
 *
 * The one thing worth proving in a browser is the boundary: an ordinary
 * developer must not see the Platform nav group, and must not be able to
 * reach /admin by typing it. The e2e stack boots without
 * PLATFORM_ADMIN_EMAILS, so every account it creates is a developer — which
 * is exactly the case this test needs.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

async function signup(
  request: APIRequestContext,
  stamp: string,
): Promise<{ email: string; password: string }> {
  const email = `admin-e2e-${stamp}@example.com`;
  const password = 'operator-console-9';
  const res = await request.fetch(`${API}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ email, password }),
  });
  expect(res.status(), 'API must be running (signup)').toBe(201);
  const body = (await res.json()) as { data: { user: { isPlatformAdmin?: boolean } } };
  // Nobody becomes staff by signing up.
  expect(body.data.user.isPlatformAdmin ?? false).toBe(false);
  return { email, password };
}

test('the operator console is invisible to an ordinary developer', async ({ page, request }) => {
  const stamp = `${Date.now() % 1000000}`;
  const { email, password } = await signup(request, stamp);

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // No Platform group, no console link.
  await expect(page.locator('.sidebar').getByText('Platform', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /operator console/i })).toHaveCount(0);
  // The first nav group a non-staff user sees is still their workspace.
  await expect(page.locator('.sidebar .nav-context').first()).toHaveText(/workspace/i);

  // Typing the URL says so plainly rather than rendering empty chrome.
  await page.goto('/admin');
  await expect(page.getByText(/limited to cloudnivo staff/i)).toBeVisible({ timeout: 20_000 });

  // And the API itself denies it — the page is not the security boundary.
  const direct = await request.fetch(`${API}/api/v1/admin/overview`);
  expect(direct.status()).toBe(404);
});
