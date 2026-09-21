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
    /**
     * What the caller should DO about it. Present for every catalogued code
     * so a coding agent can act without reverse-engineering the message.
     */
    remediation?: string;
  };
}

/**
 * Error-code → remediation catalog. Machine-readable in the sense that
 * matters to an agent: the code is stable, the remediation tells it which
 * next call to make. Never mentions internals or credentials.
 */
export const ERROR_REMEDIATION: Readonly<Record<string, string>> = {
  BAD_REQUEST: 'Check the request shape against GET /api/v1/discovery and retry.',
  VALIDATION_ERROR: 'Fix the fields listed in error.details and retry.',
  MALFORMED_JSON: 'Send a well-formed JSON body with Content-Type: application/json.',
  UNAUTHORIZED:
    'Send Authorization: Bearer <token>. Use a cn_agent_… token for agents (GET /api/v1/agent/whoami verifies it).',
  INVALID_SESSION: 'Session expired — sign in again or switch to an agent token.',
  INVALID_KEY: 'The API key is not recognised. Issue a new one under the project API keys.',
  KEY_REVOKED: 'This API key was revoked. Issue a replacement key.',
  KEY_EXPIRED: 'This API key expired. Issue a replacement key.',
  AGENT_TOKEN_INVALID:
    'The agent token is unknown. Create one in the dashboard Connect page and set CLOUDNIVO_AGENT_TOKEN.',
  AGENT_TOKEN_REVOKED: 'This agent token was revoked. Rotate it or issue a new one.',
  AGENT_TOKEN_EXPIRED: 'This agent token expired. Rotate it to get a new secret.',
  AGENT_IP_DENIED: 'This token has an IP allowlist that excludes the caller. Run from an allowed address.',
  FORBIDDEN:
    'The credential lacks the required scope. GET /api/v1/agent/whoami lists granted scopes; GET /api/v1/discovery lists what each route needs.',
  FORBIDDEN_SCOPE:
    'Grant the named scope to the token (rotate or re-issue it) — scopes cannot be widened at request time.',
  TENANT_FORBIDDEN:
    'This credential belongs to a different organization or project. Check CLOUDNIVO_PROJECT_ID.',
  NOT_FOUND: 'The resource does not exist under this project. List it first to get a valid id.',
  CONFLICT: 'The resource is in a state that blocks this operation. Re-read it and retry.',
  APPROVAL_REQUIRED:
    'A human owner must approve this destructive operation, then repeat the identical request with the X-Approval-Id header.',
  DESTRUCTIVE_BLOCKED:
    'This statement would destroy data. Re-issue it as a migration and apply it with an approval, or set allowDestructive with the database.destructive scope.',
  PAYLOAD_TOO_LARGE: 'Reduce the request body size and retry.',
  METHOD_NOT_ALLOWED: 'Use one of the methods listed for this route in GET /api/v1/discovery.',
  RATE_LIMITED: 'Back off and retry after the Retry-After interval.',
  LIMIT_EXCEEDED: 'The plan limit for this resource is reached. Remove unused resources or upgrade.',
  VAULT_UNCONFIGURED: 'Ask an operator to configure the server vault key before storing secrets.',
  INTERNAL: 'Retry once; if it persists, quote the meta.requestId to support.',
};

/** Attach the catalogued remediation to an error body (no-op when unknown). */
export function withRemediation(result: { status: number; body: ApiErrorBody }): {
  status: number;
  body: ApiErrorBody;
} {
  const remediation = ERROR_REMEDIATION[result.body.error.code];
  if (!remediation || result.body.error.remediation) return result;
  return { status: result.status, body: { error: { ...result.body.error, remediation } } };
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
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'MALFORMED_JSON':
      return 400;
    case 'METHOD_NOT_ALLOWED':
      return 405;
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
  return withRemediation(classifyError(err, requestId));
}

function classifyError(
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

// ── Request bodies ────────────────────────────────────────

/**
 * Read a request body, refusing anything past `maxBytes` WHILE STREAMING.
 *
 * Every body reader in this codebase used to drain the whole stream into
 * memory and check the length afterwards:
 *
 *     for await (const chunk of req) chunks.push(chunk);
 *     if (Buffer.concat(chunks).length > LIMIT) throw ...
 *
 * which means a single request advertising nothing and sending gigabytes was
 * buffered in full before being rejected — one socket, unbounded server
 * memory, and a 413 that arrives long after the damage. Six call sites had
 * their own copy of it, so the fix belongs here rather than in any one of them.
 *
 * Counting as chunks arrive and destroying the socket at the first byte past
 * the limit bounds the cost of a hostile body to the limit itself.
 *
 * The declared `content-length` is trusted only to reject EARLY. It is never
 * used to size an allocation, because a client that lies about it low would
 * otherwise get a buffer smaller than what it sends.
 */
export async function readBoundedBody(
  req: {
    headers: Record<string, string | string[] | undefined>;
    resume: () => void;
    [Symbol.asyncIterator]: () => AsyncIterableIterator<unknown>;
  },
  maxBytes: number,
): Promise<string> {
  const rawLength = req.headers['content-length'];
  const declared = Number(Array.isArray(rawLength) ? rawLength[0] : (rawLength ?? '0'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Refused on the header alone — no reason to read a byte of it.
    req.resume();
    throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      // Stop ACCUMULATING — that is what bounds memory — then drain the rest
      // so the socket stays healthy long enough to carry a real 413 back.
      // Dropping the connection instead would bound memory just as well but
      // leave every oversized upload looking like a network fault, which is a
      // far worse thing to debug than a clear "too large".
      chunks.length = 0;
      req.resume();
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
    }
    chunks.push(buf);
  }
  return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
}

/** `readBoundedBody` plus JSON parsing. Empty body resolves to undefined. */
export async function readBoundedJson(
  req: Parameters<typeof readBoundedBody>[0],
  maxBytes: number,
): Promise<unknown> {
  const text = await readBoundedBody(req, maxBytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
  }
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

// ── Postgres error classification ─────────────────────────

/**
 * True when an error is a Postgres unique-constraint violation (SQLSTATE
 * 23505), including one wrapped by a query builder.
 *
 * Drizzle wraps driver errors, so the raw `err.code` check that this replaces
 * silently missed every real violation: duplicate signups surfaced as 500s,
 * and the idempotency keys that dedupe provisioning jobs, storage objects and
 * billing payments stopped deduping. Walk the cause chain instead.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth += 1) {
    if (String((cur as { code?: unknown }).code) === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
