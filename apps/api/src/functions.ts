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
  type SdkHooks,
} from '@cloudnivo/functions';
import type { Logger } from '@cloudnivo/logging';
import type { AgentToken } from '@cloudnivo/agents';
import type { ApiContext } from './v1.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';
import {
  agentFromRequest,
  agentServiceFor,
  auditAgent,
  gateDestructive,
  requireAgent,
  sendApprovalRequired,
  verifyAgentAccess,
} from './agents.js';
import { verifyCustomerCaller } from './customer-auth.js';
import { storageFor } from './storage.js';
import { realtimeFor } from './realtime.js';

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
): Promise<{ userId: string; email: string; role: string; organizationId: string; agent?: AgentToken }> {
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const agent = await verifyAgentAccess(ctx, req, maybeAgent, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'functions.access',
    });
    // Owner-membership still required (a removed owner loses everything).
    await mustOwnProject(ctx.registry, agent.userId, projectId);
    return { userId: agent.userId, email: '', role: 'agent', organizationId: project.organizationId, agent };
  }
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
  const project = await ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const owned = await mustOwnProject(ctx.registry, session.sub, projectId);
  const role =
    (await ctx.registry.membershipsFor(session.sub)).find(
      m => m.organizationId === owned.organizationId,
    )?.role ?? 'viewer';
  return { userId: session.sub, email: session.email, role, organizationId: owned.organizationId };
}

function requireManager(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Function management requires admin', 403);
  }
}

/** Agent scope gate for one management operation (no-op for human members). */
async function gateFn(
  ctx: ApiContext,
  req: IncomingMessage,
  member: { userId: string; role: string; organizationId: string; agent?: AgentToken },
  projectId: string,
  opts: { scope: string; action: string; resource?: string },
): Promise<void> {
  if (!member.agent) return;
  await requireAgent(ctx, req, member.agent, {
    scope: opts.scope,
    organizationId: member.organizationId,
    projectId,
    action: opts.action,
    resource: opts.resource,
  });
}

function auditFn(
  ctx: ApiContext,
  req: IncomingMessage,
  member: { userId: string; organizationId: string; agent?: AgentToken },
  projectId: string,
  action: string,
  resource?: string,
): void {
  if (!member.agent) return;
  auditAgent(ctx, req, {
    token: member.agent,
    userId: member.agent.userId,
    organizationId: member.organizationId,
    projectId,
    action,
    resource,
    result: 'success',
  });
}

