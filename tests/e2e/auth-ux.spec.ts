import { expect, test } from '@playwright/test';

/** Pre-Phase 13 auth UX: no token pasting, real login → dashboard → projects flow. */
test('auth flow: landing redirects to login, signup reaches dashboard', async ({ page }) => {
  const stamp = Date.now() % 1000000;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /log in/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel(/email/i)).toBeVisible();
  // No developer token UI on the login page.
  await expect(page.getByText(/paste a bearer token/i)).toHaveCount(0);

  await page.getByRole('link', { name: /create an account/i }).click();
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  await page.getByLabel(/display name/i).fill('E2E User');
  await page.getByLabel(/email/i).fill(`e2e-auth-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('e2e-auth-password-1');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });
});

test('projects page needs no token and offers creation', async ({ page }) => {
  const stamp = Date.now() % 1000000;
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(`e2e-proj-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('e2e-auth-password-1');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: /^projects$/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/paste a bearer token/i)).toHaveCount(0);
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  // Empty state guides to organization creation (no raw endpoint text).
  await expect(page.getByText(/create an organization first/i)).toBeVisible();
  await expect(page.getByText(/POST \/api/i)).toHaveCount(0);
});
