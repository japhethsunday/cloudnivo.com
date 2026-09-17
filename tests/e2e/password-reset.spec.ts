import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Forgot-password, end to end in a browser.
 *
 * The one thing a browser test can prove that a unit test cannot: the pages
 * are reachable from where a locked-out person actually starts (the sign-in
 * form), and the confirmation never tells them whether the address exists.
 *
 * The emailed token cannot be read from here — the e2e stack has no mail
 * sender — so the reset PAGE is exercised with a token the API refuses,
 * which is exactly what a stale or tampered link looks like to a user. The
 * happy path of spending a valid token is covered against the real store in
 * apps/api/src/password-reset.test.ts.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';
const PASSWORD = 'Reset-e2e-original-1';

async function signup(request: APIRequestContext, email: string): Promise<void> {
  const res = await request.fetch(`${API}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status(), 'API must be running (signup)').toBe(201);
}

async function requestReset(page: Page, email: string): Promise<void> {
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole('button', { name: /send reset link/i }).click();
  await expect(page.getByRole('heading', { name: /check your inbox/i })).toBeVisible({
    timeout: 20_000,
  });
}

test('a locked-out user can reach the reset flow from sign-in', async ({ page, request }) => {
  const email = `reset-e2e-${Date.now() % 1000000}@example.com`;
  await signup(request, email);

  await page.goto('/login');
  await page.getByRole('link', { name: /forgot password/i }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await expect(page.getByRole('heading', { name: /reset your password/i })).toBeVisible({
    timeout: 20_000,
  });

  await requestReset(page, email);
});

test('the confirmation is identical for an unknown address', async ({ page, request }) => {
  const known = `reset-known-${Date.now() % 1000000}@example.com`;
  await signup(request, known);

  await page.goto('/forgot-password');
  await requestReset(page, known);
  const knownText = await page.getByTestId('auth-card').innerText();

  await page.goto('/forgot-password');
  await requestReset(page, `reset-nobody-${Date.now() % 1000000}@example.com`);
  const unknownText = await page.getByTestId('auth-card').innerText();

  // Byte-identical: the page must not hint at whether the account exists.
  expect(unknownText).toBe(knownText);
});

test('the signup form guides the password rules and blocks a mismatch', async ({ page }) => {
  await page.goto('/signup');
  const submit = page.getByRole('button', { name: /create account/i });
  await expect(submit).toBeDisabled();

  await page.getByLabel(/^email$/i).fill(`rules-${Date.now() % 1000000}@example.com`);
  await page.getByLabel(/^password$/i).fill('short');
  // Both rules unmet, so the form stays closed.
  await expect(page.locator('.password-rules li[data-met="true"]')).toHaveCount(0);
  await expect(submit).toBeDisabled();

  await page.getByLabel(/^password$/i).fill('Str0ng-Passw0rd!x');
  await expect(page.locator('.password-rules li[data-met="true"]')).toHaveCount(2);

  // A mismatch is stated inline, not after a round trip.
  await page.getByLabel(/confirm password/i).fill('Str0ng-Passw0rd!y');
  await expect(page.getByText(/do not match yet/i)).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByLabel(/confirm password/i).fill('Str0ng-Passw0rd!x');
  await expect(page.getByText(/do not match yet/i)).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

test('the password reveal shows and hides the value', async ({ page }) => {
  await page.goto('/signup');
  const field = page.locator('#signup-password');
  await field.fill('Str0ng-Passw0rd!x');
  await expect(field).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: /show password/i }).first().click();
  await expect(field).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: /hide password/i }).first().click();
  await expect(field).toHaveAttribute('type', 'password');
});

test('a stale or tampered reset link is refused, and an empty one is explained', async ({
  page,
}) => {
  // No token at all: the page says what went wrong instead of rendering a form.
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: /link is incomplete/i })).toBeVisible({
    timeout: 20_000,
  });

  // A token the server has never issued.
  await page.goto(`/reset-password?token=${'a'.repeat(43)}`);
  await page.locator('#reset-password').fill('Str0ng-Passw0rd!x');
  await page.locator('#reset-confirm').fill('Str0ng-Passw0rd!x');
  await page.getByRole('button', { name: /set new password/i }).click();
  await expect(page.getByText(/invalid or has expired/i)).toBeVisible({ timeout: 20_000 });
});

test('the auth pages hold up on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/signup', '/forgot-password']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} must not scroll sideways`).toBeLessThanOrEqual(0);
  }
});
