import type { AppConfig } from '@cloudnivo/config';
import type { Logger } from '@cloudnivo/logging';
import type { CacheService } from '@cloudnivo/cache';

const DEV_PASSWORD_SENTINEL = 'cloudnivo_dev_password_change_me';

/**
 * Placeholder secrets that ship in documentation. They are long enough to
 * satisfy the 32-character minimum, so length alone never catches a copied
 * .env.example — and a known JWT_SECRET makes every session forgeable.
 */
const PLACEHOLDER_SECRET_MARKERS = [
  'change-me',
  'changeme',
  'change_me',
  'replace-me',
  'your-secret',
  'example-secret',
  'min-32-chars',
];

function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return PLACEHOLDER_SECRET_MARKERS.some(m => v.includes(m));
}

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
  if (looksLikePlaceholder(config.JWT_SECRET)) {
    throw new Error(
      'Refusing production boot: JWT_SECRET is a documentation placeholder — every session would be forgeable. Generate a random value.',
    );
  }
  if (config.VAULT_KEY && looksLikePlaceholder(config.VAULT_KEY)) {
    throw new Error('Refusing production boot: VAULT_KEY is a documentation placeholder');
  }
  if (config.VAULT_KEY && config.VAULT_KEY === config.JWT_SECRET) {
    // One compromised secret must not also decrypt stored credentials.
    throw new Error('Refusing production boot: VAULT_KEY must differ from JWT_SECRET');
  }
  const localOrigins = config.corsOrigins.filter(
    o => o.startsWith('http://') || o.includes('localhost') || o.includes('127.0.0.1'),
  );
  if (localOrigins.length > 0) {
    logger.warn('prod.dev_cors_origin', {
      note: 'CORS_ORIGINS contains a development origin in production: any page served from it can call this API with a user\'s token. Remove it.',
      count: localOrigins.length,
    });
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
