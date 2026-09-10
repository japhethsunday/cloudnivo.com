import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import { decodeCustomerToken } from '@cloudnivo/auth';
import { verifyKey } from '@cloudnivo/api-engine';
import {
  DockerFunctionRuntime,
  FunctionError,
  FunctionService,
  NodeWorkerRuntime,
  functionsOpenApiPaths,
  type FunctionAuthContext,
  type FunctionRuntime,
} from '@cloudnivo/functions';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';
import { verifyCustomerCaller } from './customer-auth.js';

/**
 * Serverless Functions HTTP wiring.
 *
 * - Management (`/functions/*` except invoke) requires a platform session
 *   with project membership — same rule as storage/realtime management.
 * - Invocation accepts session members, project keys (service/admin), and
 *   project customer JWTs; the resolved identity (never secrets) becomes the
 *   handler's auth context. Cross-project invocation is impossible: the
 *   project comes from the URL and every credential is re-scoped to it.
 * - Deployments are async jobs (202 + poll); invocation runs the active
 *   immutable version in an isolated runtime with server-side limits.
 */

// ── Service singleton (one per API process) ─────────────────────────

export interface FunctionState {
  service: FunctionService;
  runtime: FunctionRuntime;
}

export function functionsFor(ctx: ApiContext): FunctionState {
  const existing = (ctx as unknown as { __fn?: FunctionState }).__fn;
  if (existing) return existing;
  const c = ctx.config;
  const runtime: FunctionRuntime =
    c.FUNCTION_RUNTIME === 'docker'
      ? new DockerFunctionRuntime({
          memoryMb: c.FUNCTION_MEMORY_MB,
          timeoutMs: c.FUNCTION_EXECUTION_TIMEOUT_MS,
        })
      : new NodeWorkerRuntime();
  const service = new FunctionService(runtime, {
    limits: {
      executionTimeoutMs: c.FUNCTION_EXECUTION_TIMEOUT_MS,
      memoryMb: c.FUNCTION_MEMORY_MB,
      maxRequestBodyBytes: c.FUNCTION_MAX_BODY_BYTES,
      maxResponseBytes: c.FUNCTION_MAX_RESPONSE_BYTES,
      maxConcurrency: c.FUNCTION_MAX_CONCURRENCY,
      maxDeploymentBytes: c.FUNCTION_MAX_DEPLOY_BYTES,
      maxFunctionsPerProject: c.FUNCTION_MAX_FUNCTIONS_PER_PROJECT,
      maxLogEntries: c.FUNCTION_MAX_LOG_ENTRIES,
      logRetentionDays: c.FUNCTION_LOG_RETENTION_DAYS,
    },
    maxEnvValueBytes: c.FUNCTION_MAX_ENV_VALUE_BYTES,
  });
  const state = { service, runtime };
  (ctx as unknown as { __fn?: FunctionState }).__fn = state;
  return state;
}

/** True when /projects/:id/functions... belongs to function management. */
export function isFunctionRoute(rest: string[], method: string): boolean {
  void method;
  if (rest.length < 2 || !rest[0] || rest[1] !== 'functions') return false;
  return true;
}

export function functionsOpenApi(): Record<string, unknown> {
  return functionsOpenApiPaths();
}

// ── Auth helpers ────────────────────────────────────────────────────

async function requireMember(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<{ userId: string; email: string; role: string; organizationId: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
  const project = ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const owned = mustOwnProject(ctx.registry, session.sub, projectId);
  const role =
    ctx.registry.membershipsFor(session.sub).find(m => m.organizationId === owned.organizationId)
      ?.role ?? 'viewer';
  return { userId: session.sub, email: session.email, role, organizationId: owned.organizationId };
}

function requireManager(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Function management requires admin', 403);
  }
}

/** Invoke-grade caller: session member, privileged project key, or customer. */
async function resolveInvokeAuth(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<FunctionAuthContext> {
  const project = ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const rawKey = req.headers['apikey'];
  if (typeof rawKey === 'string' && rawKey.length > 0) {
    let stored;
    try {
      stored = await verifyKey(ctx.keys, rawKey);
    } catch {
      throw new ApiError('UNAUTHORIZED', 'Invalid API key', 401);
    }
    if (stored.projectId !== projectId) {
      throw new ApiError('TENANT_FORBIDDEN', 'API key is not scoped to this project', 403);
    }
    if (stored.role !== 'service' && stored.role !== 'admin') {
      throw new ApiError('FORBIDDEN', 'This API key cannot invoke functions', 403);
    }
    return { userId: null, email: null, role: `key:${stored.role}`, projectId, callerKind: 'key' };
  }
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  const asCustomer = await decodeCustomerToken(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  }).catch(() => null);
  if (asCustomer) {
    if (asCustomer.projectId !== projectId) {
      throw new ApiError('TENANT_FORBIDDEN', 'Token is not scoped to this project', 403);
    }
    const customer = await verifyCustomerCaller(ctx, project, token);
    if (!customer) throw new ApiError('UNAUTHORIZED', 'Invalid or expired credentials', 401);
    return {
      userId: customer.user.id,
      email: customer.user.email,
      role: customer.role,
      projectId,
      callerKind: 'customer',
    };
  }
  let session: { sub: string; email: string } | null = null;
  try {
    session = await verifySession(token, {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
    });
  } catch {
    session = null;
  }
  if (!session) throw new ApiError('UNAUTHORIZED', 'Invalid or expired credentials', 401);
  const owned = mustOwnProject(ctx.registry, session.sub, projectId);
  const role =
    ctx.registry.membershipsFor(session.sub).find(m => m.organizationId === owned.organizationId)
      ?.role ?? 'viewer';
  return { userId: session.sub, email: session.email, role, projectId, callerKind: 'session' };
}

