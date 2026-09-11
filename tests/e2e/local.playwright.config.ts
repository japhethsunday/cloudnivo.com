import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Local-only wrapper: boots the built API + dashboard the way CI does,
// runs the selected specs, then tears everything down in one foreground
// process (no detached servers needed).
export default defineConfig({
  ...base,
  webServer: [
    {
      command: 'node apps/api/dist/index.js',
      cwd: '../..',
      port: 3001,
      timeout: 90_000,
      reuseExistingServer: true,
      env: {
        JWT_SECRET: 'local-e2e-only-not-a-secret-0123456789abcdef',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        CORS_ORIGINS: 'http://127.0.0.1:3000',
        API_PORT: '3001',
        PROVISION_DRIVER: 'fake',
        CONTROL_STORE: 'memory',
        CACHE_DRIVER: 'memory',
        AUTH_RATE_MAX: '1000',
        RATE_LIMIT_MAX_REQUESTS: '10000',
      },
    },
    {
      command: 'npx next start -p 3000',
      cwd: '../../apps/dashboard',
      port: 3000,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
      },
    },
  ],
});
