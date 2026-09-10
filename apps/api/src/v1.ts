import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  ApiError,
  checkRateLimit,
  corsHeaders,
  ok,
  securityHeaders,
  toPublicError,
  type RateLimitStore,
} from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import { createCacheService, type CacheService } from '@cloudnivo/cache';
import type { AppConfig } from '@cloudnivo/config';
import { createLogger, type Logger } from '@cloudnivo/logging';
import {
  DockerDatabaseProvider,
  FakeDatabaseProvider,
  MemoryJobStore,
  type AuditSink,
  type DatabaseProvisioner,
  type JobStore,
} from '@cloudnivo/provisioning';
import { MemoryKeyStore, type KeyStore } from '@cloudnivo/api-engine';
import { DrizzleKeyStore } from '@cloudnivo/api-engine';
import { createDatabaseService, type DatabaseService } from '@cloudnivo/database';
import { DrizzleJobStore } from '@cloudnivo/provisioning';
import { MemoryRegistry, type Registry } from './registry.js';
import { DrizzleRegistry } from './registry-drizzle.js';
import {
  FakeProjectDbGateway,
  RealProjectDbGateway,
  handleOrgRoutes,
  handleProjectRoutes,
  type ProjectDbGateway,
} from './projects.js';
import {
  handleCustomerAuthRoutes,
  isCustomerAuthRoute,
  projectCorsHeaders,
  type CustomerAuthHandle,
} from './customer-auth.js';
import {
  FakeDataBackend,
  RealDataBackend,
  handleDataRoutes,
  isDataRoute,
  type DataBackend,
} from './data.js';
import { handleStorageRoutes, isStorageRoute } from './storage.js';
import { handleRealtimeRoutes, isRealtimeRoute } from './realtime.js';
import { handleFunctionRoutes, isFunctionRoute } from './functions.js';
import { handleAiRoutes, isAiRoute } from './ai.js';
import { handlePlatformAuthRoutes, isPlatformAuthRoute } from './platform-auth.js';

/**
 * Framework-free v1 API (Node `http` only — no Express/Fastify dep in Phase 1).
 * Same envelope/headers/CORS/rate-limit semantics as the Next.js routes.
 */

export interface ApiContext {
  config: AppConfig;
  logger: Logger;
  cache: CacheService;
  rateLimitStore: RateLimitStore;
  registry: Registry;
  provider: DatabaseProvisioner;
  gateway: ProjectDbGateway;
  data: DataBackend;
  keys: KeyStore;
  jobs: JobStore;
  audit: AuditSink;
  /** Durable control-plane connection (CONTROL_STORE=drizzle only). */
  controlDb: DatabaseService | null;
  /** Per-project customer-auth handles (service + dev outbox), cached. */
  customerAuth: Map<string, CustomerAuthHandle>;
}

export function createContext(config: AppConfig): ApiContext {
  const logger = createLogger({ service: 'api' });
  const cache = createCacheService(config.REDIS_URL);
  const registry = new MemoryRegistry();
  const isFake = config.PROVISION_DRIVER === 'fake';
  const provider: DatabaseProvisioner = isFake
    ? new FakeDatabaseProvider()
    : new DockerDatabaseProvider({
        image: config.POSTGRES_IMAGE,
        network: config.PROVISION_NETWORK,
        basePort: config.PROVISION_BASE_PORT,
        healthTimeoutMs: config.PROVISION_HEALTH_TIMEOUT_MS,
        hostMode: config.PROVISION_HOST_MODE,
      });
  const gateway: ProjectDbGateway = isFake ? new FakeProjectDbGateway() : RealProjectDbGateway;
  const data: DataBackend = isFake ? new FakeDataBackend() : RealDataBackend;
  const keys = new MemoryKeyStore();
  const jobs = new MemoryJobStore();
  const audit: AuditSink = {
    record: (event, fields) => {
      void registry
        .recordAudit(event, {
          projectId: typeof fields['projectId'] === 'string' ? fields['projectId'] : undefined,
          organizationId:
            typeof fields['organizationId'] === 'string' ? fields['organizationId'] : undefined,
          userId: typeof fields['userId'] === 'string' ? fields['userId'] : undefined,
        })
        .catch(err => logger.warn('audit failed', { error: String(err).slice(0, 120) }));
      logger.info('audit', { event, ...fields });
    },
  };
  return {
    config,
    logger,
    cache,
    rateLimitStore: cache,
    registry,
    provider,
    gateway,
    data,
    keys,
    jobs,
    audit,
    controlDb: null,
    customerAuth: new Map(),
  };
}

