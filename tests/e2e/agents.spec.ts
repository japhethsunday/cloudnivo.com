import { expect, test } from '@playwright/test';

/** Agent Access UI: create (one-time reveal), details, revoke with confirm. */
test('agent tokens: create, reveal once, revoke', async ({ page }) => {
  const stamp = Date.now() % 1000000;
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(`agent-${stamp}@example.com`);
  await page.locator('#signup-password').fill('agent-ui-password-1');
  await page.locator('#signup-confirm').fill('agent-ui-password-1');
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible({ timeout: 15_000 });

  await page.goto('/organizations');
  await page.getByRole('button', { name: /new organization/i }).first().click();
  await page.getByLabel(/^name$/i).fill(`Agent Org ${stamp}`);
  await page.getByLabel(/slug/i).fill(`agentorg${stamp}`);
  await page
    .getByRole('dialog', { name: /new organization/i })
    .getByRole('button', { name: /^create organization$/i })
    .click();
  await expect(page.getByText(`Agent Org ${stamp}`, { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: /agent access/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /new agent token/i }).first().click();
  await page.getByLabel(/agent name/i).fill('E2E Agent');
  await page.getByRole('button', { name: /^create token$/i }).click();
  // One-time reveal shows the raw value exactly once.
  const reveal = page.getByRole('dialog', { name: /copy your agent token/i });
  await expect(reveal).toBeVisible({ timeout: 15_000 });
  const raw = await reveal.locator('code').first().innerText();
  expect(raw.startsWith('cn_agent_')).toBe(true);
  await reveal.getByRole('button', { name: /^done$/i }).click();
  // Token listed with prefix (never the raw value again).
  await expect(page.getByText(raw)).toHaveCount(0);
  await page.getByRole('button', { name: /^details$/i }).first().click();
  await expect(page.getByRole('dialog').getByText(/scopes \(/i)).toBeVisible();
  await page.getByRole('button', { name: /^close$/i }).click();
  // Revoke with confirmation kills it.
  await page.getByRole('button', { name: /^revoke$/i }).first().click();
  await expect(page.getByText(/stops working.*immediately/i)).toBeVisible();
  await page.getByRole('button', { name: /^revoke now$/i }).click();
  await expect(page.getByText(/revoked/i).first()).toBeVisible({ timeout: 15_000 });
});
