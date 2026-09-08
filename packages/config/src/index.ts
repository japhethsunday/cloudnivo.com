import { z } from 'zod';

/**
 * Central application configuration.
 *
 * All env access MUST go through {@link loadConfig}. Never read `process.env`
 * ad-hoc in services — this guarantees fail-fast validation and a single
 * audit point for required secrets.
 *
 * Design: every infrastructure dependency is optional-by-default for local dev
 * (sane Docker-compose defaults) but strictly validated when set. Production
 * deployments override via real env vars; missing secrets throw at boot, not
 * at request time.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:3001'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      v => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// connection string',
    ),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('cloudnivo'),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(3600),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/storage'),

  REALTIME_DRIVER: z.enum(['memory', 'redis']).default('memory'),

  // ── Provisioning (Phase 2: local Docker database engine) ──
  PROVISION_DRIVER: z.enum(['docker', 'fake']).default('docker'),
  POSTGRES_IMAGE: z.string().default('postgres:16-alpine'),
  PROVISION_BASE_PORT: z.coerce.number().int().min(1024).max(60000).default(15432),
  PROVISION_NETWORK: z.string().default('cloudnivo'),
  PROVISION_MAX_DATABASES: z.coerce.number().int().min(1).max(1000).default(20),
  PROVISION_MAX_DB_SIZE_MB: z.coerce.number().int().min(10).max(100_000).default(1024),
  PROVISION_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(500).default(50),
  PROVISION_MAX_SQL_MS: z.coerce.number().int().min(500).max(300_000).default(15_000),
  PROVISION_MAX_SQL_ROWS: z.coerce.number().int().min(10).max(10_000).default(500),
  PROVISION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  PROVISION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  corsOrigins: string[];
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
};

export class ConfigError extends Error {
  readonly issues: unknown;
  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Validate `process.env` (or a supplied record) and return a typed config.
 * Throws {@link ConfigError} with non-sensitive details when invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(
      `Invalid configuration: ${details.join('; ')}. See .env.example.`,
      parsed.error.issues,
    );
  }
  const base = parsed.data;
  return {
    ...base,
    corsOrigins: parseCorsOrigins(base.CORS_ORIGINS),
    isProduction: base.NODE_ENV === 'production',
    isDevelopment: base.NODE_ENV === 'development',
    isTest: base.NODE_ENV === 'test',
  };
}

/** Load `.env` file into `process.env` (no-op if already set). Call once at entrypoints. */
export async function loadDotEnv(): Promise<void> {
  const { config } = await import('dotenv');
  config();
}