/**
 * Durable control-plane upgrade: swap memory adapters for Drizzle-backed
 * stores on the migrated control database. Runs once at boot (and never in
 * tests, which pin memory). Fails fast when the database is unreachable —
 * a durable deployment without its database is a misconfiguration, not a
 * degraded mode. Storage metadata swaps lazily via the stashed factory.
 */
export async function initControlPlane(ctx: ApiContext): Promise<void> {
  if (ctx.config.CONTROL_STORE !== 'drizzle' || ctx.config.NODE_ENV === 'test') return;
  const svc = createDatabaseService(ctx.config.DATABASE_URL);
  const health = await svc.healthCheck();
  if (!health.ok) {
    await svc.close().catch(() => undefined);
    throw new Error(`Control database unreachable: ${health.error ?? 'unknown'} (run db:migrate)`);
  }
  ctx.controlDb = svc;
  ctx.registry = new DrizzleRegistry(svc.db);
  ctx.keys = new DrizzleKeyStore(svc.db);
  ctx.jobs = new DrizzleJobStore(svc.db);
  const { DrizzleStorageMetadataStore } = await import('@cloudnivo/storage');
  (ctx as unknown as { __storageMeta?: unknown }).__storageMeta = new DrizzleStorageMetadataStore(
    svc.db,
  );
  ctx.logger.info('control plane durable', { store: 'drizzle' });
}

function requestIdOf(req: IncomingMessage): string {
  const h = req.headers['x-request-id'];
  if (typeof h === 'string' && h.length >= 8 && h.length <= 128) return h;
  return randomUUID();
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  if (text.length > 1_000_000) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
  }
}