/** Invoke-grade caller: session member, privileged project key, or customer. */
async function resolveInvokeAuth(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<FunctionAuthContext> {
  const project = await ctx.registry.getProject(projectId);
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
  // Agent tokens invoke with the deploy capability (executing code is a
  // privileged operation, like service keys — never viewers or customers).
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    const agent = await requireAgent(ctx, req, maybeAgent, {
      scope: 'functions.deploy',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'function.invoke',
    });
    await mustOwnProject(ctx.registry, agent.userId, projectId);
    return {
      userId: agent.userId,
      email: null,
      role: 'agent',
      projectId,
      callerKind: 'key',
      agent: { id: agent.id, userId: agent.userId },
    };
  }
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
  const owned = await mustOwnProject(ctx.registry, session.sub, projectId);
  const role =
    (await ctx.registry.membershipsFor(session.sub)).find(
      m => m.organizationId === owned.organizationId,
    )?.role ?? 'viewer';
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

/**
 * Project-bound data-plane capabilities for `cloudnivo.*` inside handlers.
 * Every hook re-checks scope: the project comes from the URL (never the
 * isolate), credentials resolve server-side, and customer callers are
 * owner-scoped by denial — non-admin customers cannot run raw SQL through
 * functions (they use RLS-shaped REST instead).
 */
async function sdkHooksFor(
  ctx: ApiContext,
  projectId: string,
  auth: FunctionAuthContext,
): Promise<SdkHooks> {
  const project = await ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const organizationId = project.organizationId;
  const storageCaller = {
    kind:
      auth.callerKind === 'session'
        ? ('session' as const)
        : auth.callerKind === 'customer'
          ? ('customer' as const)
          : ('key' as const),
    userId: auth.userId,
    role: auth.role.startsWith('key:') ? auth.role.slice(4) : auth.role,
    projectId,
    organizationId,
  };
  return {
    databaseQuery: async (sql: string, params: unknown[]) => {
      if (auth.callerKind === 'customer' && auth.role !== 'admin') {
        throw new FunctionError('FORBIDDEN', 'Customer functions cannot run raw SQL', 403);
      }
      const db = await ctx.registry.getDatabaseByProject(projectId);
      const cred = await ctx.registry.getCredential(projectId);
      if (!db || !cred) throw new FunctionError('NOT_FOUND', 'Database not provisioned yet', 404);
      const result = await ctx.gateway.query(
        {
          host: db.host,
          port: db.port,
          database: db.dbName,
          user: cred.dbUser,
          password: cred.password,
        },
        sql,
        {
          maxStatementMs: Math.min(ctx.config.PROVISION_MAX_SQL_MS, 10_000),
          maxRows: 100,
          maxLength: 20_000,
        },
        params,
      );
      return result.rows as Record<string, unknown>[];
    },
    storageRead: async (bucket: string, path: string) => {
      const svc = storageFor(ctx);
      let found;
      try {
        found = await svc.download(storageCaller, bucket, path);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        const status = (err as { status?: unknown }).status;
        throw new FunctionError(
          typeof code === 'string' ? code : 'STORAGE_ERROR',
          'Storage read denied or missing',
          typeof status === 'number' ? status : 404,
        );
      }
      const { stream, object } = found;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > ctx.config.FUNCTION_MAX_BODY_BYTES) {
          throw new FunctionError('OBJECT_TOO_LARGE', 'Object exceeds function read limit', 413);
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);
      let encoding: 'utf8' | 'base64' = 'utf8';
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        encoding = 'base64';
        text = body.toString('base64');
      }
      return {
        bucket: object.bucket,
        path: object.path,
        mimeType: object.mimeType,
        size: body.length,
        body: text,
        encoding,
      };
    },
    realtimePublish: async (channel: string, event: string, data: unknown) => {
      if (!channel.startsWith(`project:${projectId}:`)) {
        throw new FunctionError('FORBIDDEN', 'Channel belongs to another project', 403);
      }
      if (auth.callerKind === 'session' && auth.role === 'viewer') {
        throw new FunctionError('FORBIDDEN', 'Viewers cannot publish', 403);
      }
      const state = realtimeFor(ctx);
      await state.gateway.publishBroadcast(channel, event, data);
    },
  };
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
        sdkHooks: await sdkHooksFor(ctx, projectId, auth),
      });
      ctx.audit.record('function.invoked', { projectId, userId: auth.userId ?? undefined });
      if (auth.agent) {
        const invokedProject = await ctx.registry.getProject(projectId).catch(() => null);
        const svc = agentServiceFor(ctx);
        void svc
          .log({
            tokenId: auth.agent.id,
            userId: auth.agent.userId,
            organizationId: invokedProject?.organizationId ?? null,
            projectId,
            action: 'function.invoke',
            resource: head,
            result: 'success',
            reason: '',
            ip: null,
          })
          .catch(() => undefined);
      }
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
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);

    if (head === undefined) {
      if (req.method === 'GET') {
        await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'functions.list' });
        return finish(
          200,
          ok({ functions: await state.service.listFunctions(projectId) }, requestId),
        );
      }
      if (req.method === 'POST') {
        const rawCreate = await readBody();
        if (member.agent) {
          await gateFn(ctx, req, member, projectId, {
            scope: 'functions.update',
            action: 'function.create',
            resource: typeof rawCreate === 'object' && rawCreate !== null
              ? String((rawCreate as Record<string, unknown>)['name'] ?? '')
              : undefined,
          });
        } else {
          requireManager(member.role);
        }
        const parsed = CreateBody.parse(rawCreate ?? {});
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
        auditFn(ctx, req, member, projectId, 'function.create', fn.slug);
        return finish(201, ok({ function: fn }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    const slug = head;
    if (extra.length === 0) {
      if (req.method === 'GET') {
        await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'function.get', resource: slug });
        return finish(
          200,
          ok({ function: await state.service.getFunction(projectId, slug) }, requestId),
        );
      }
      if (req.method === 'PATCH') {
        const rawUpdate = await readBody();
        if (member.agent) {
          await gateFn(ctx, req, member, projectId, {
            scope: 'functions.update',
            action: 'function.update',
            resource: slug,
          });
        } else {
          requireManager(member.role);
        }
        const parsed = UpdateBody.parse(rawUpdate ?? {});
        const fn = await state.service.updateFunction(projectId, slug, {
          name: parsed.name,
          description: parsed.description,
          runtime: parsed.runtime,
          entrypoint: parsed.entrypoint,
        });
        auditFn(ctx, req, member, projectId, 'function.update', slug);
        return finish(200, ok({ function: fn }, requestId));
      }
      if (req.method === 'DELETE') {
        if (member.agent) {
          const decision = await gateDestructive(ctx, req, {
            agent: member.agent,
            scope: 'functions.delete',
            action: 'function.delete',
            organizationId: member.organizationId,
            projectId,
            method: 'DELETE',
            path: `/api/v1/projects/${projectId}/functions/${slug}`,
            body: undefined,
            resource: slug,
          });
          if (!decision.proceed) {
            sendApprovalRequired(res, baseHeaders, requestId, decision.approval);
            return true;
          }
        } else {
          requireManager(member.role);
        }
        await state.service.deleteFunction(projectId, slug);
        ctx.audit.record('function.deleted', { projectId, userId: member.userId });
        auditFn(ctx, req, member, projectId, 'function.delete', slug);
        res.writeHead(204, baseHeaders);
        res.end();
        return true;
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    const [action, ...rest2] = extra;
    if (action === 'deploy' && req.method === 'POST' && rest2.length === 0) {
      const rawDeploy = await readBody();
      if (member.agent) {
        const decision = await gateDestructive(ctx, req, {
          agent: member.agent,
          scope: 'functions.deploy',
          action: 'function.deploy',
          organizationId: member.organizationId,
          projectId,
          method: 'POST',
          path: `/api/v1/projects/${projectId}/functions/${slug}/deploy`,
          body: rawDeploy ?? {},
          resource: slug,
        });
        if (!decision.proceed) {
          sendApprovalRequired(res, baseHeaders, requestId, decision.approval);
          return true;
        }
      } else {
        requireManager(member.role);
      }
      const parsed = DeployBody.parse(rawDeploy ?? {});
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
      auditFn(ctx, req, member, projectId, 'function.deploy', slug);
      return finish(202, ok({ function: fn, job }, requestId));
    }
    if (action === 'redeploy' && req.method === 'POST' && rest2.length === 0) {
      if (member.agent) {
        const decision = await gateDestructive(ctx, req, {
          agent: member.agent,
          scope: 'functions.deploy',
          action: 'function.deploy',
          organizationId: member.organizationId,
          projectId,
          method: 'POST',
          path: `/api/v1/projects/${projectId}/functions/${slug}/redeploy`,
          body: {},
          resource: slug,
        });
        if (!decision.proceed) {
          sendApprovalRequired(res, baseHeaders, requestId, decision.approval);
          return true;
        }
      } else {
        requireManager(member.role);
      }
      const { job, fn } = await state.service.redeployFunction({
        projectId,
        organizationId: project.organizationId,
        userId: member.userId,
        idOrSlug: slug,
      });
      ctx.audit.record('function.deploy_started', { projectId, userId: member.userId });
      auditFn(ctx, req, member, projectId, 'function.deploy', slug);
      return finish(202, ok({ function: fn, job }, requestId));
    }
    if (action === 'deployments' && req.method === 'GET') {
      await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'functions.deployments', resource: slug });
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
      await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'function.status', resource: slug });
      return finish(200, ok(await state.service.getFunctionStatus(projectId, slug), requestId));
    }
    if (action === 'logs' && req.method === 'GET' && rest2.length === 0) {
      await gateFn(ctx, req, member, projectId, { scope: 'logs.read', action: 'function.logs', resource: slug });
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
      await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'function.versions', resource: slug });
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
      if (member.agent) {
        await gateFn(ctx, req, member, projectId, {
          scope: 'functions.update',
          action: 'function.version.activate',
          resource: slug,
        });
      } else {
        requireManager(member.role);
      }
      const version = Number(rest2[0]);
      if (!Number.isInteger(version) || version < 1)
        throw new ApiError('VALIDATION_ERROR', 'Bad version', 400);
        const fn = await state.service.activateVersion(projectId, slug, version);
        auditFn(ctx, req, member, projectId, 'function.version.activate', slug);
        return finish(200, ok({ function: fn }, requestId));
    }
    if (action === 'env' && rest2.length === 0) {
      if (req.method === 'GET') {
        await gateFn(ctx, req, member, projectId, { scope: 'environment.read', action: 'function.env.read', resource: slug });
        return finish(
          200,
          ok({ env: await state.service.listEnvVars(projectId, slug) }, requestId),
        );
      }
      if (req.method === 'PUT') {
        if (member.agent) {
          await gateFn(ctx, req, member, projectId, {
            scope: 'environment.write',
            action: 'function.env.write',
            resource: slug,
          });
        } else {
          requireManager(member.role);
        }
        const parsed = EnvBody.parse((await readBody()) ?? {});
        const row = await state.service.setEnvVar({
          projectId,
          userId: member.userId,
          idOrSlug: slug,
          key: parsed.key,
          value: parsed.value,
          secret: parsed.secret,
        });
        auditFn(ctx, req, member, projectId, 'function.env.write', slug);
        return finish(200, ok({ env: row }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }
    if (action === 'env' && rest2.length === 1 && rest2[0] && req.method === 'DELETE') {
      if (member.agent) {
        await gateFn(ctx, req, member, projectId, {
          scope: 'environment.write',
          action: 'function.env.delete',
          resource: slug,
        });
      } else {
        requireManager(member.role);
      }
      await state.service.deleteEnvVar(projectId, slug, rest2[0]);
      auditFn(ctx, req, member, projectId, 'function.env.delete', slug);
      res.writeHead(204, baseHeaders);
      res.end();
      return true;
    }
    if (action === 'metrics' && req.method === 'GET' && rest2.length === 0) {
      await gateFn(ctx, req, member, projectId, { scope: 'functions.read', action: 'function.metrics', resource: slug });
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
