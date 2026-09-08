import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ApiError,
  checkRateLimit,
  corsHeaders,
  ok,
  parseBody,
  securityHeaders,
  toPublicError,
  type RateLimitStore,
} from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import { createCacheService, type CacheService } from '@cloudnivo/cache';
import type { AppConfig } from '@cloudnivo/config';
import { createLogger, type Logger } from '@cloudnivo/logging';

/**
 * Framework-free v1 API (Node `http` only — no Express/Fastify dep in Phase 1).
 * Same envelope/headers/CORS/rate-limit semantics as the Next.js routes.
 */

export interface ApiContext {
  config: AppConfig;
  logger: Logger;
  cache: CacheService;
  rateLimitStore: RateLimitStore;
}

export function createContext(config: AppConfig): ApiContext {
  const logger = createLogger({ service: 'api' });
  const cache = createCacheService(config.REDIS_URL);
  return { config, logger, cache, rateLimitStore: cache };
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
  return JSON.parse(text) as unknown;
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

const CreateProjectBody = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  organizationId: z.string().uuid(),
});

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

    if (url.pathname === '/api/v1/projects' && req.method === 'GET') {
      const session = await requireSession(req, ctx);
      // Phase 1: DB wiring lands with migrations (Phase 2). Return tenant-scoped
      // empty set to prove auth + envelope without requiring live Postgres.
      logger.info('projects.list', { user: session.sub });
      sendJson(res, 200, ok({ projects: [], user: session.sub }, requestId), baseHeaders);
      return;
    }

    if (url.pathname === '/api/v1/projects' && req.method === 'POST') {
      const session = await requireSession(req, ctx);
      const body = await readJson(req);
      const parsed = parseBody(CreateProjectBody, body);
      // Tenant check happens against DB memberships in Phase 2; here we prove
      // validation + auth boundary + secure error shape.
      logger.info('projects.create', { user: session.sub, org: parsed.organizationId });
      sendJson(
        res,
        201,
        ok({ project: { ...parsed, id: requestId, status: 'active' } }, requestId),
        baseHeaders,
      );
      return;
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