async function requireSession(
  req: IncomingMessage,
  ctx: ApiContext,
): Promise<{ sub: string; email: string; org?: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) {
    throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  }
  return verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  const requestId = requestIdOf(req);
  const logger = ctx.logger.child({ requestId });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin ?? null;
  const baseHeaders = {
    ...securityHeaders(),
    ...corsHeaders(origin, ctx.config.corsOrigins),
    'X-Request-Id': requestId,
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders);
    res.end();
    return;
  }

  // Rate limit: 120/min per IP by default (in-memory; Redis-backed in prod).
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const rl = await checkRateLimit(ctx.rateLimitStore, `ip:${ip}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.RATE_LIMIT_MAX_REQUESTS,
  });
  if (!rl.allowed) {
    logger.warn('rate limited', { ip });
    sendJson(
      res,
      429,
      { error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId } },
      baseHeaders,
    );
    return;
  }

  try {
    if (url.pathname === '/api/v1/health' && req.method === 'GET') {
      sendJson(res, 200, ok({ status: 'ok', version: '0.1.0' }, requestId), baseHeaders);
      return;
    }

    // Platform auth (developer signup/login/me + org invites — no project yet).
    if (isPlatformAuthRoute(url.pathname, req.method ?? 'GET')) {
      const handled = await handlePlatformAuthRoutes(req, res, ctx, logger, baseHeaders, requestId);
      if (handled) return;
    }

    // Phase 2: project + database provisioning routes (tenant-enforced).
    if (url.pathname === '/api/v1/organizations') {
      const session = await requireSession(req, ctx);
      const body = await readJson(req);
      const handled = await handleOrgRoutes(
        req,
        res,
        ctx,
        logger,
        baseHeaders,
        requestId,
        session,
        async () => body,
      );
      if (handled) return;
    }

    if (url.pathname === '/api/v1/projects' || url.pathname.startsWith('/api/v1/projects/')) {
      const rest = url.pathname.replace('/api/v1/projects', '').split('/').filter(Boolean);
      // Project CORS override (project allowlist wins over global when set).
      const routeHeaders =
        rest[0] &&
        (isDataRoute(rest, req.method ?? 'GET') ||
          isCustomerAuthRoute(rest, req.method ?? 'GET') ||
          isStorageRoute(rest, req.method ?? 'GET') ||
          isFunctionRoute(rest, req.method ?? 'GET') ||
          isAiRoute(rest, req.method ?? 'GET') ||
          isRealtimeRoute(rest, req.method ?? 'GET'))
          ? await projectCorsHeaders(ctx, rest[0], origin, baseHeaders)
          : baseHeaders;
      // Customer auth namespace — public signup/login live here (no session yet).
      if (isCustomerAuthRoute(rest, req.method ?? 'GET')) {
        const body = await readJson(req);
        const handled = await handleCustomerAuthRoutes(
          req,
          res,
          ctx,
          ctx.config,
          logger,
          routeHeaders,
          requestId,
          rest,
          async () => body,
        );
        if (handled) return;
      }
      // Storage plane: buckets + objects (+ public signed-token redemption).
      // Reads the raw stream itself, so it runs BEFORE any readJson call.
      if (isStorageRoute(rest, req.method ?? 'GET')) {
        const handled = await handleStorageRoutes(
          req,
          res,
          ctx,
          ctx.config,
          logger,
          routeHeaders,
          requestId,
          rest,
          url.searchParams,
          async () => readJson(req),
        );
        if (handled) return;
      }
      // Functions plane: management + invocation (reads its own body).
      if (isFunctionRoute(rest, req.method ?? 'GET')) {
        const handled = await handleFunctionRoutes(
          req,
          res,
          ctx,
          logger,
          routeHeaders,
          requestId,
          rest,
          url,
          async () => readJson(req),
        );
        if (handled) return;
      }
      // AI Builder: plan (never executes) + approve/reject/apply.
      if (isAiRoute(rest, req.method ?? 'GET')) {
        const handled = await handleAiRoutes(req, res, ctx, logger, routeHeaders, requestId, rest);
        if (handled) return;
      }
      // Realtime management (session members; WS upgrades handled separately).
      if (isRealtimeRoute(rest, req.method ?? 'GET')) {
        const handled = await handleRealtimeRoutes(
          req,
          res,
          ctx,
          logger,
          routeHeaders,
          requestId,
          rest,
        );
        if (handled) return;
      }
      // Data plane accepts session JWT OR project apikey (resolved inside).
      if (isDataRoute(rest, req.method ?? 'GET')) {
        const body = await readJson(req);
        const handled = await handleDataRoutes(
          req,
          res,
          ctx,
          ctx.config,
          logger,
          routeHeaders,
          requestId,
          rest,
          url.searchParams,
          async () => body,
        );
        if (handled) return;
      }
      const session = await requireSession(req, ctx);
      const body = await readJson(req);
      const handled = await handleProjectRoutes(
        req,
        res,
        ctx,
        ctx.config,
        logger,
        baseHeaders,
        requestId,
        session,
        rest,
        url.searchParams,
        async () => body,
      );
      if (handled) return;
    }

    sendJson(
      res,
      404,
      { error: { code: 'NOT_FOUND', message: 'Not found', requestId } },
      baseHeaders,
    );
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    logger.warn('request failed', { status, path: url.pathname });
    sendJson(res, status, body, baseHeaders);
  }
}
