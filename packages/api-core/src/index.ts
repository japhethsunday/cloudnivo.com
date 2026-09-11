import { z } from 'zod';

/**
 * Versioned API foundation (`/api/v1/*`).
 *
 * Framework-agnostic: the same envelope, error codes, validation, CORS,
 * security headers, request IDs, and rate-limit helpers are used by both the
 * Next.js dashboard routes and the standalone `apps/api` service.
 */

// ── Envelope ──────────────────────────────────────────────

export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export function ok<T>(data: T, requestId: string): ApiSuccess<T> {
  return { data, meta: { requestId } };
}

export function fail(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
  status?: number,
): { status: number; body: ApiErrorBody } {
  void status;
  return {
    status: status ?? statusFor(code),
    body: { error: { code, message, requestId, details } },
  };
}

export function statusFor(code: string): number {
  switch (code) {
    case 'BAD_REQUEST':
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'TENANT_FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 500;
  }
}

/** Never leak internals: 5xx messages are replaced with a generic message. */
export function publicMessage(status: number, fallback = 'Internal server error'): string {
  return status >= 500 ? fallback : fallback;
}

export function toPublicError(
  err: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    const status = err.status;
    return {
      status,
      body: {
        error: {
          code: err.code,
          message: status >= 500 ? 'Internal server error' : err.message,
          requestId,
          details: status >= 500 ? undefined : err.details,
        },
      },
    };
  }
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          requestId,
          details: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        },
      },
    };
  }
  // Structural mapping for domain errors (auth/tenant) without hard deps:
  // ApiError-like { code, status }, tenant { code: 'TENANT_FORBIDDEN' },
  // AuthError (name) → 401. Prevents auth failures surfacing as 500s.
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    const status = (err as { status?: unknown }).status;
    const name = (err as { name?: unknown }).name;
    if (typeof code === 'string' && typeof status === 'number') {
      return {
        status,
        body: {
          error: {
            code,
            message: status >= 500 ? 'Internal server error' : (err as Error).message,
            requestId,
          },
        },
      };
    }
    if (code === 'TENANT_FORBIDDEN') {
      return {
        status: 403,
        body: { error: { code: 'TENANT_FORBIDDEN', message: 'Access denied', requestId } },
      };
    }
    if (name === 'AuthError' && typeof code === 'string') {
      const badInput = code.startsWith('WEAK_');
      return {
        status: badInput ? 400 : 401,
        body: { error: { code, message: (err as Error).message, requestId } },
      };
    }
  }
  return fail('INTERNAL', 'Internal server error', requestId, undefined, 500);
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Validation ────────────────────────────────────────────

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const res = schema.safeParse(body);
  if (!res.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Invalid request body',
      400,
      res.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return res.data;
}

export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const res = schema.safeParse(query);
  if (!res.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Invalid query parameters',
      400,
      res.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return res.data;
}

// ── Security headers / CORS ───────────────────────────────

export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  };
}

export function corsHeaders(origin: string | null, allowlist: string[]): Record<string, string> {
  if (origin && allowlist.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
      'Access-Control-Max-Age': '600',
    };
  }
  return { Vary: 'Origin' };
}

// ── Rate limiting (token bucket via CacheService-compatible store) ──

export interface RateLimitStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}

export async function checkRateLimit(
  store: RateLimitStore,
  identity: string,
  opts: RateLimitOptions,
): Promise<{ allowed: boolean; remaining: number }> {
  const ttl = Math.max(1, Math.ceil(opts.windowMs / 1000));
  const key = `${opts.keyPrefix ?? 'rl'}:${identity}`;
  const count = await store.incr(key, ttl);
  return { allowed: count <= opts.max, remaining: Math.max(0, opts.max - count) };
}

export * from './metrics.js';
