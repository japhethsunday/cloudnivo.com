import type { AppConfig } from '@cloudnivo/config';
import type { Logger } from '@cloudnivo/logging';
import type { CacheService } from '@cloudnivo/cache';

const DEV_PASSWORD_SENTINEL = 'cloudnivo_dev_password_change_me';

/**
 * Production safety gates. Development stays frictionless (defaults work),
 * but production REFUSES to boot on configuration that would silently
 * compromise it, and warns loudly about degraded-but-tolerated modes.
 *
 * Refusals (throw — boot halts, never serve traffic misconfigured):
 * - fake provisioner in production (test double would "provision" nothing)
 * - docker-compose dev database password in DATABASE_URL
 *
 * Warnings (serve, but observable):
 * - CONTROL_STORE=memory in production (total amnesia on restart)
 * - default/local REDIS_URL in production (rate limits + session revocation
 *   are single-instance memory instead of shared state)
 *
 * Opt-in strictness: REQUIRE_REDIS=true fails boot unless the cache answers
 * ping — set once a Redis service is attached to the production project.
 */
export function assertProductionSafety(config: AppConfig, logger: Logger): void {
  if (!config.isProduction) return;
  if (config.PROVISION_DRIVER === 'fake') {
    throw new Error('Refusing production boot with PROVISION_DRIVER=fake (test double)');
  }
  if (config.DATABASE_URL.includes(DEV_PASSWORD_SENTINEL)) {
    throw new Error(
      'Refusing production boot: DATABASE_URL uses the docker-compose development password',
    );
  }
  if (!config.VAULT_KEY || config.VAULT_KEY.length < 32) {
    throw new Error('Refusing production boot: VAULT_KEY (32+ chars) is required for credential encryption');
  }
  if (config.CONTROL_STORE === 'memory') {
    logger.warn('prod.memory_store', {
      note: 'CONTROL_STORE=memory in production: registry, keys, jobs, billing and AI state are lost on restart. Set CONTROL_STORE=drizzle with migrations.',
    });
  }
  if (config.REDIS_URL === 'redis://localhost:6379') {
    logger.warn('prod.local_cache', {
      note: 'REDIS_URL is the localhost default in production: rate limiting and session revocation are single-instance. Attach Redis and set REDIS_URL (REQUIRE_REDIS=true to enforce).',
    });
  }
}

export async function assertSharedCache(
  config: AppConfig,
  cache: CacheService,
  logger: Logger,
): Promise<void> {
  if (!config.REQUIRE_REDIS) return;
  const ok = await cache.ping().catch(() => false);
  if (!ok) {
    throw new Error('REQUIRE_REDIS=true but the shared cache is unreachable — refusing boot');
  }
  logger.info('cache.shared_ready', { driver: cache.driver });
}
