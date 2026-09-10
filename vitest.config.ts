import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    testTimeout: 15_000,
    reporters: ['default'],
  },
  resolve: {
    alias: [
      { find: '@cloudnivo/config', replacement: resolve(rootDir, 'packages/config/src/index.ts') },
      {
        find: '@cloudnivo/logging',
        replacement: resolve(rootDir, 'packages/logging/src/index.ts'),
      },
      {
        find: '@cloudnivo/validation',
        replacement: resolve(rootDir, 'packages/validation/src/index.ts'),
      },
      {
        find: '@cloudnivo/database',
        replacement: resolve(rootDir, 'packages/database/src/index.ts'),
      },
      { find: '@cloudnivo/auth', replacement: resolve(rootDir, 'packages/auth/src/index.ts') },
      {
        find: '@cloudnivo/storage',
        replacement: resolve(rootDir, 'packages/storage/src/index.ts'),
      },
      {
        find: '@cloudnivo/realtime',
        replacement: resolve(rootDir, 'packages/realtime/src/index.ts'),
      },
      { find: '@cloudnivo/cache', replacement: resolve(rootDir, 'packages/cache/src/index.ts') },
      {
        find: '@cloudnivo/provisioning',
        replacement: resolve(rootDir, 'packages/provisioning/src/index.ts'),
      },
      {
        find: '@cloudnivo/api-core',
        replacement: resolve(rootDir, 'packages/api-core/src/index.ts'),
      },
      {
        find: '@cloudnivo/api-engine',
        replacement: resolve(rootDir, 'packages/api-engine/src/index.ts'),
      },
      {
        find: '@cloudnivo/functions',
        replacement: resolve(rootDir, 'packages/functions/src/index.ts'),
      },
      {
        find: '@cloudnivo/ai',
        replacement: resolve(rootDir, 'packages/ai/src/index.ts'),
      },
      {
        find: '@cloudnivo/billing',
        replacement: resolve(rootDir, 'packages/billing/src/index.ts'),
      },
      {
        find: '@cloudnivo/sdk',
        replacement: resolve(rootDir, 'packages/sdk/src/index.ts'),
      },
      {
        find: '@cloudnivo/cli',
        replacement: resolve(rootDir, 'packages/cli/src/index.ts'),
      },
    ],
  },
});
