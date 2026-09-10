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
  // S3-compatible backend (Phase 5; local default keeps $0 dev).
  STORAGE_S3_ENDPOINT: z.string().default(''),
  STORAGE_S3_REGION: z.string().default('us-east-1'),
  STORAGE_S3_BUCKET: z.string().default(''),
  STORAGE_S3_ACCESS_KEY_ID: z.string().default(''),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().default(''),
  STORAGE_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform(v => v === 'true'),
  // Storage limits + budgets (enforced server-side, never hard-coded).
  STORAGE_MAX_FILE_MB: z.coerce.number().int().min(1).max(5120).default(50),
  STORAGE_MAX_BUCKETS: z.coerce.number().int().min(1).max(1000).default(20),
  STORAGE_PROJECT_QUOTA_MB: z.coerce.number().int().min(1).max(1_000_000).default(1024),
  STORAGE_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
  STORAGE_SIGNING_SECRET: z.string().default(''),
  STORAGE_MAX_SIGNED_TTL_S: z.coerce.number().int().min(60).max(604_800).default(3600),

  REALTIME_DRIVER: z.enum(['memory', 'redis']).default('memory'),

  // ── Realtime gateway (Phase 6) ──
  // Standalone WS port (independent Railway service). In-process upgrade on
  // the API port works regardless; set REALTIME_STANDALONE=false to disable.
  REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  REALTIME_STANDALONE: z.enum(['true', 'false']).default('false'),
  REALTIME_HEARTBEAT_MS: z.coerce.number().int().min(5000).max(300_000).default(25_000),
  REALTIME_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(60_000),
  REALTIME_MAX_CONNS_PER_PROJECT: z.coerce.number().int().min(1).max(100_000).default(500),
  REALTIME_MAX_SUBS_PER_CONN: z.coerce.number().int().min(1).max(1000).default(50),
  REALTIME_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).max(4_194_304).default(65_536),
  REALTIME_MAX_MSG_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(20),
  REALTIME_MAX_BROADCASTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),

  // ── Provisioning (Phase 2: local Docker database engine) ──
  PROVISION_DRIVER: z.enum(['docker', 'fake']).default('docker'),
  POSTGRES_IMAGE: z.string().default('postgres:16-alpine'),
  PROVISION_BASE_PORT: z.coerce.number().int().min(1024).max(60000).default(15432),
  PROVISION_NETWORK: z.string().default('cloudnivo'),
  // loopback = reach DBs via 127.0.0.1:mapped-port (host-run API);
  // container = reach DBs via container-name:5432 (API itself containerized).
  PROVISION_HOST_MODE: z.enum(['loopback', 'container']).default('loopback'),
  PROVISION_MAX_DATABASES: z.coerce.number().int().min(1).max(1000).default(20),
  PROVISION_MAX_DB_SIZE_MB: z.coerce.number().int().min(10).max(100_000).default(1024),
  PROVISION_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(500).default(50),
  PROVISION_MAX_SQL_MS: z.coerce.number().int().min(500).max(300_000).default(15_000),
  PROVISION_MAX_SQL_ROWS: z.coerce.number().int().min(10).max(10_000).default(500),
  PROVISION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  PROVISION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),

  // ── Data API engine (Phase 3) ──
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  DATA_API_KEY_MAX: z.coerce.number().int().min(1).max(10_000).default(300),
  DATA_API_PROJECT_MAX: z.coerce.number().int().min(1).max(100_000).default(1000),
  INTROSPECTION_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

  // ── Customer auth (Phase 4: per-project application users) ──
  AUTH_ACCESS_TTL_S: z.coerce.number().int().min(60).max(86_400).default(900),
  AUTH_REFRESH_TTL_S: z.coerce.number().int().min(3600).max(7_776_000).default(2_592_000),
  AUTH_RESET_TTL_S: z.coerce.number().int().min(300).max(86_400).default(3600),
  AUTH_VERIFY_TTL_S: z.coerce.number().int().min(3600).max(604_800).default(86_400),
  AUTH_RATE_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  EMAIL_DRIVER: z.enum(['memory']).default('memory'),
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
