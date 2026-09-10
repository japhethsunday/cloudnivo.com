import { defineConfig } from '@playwright/test';

/**
 * CloudNivo Playwright smoke: signup → org → project → key → data CRUD →
 * file upload → 403 cross-org, plus a dashboard render pass.
 *
 * Requires a running stack (API with PROVISION_DRIVER=fake for speed, and
 * the dashboard for the browser pass):
 *
 *   PROVISION_DRIVER=fake npm run dev:api   # :3001
 *   npm run dev                             # :3000
 *   API_URL=http://localhost:3001 DASHBOARD_URL=http://localhost:3000 \
 *     npm run test:e2e
 *
 * Browsers install separately (`npx playwright install chromium`) and are
 * never part of `npm test` (vitest only picks up *.test.ts).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  outputDir: '../../test-results',
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
});
