import { describe, expect, it } from 'vitest';
import { loadConfig } from '@cloudnivo/config';
import { createLogger } from '@cloudnivo/logging';
import { MemoryCache } from '@cloudnivo/cache';
import { assertProductionSafety, assertSharedCache } from './prod-guards.js';

const logger = createLogger({ service: 'test' });

function prodEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@prod-pg.internal:5432/cloudnivo',
    JWT_SECRET: 'p'.repeat(48),
    CORS_ORIGINS: 'https://dashboard.example.com',
    PROVISION_DRIVER: 'managed',
    CONTROL_STORE: 'drizzle',
    REDIS_URL: 'redis://:pw@prod-redis.internal:6379',
    ...overrides,
  };
}

describe('production boot guards', () => {
  it('refuses fake provisioner and dev database passwords', () => {
    expect(() =>
      assertProductionSafety(loadConfig(prodEnv({ PROVISION_DRIVER: 'fake' })), logger),
    ).toThrow(/fake/i);
    expect(() =>
      assertProductionSafety(
        loadConfig(
          prodEnv({ DATABASE_URL: 'postgres://cloudnivo:cloudnivo_dev_password_change_me@h:5432/db' }),
        ),
        logger,
      ),
    ).toThrow(/development password/i);
  });

  it('passes sane production config, warns (not throws) on memory store', () => {
    expect(() => assertProductionSafety(loadConfig(prodEnv()), logger)).not.toThrow();
    expect(() =>
      assertProductionSafety(loadConfig(prodEnv({ CONTROL_STORE: 'memory' })), logger),
    ).not.toThrow();
  });

  it('enforces shared cache only when REQUIRE_REDIS=true', async () => {
    // Reachable memory cache satisfies the gate when required.
    await assertSharedCache(
      loadConfig(prodEnv({ REQUIRE_REDIS: 'true' })),
      new MemoryCache(),
      logger,
    );
    // Unreachable cache refuses boot when required...
    const dead = new MemoryCache();
    dead.ping = async () => false;
    await expect(
      assertSharedCache(loadConfig(prodEnv({ REQUIRE_REDIS: 'true' })), dead, logger),
    ).rejects.toThrow(/shared cache/i);
    // ...but is tolerated when not required.
    await assertSharedCache(loadConfig(prodEnv()), dead, logger);
  });

  it('does nothing outside production', () => {
    expect(() =>
      assertProductionSafety(
        loadConfig({ ...prodEnv({ PROVISION_DRIVER: 'fake' }), NODE_ENV: 'development' }),
        logger,
      ),
    ).not.toThrow();
  });
});