function toFunctionError(err: unknown, requestId: string): { status: number; body: unknown } {
  if (err instanceof FunctionError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, requestId } },
    };
  }
  return toPublicError(err, requestId);
}

// ── Route schemas ───────────────────────────────────────────────────

const CreateBody = z.object({
  name: z.unknown(),
  slug: z.unknown(),
  description: z.unknown().optional(),
  runtime: z.unknown().optional(),
  entrypoint: z.unknown().optional(),
});

const UpdateBody = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  runtime: z.unknown().optional(),
  entrypoint: z.unknown().optional(),
});

const DeployBody = z.object({
  source: z.unknown(),
  runtime: z.unknown().optional(),
  entrypoint: z.unknown().optional(),
  idempotencyKey: z.string().max(128).optional().nullable(),
});

const EnvBody = z.object({
  key: z.unknown(),
  value: z.unknown(),
  secret: z.boolean().optional(),
});

// ── Handler ─────────────────────────────────────────────────────────

export async function handleFunctionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, , ...tail] = rest;
  if (!projectId) return false;
  const start = Date.now();
  const finish = (status: number, body: unknown, extra?: Record<string, string>): true => {
    logger.info('functions.request', {
      project: projectId,
      route: tail.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, { ...baseHeaders, ...extra });
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toFunctionError(err, requestId);
    logger.info('functions.request', {
      project: projectId,
      route: tail.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  try {
    const state = functionsFor(ctx);
    const [head, ...extra] = tail;

    // ── Invocation (project-scoped credentials; runs active version) ──
    if (head !== undefined && extra[0] === 'invoke' && extra.length === 1) {
      if (req.method !== 'POST' && req.method !== 'GET') {
        return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
      }
      const auth = await resolveInvokeAuth(ctx, req, projectId);
      const rl = await checkRateLimit(ctx.rateLimitStore, `fn-invoke:${projectId}:${head}`, {
        windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
        max: ctx.config.FUNCTION_INVOKE_RATE_MAX,
        keyPrefix: 'fn-invoke',
      });
      if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many invocations', 429);
      const rawBody = req.method === 'GET' ? undefined : await readBody();
      if (rawBody !== undefined) {
        const size = Buffer.byteLength(JSON.stringify(rawBody) ?? '', 'utf8');
        if (size > ctx.config.FUNCTION_MAX_BODY_BYTES) {
          throw new ApiError('PAYLOAD_TOO_LARGE', 'Invocation body exceeds the size limit', 413);
        }
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        if (Object.keys(query).length < 64 && k.length <= 128) query[k] = v.slice(0, 4096);
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const name = k.toLowerCase();
        if (name === 'authorization' || name === 'apikey' || name === 'cookie' || name === 'host')
          continue;
        if (
          typeof v === 'string' &&
          name.length <= 128 &&
          v.length <= 8192 &&
          Object.keys(headers).length < 32
        ) {
          headers[name] = v;
        }
      }
      const outcome = await state.service.invokeFunction({
        projectId,
        idOrSlug: head,
        request: { method: req.method ?? 'POST', path: '/', headers, query, body: rawBody ?? null },
        auth,
        requestId,
        rateLimit: ctx.rateLimitStore,
        rateMax: ctx.config.FUNCTION_INVOKE_RATE_MAX,
      });
      ctx.audit.record('function.invoked', { projectId, userId: auth.userId ?? undefined });
      return finish(
        outcome.result.status,
        ok(
          { result: outcome.result.body, version: outcome.version, coldStart: outcome.coldStart },
          requestId,
        ),
        {
          'X-Function-Version': String(outcome.version),
          'X-Execution-Ms': String(outcome.executionTimeMs),
        },
      );
    }

    // ── Management (session members) ──
    const member = await requireMember(ctx, req, projectId);
    const project = ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);

    if (head === undefined) {
      if (req.method === 'GET') {
        return finish(
          200,
          ok({ functions: await state.service.listFunctions(projectId) }, requestId),
        );
      }
      if (req.method === 'POST') {
        requireManager(member.role);
        const parsed = CreateBody.parse((await readBody()) ?? {});
        const fn = await state.service.createFunction({
          projectId,
          organizationId: project.organizationId,
          userId: member.userId,
          name: parsed.name as string,
          slug: parsed.slug as string,
          description: parsed.description,
          runtime: parsed.runtime,
          entrypoint: parsed.entrypoint,
        });
        ctx.audit.record('function.created', { projectId, userId: member.userId });
        return finish(201, ok({ function: fn }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    const slug = head;
    if (extra.length === 0) {
      if (req.method === 'GET') {
        return finish(
          200,
          ok({ function: await state.service.getFunction(projectId, slug) }, requestId),
        );
      }
      if (req.method === 'PATCH') {
        requireManager(member.role);
        const parsed = UpdateBody.parse((await readBody()) ?? {});
        const fn = await state.service.updateFunction(projectId, slug, {
          name: parsed.name,
          description: parsed.description,
          runtime: parsed.runtime,
          entrypoint: parsed.entrypoint,
        });
        return finish(200, ok({ function: fn }, requestId));
      }
      if (req.method === 'DELETE') {
        requireManager(member.role);
        await state.service.deleteFunction(projectId, slug);
        ctx.audit.record('function.deleted', { projectId, userId: member.userId });
        res.writeHead(204, baseHeaders);
        res.end();
        return true;
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    const [action, ...rest2] = extra;
    if (action === 'deploy' && req.method === 'POST' && rest2.length === 0) {
      requireManager(member.role);
      const parsed = DeployBody.parse((await readBody()) ?? {});
      const { job, fn } = await state.service.deployFunction({
        projectId,
        organizationId: project.organizationId,
        userId: member.userId,
        idOrSlug: slug,
        source: parsed.source,
        runtime: parsed.runtime,
        entrypoint: parsed.entrypoint,
        idempotencyKey: parsed.idempotencyKey ?? null,
      });
      ctx.audit.record('function.deploy_started', { projectId, userId: member.userId });
      return finish(202, ok({ function: fn, job }, requestId));
    }
    if (action === 'redeploy' && req.method === 'POST' && rest2.length === 0) {
      requireManager(member.role);
      const { job, fn } = await state.service.redeployFunction({
        projectId,
        organizationId: project.organizationId,
        userId: member.userId,
        idOrSlug: slug,
      });
      ctx.audit.record('function.deploy_started', { projectId, userId: member.userId });
      return finish(202, ok({ function: fn, job }, requestId));
    }
    if (action === 'deployments' && req.method === 'GET') {
      if (rest2.length === 0) {
        return finish(
          200,
          ok({ deployments: await state.service.listDeployments(projectId, slug) }, requestId),
        );
      }
      if (rest2.length === 1 && rest2[0]) {
        return finish(
          200,
          ok(
            { deployment: await state.service.getDeployment(projectId, slug, rest2[0]) },
            requestId,
          ),
        );
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }
    if (action === 'status' && req.method === 'GET' && rest2.length === 0) {
      return finish(200, ok(await state.service.getFunctionStatus(projectId, slug), requestId));
    }
    if (action === 'logs' && req.method === 'GET' && rest2.length === 0) {
      const limit = url.searchParams.get('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
      const level = url.searchParams.get('level') ?? undefined;
      return finish(
        200,
        ok(
          { logs: await state.service.getFunctionLogs(projectId, slug, { limit, level }) },
          requestId,
        ),
      );
    }
    if (action === 'versions' && req.method === 'GET' && rest2.length === 0) {
      return finish(
        200,
        ok({ versions: await state.service.listVersions(projectId, slug) }, requestId),
      );
    }
    if (
      action === 'versions' &&
      rest2.length === 2 &&
      rest2[1] === 'activate' &&
      req.method === 'POST'
    ) {
      requireManager(member.role);
      const version = Number(rest2[0]);
      if (!Number.isInteger(version) || version < 1)
        throw new ApiError('VALIDATION_ERROR', 'Bad version', 400);
      const fn = await state.service.activateVersion(projectId, slug, version);
      return finish(200, ok({ function: fn }, requestId));
    }
    if (action === 'env' && rest2.length === 0) {
      if (req.method === 'GET') {
        return finish(
          200,
          ok({ env: await state.service.listEnvVars(projectId, slug) }, requestId),
        );
      }
      if (req.method === 'PUT') {
        requireManager(member.role);
        const parsed = EnvBody.parse((await readBody()) ?? {});
        const row = await state.service.setEnvVar({
          projectId,
          userId: member.userId,
          idOrSlug: slug,
          key: parsed.key,
          value: parsed.value,
          secret: parsed.secret,
        });
        return finish(200, ok({ env: row }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }
    if (action === 'env' && rest2.length === 1 && rest2[0] && req.method === 'DELETE') {
      requireManager(member.role);
      await state.service.deleteEnvVar(projectId, slug, rest2[0]);
      res.writeHead(204, baseHeaders);
      res.end();
      return true;
    }
    if (action === 'metrics' && req.method === 'GET' && rest2.length === 0) {
      return finish(
        200,
        ok({ metrics: await state.service.getMetrics(projectId, slug) }, requestId),
      );
    }
    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
