import { expect, test } from '@playwright/test';

/** Account center + settings: real profile edit, password change, tabs. */
test('account center manages profile and password', async ({ page }) => {
  const stamp = Date.now() % 1000000;
  await page.goto('/signup');
  await page.getByLabel(/display name/i).fill('Orig Name');
  await page.getByLabel(/email/i).fill(`acct-${stamp}@example.com`);
  await page.locator('#signup-password').fill('acct-password-111');
  await page.locator('#signup-confirm').fill('acct-password-111');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: /^account$/i })).toBeVisible({ timeout: 15_000 });
  // Section nav works.
  await page.getByRole('button', { name: /^security$/i }).click();
  await expect(page.getByRole('heading', { name: /change password/i })).toBeVisible();
  await page.getByRole('button', { name: /^profile$/i }).click();
  // Edit display name for real.
  await page.getByLabel(/display name/i).fill('Renamed User');
  await page.getByRole('button', { name: /save profile/i }).click();
  await expect(page.getByText(/renamed user/i).first()).toBeVisible({ timeout: 15_000 });

  // Change password for real, then log out and back in with the new one.
  await page.getByRole('button', { name: /^security$/i }).click();
  await page.getByLabel(/current password/i).fill('acct-password-111');
  await page.getByLabel(/new password/i).fill('acct-password-222');
  await page.getByRole('button', { name: /^change password$/i }).click();
  await expect(page.getByText(/password changed/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /^log out$/i }).first().click();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/email/i).fill(`acct-${stamp}@example.com`);
  await page.getByLabel(/password/i).fill('acct-password-222');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  // Login returns to the pre-logout page via ?next= — either way the session is back.
  await expect(page.getByRole('button', { name: new RegExp(`Account: acct-${stamp}@example.com`, 'i') })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });
});

test('settings center tabs all render working controls', async ({ page }) => {
  const stamp = Date.now() % 1000000;
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(`set-${stamp}@example.com`);
  await page.locator('#signup-password').fill('set-password-1111');
  await page.locator('#signup-confirm').fill('set-password-1111');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 15_000 });
  for (const tab of ['Appearance', 'Developer', 'Security', 'Workspace']) {
    await page.getByRole('button', { name: new RegExp(`^${tab}$`, 'i') }).click();
  }
  // Appearance control actually switches theme.
  await page.getByRole('button', { name: /^appearance$/i }).click();
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);
  // Developer tab shows API base and copy works.
  await page.getByRole('button', { name: /^developer$/i }).click();
  await expect(page.getByText(/api base/i)).toBeVisible();
});
