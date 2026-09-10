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
  // docker = per-project containers (needs a Docker engine);
  // managed = per-project database+role inside one shared Postgres server
  //   (Railway PG plugin / RDS / compose postgres — no Docker needed);
  // fake = test-only in-memory provider (never in prod).
  PROVISION_DRIVER: z.enum(['docker', 'managed', 'fake']).default('docker'),
  // Privileged connection string for the shared server. Required when
  // PROVISION_DRIVER=managed. On Railway this is the Postgres plugin URL
  // (same value as DATABASE_URL is fine — project roles are locked down
  // to their own databases). Never exposed to customers.
  MANAGED_PG_URL: z.string().default(''),
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

  // ── Durable control plane (Phase 8) ──
  // memory = dev/test default (zero friction); drizzle = Postgres-backed
  // registry/keys/jobs/storage metadata (needs migrations + seed at deploy).
  CONTROL_STORE: z.enum(['memory', 'drizzle']).default('memory'),
  // Opt-in boot migration for container deploys (Railway release step
  // alternative). Default OFF: migrations run explicitly via db:migrate.
  // Drizzle journal applies pending files in order; failures halt boot.
  MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .default('false')
    .transform(v => v === 'true'),

  // ── Background worker (Phase 11) ──
  // Drains orphaned provisioning jobs (stuck pending/retrying after an API
  // restart) from the shared job store. With CONTROL_STORE=memory the worker
  // shares nothing and exits idle; with drizzle it provides restart safety.
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  WORKER_POLL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
  WORKER_STALE_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  WORKER_DRAIN_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

  // ── Serverless functions (Phase 7) ──
  // worker = in-process isolates (dev/test/small prod); docker = per-version
  // container images executed with --network none + caps (needs an engine).
  FUNCTION_RUNTIME: z.enum(['worker', 'docker']).default('worker'),
  FUNCTION_EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(10_000),
  FUNCTION_MEMORY_MB: z.coerce.number().int().min(64).max(4096).default(128),
  FUNCTION_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(8_388_608).default(262_144),
  FUNCTION_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(8_388_608).default(1_048_576),
  FUNCTION_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  FUNCTION_MAX_DEPLOY_BYTES: z.coerce.number().int().min(1024).max(52_428_800).default(5_242_880),
  FUNCTION_MAX_FUNCTIONS_PER_PROJECT: z.coerce.number().int().min(1).max(1000).default(50),
  FUNCTION_MAX_ENV_VALUE_BYTES: z.coerce.number().int().min(256).max(65_536).default(8192),
  FUNCTION_MAX_LOG_ENTRIES: z.coerce.number().int().min(50).max(10_000).default(500),
  FUNCTION_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  FUNCTION_INVOKE_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(60),
  // Public base URL served to developers (never hardcode prod domains).
  FUNCTION_BASE_URL: z.string().default(''),

  // ── AI Backend Builder (Phase 9) ──
  // local = deterministic offline planner (default); openai-compatible =
  // frontier models via chat-completions when AI_API_KEY is configured.
  // Provider credentials live in env only — never in code, logs, or responses.
  AI_PROVIDER: z.enum(['local', 'openai-compatible']).default('local'),
  AI_MODEL: z.string().max(200).default('local-planner-v1'),
  AI_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300_000).default(60_000),
  AI_RATE_MAX: z.coerce.number().int().min(1).max(1000).default(20),
  AI_MAX_PROMPT_CHARS: z.coerce.number().int().min(100).max(50_000).default(8000),
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
