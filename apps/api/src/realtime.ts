import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, checkRateLimit, ok, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, decodeCustomerToken, verifySession } from '@cloudnivo/auth';
import { queryProjectDb, toConnectionString } from '@cloudnivo/database';
import { PostgresNotifyListener, changeFeedDdl } from '@cloudnivo/database';
import { verifyKey } from '@cloudnivo/api-engine';
import {
  MemoryEventBus,
  MemoryPresenceManager,
  RedisEventBus,
  RedisPresenceManager,
  RealtimeGateway,
  RealtimeServer,
  type AuthContext,
  type DbChangeEvent,
  type EventBus,
  type PresenceManager,
} from '@cloudnivo/realtime';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';
import { verifyCustomerCaller } from './customer-auth.js';
import type { AgentToken } from '@cloudnivo/agents';
import { agentFromRequest, agentServiceFor, requireAgentScope, verifyAgentAccess } from './agents.js';

/**
 * Realtime HTTP + WebSocket wiring.
 *
 * - WS upgrades live at /api/v1/projects/:id/realtime/ws (in-process on the
 *   API port, or standalone on REALTIME_PORT — same factory).
 * - Auth reuses the data-plane caller resolution over upgrade credentials
 *   (query ?token= / ?apikey=, since browsers cannot set WS headers).
 * - CDC: per-project LISTEN multiplexers + lazy trigger installs; the fake
 *   driver exposes the same publish seam for tests (never in production).
 */

// ── Shared realtime state (one set per API process) ───────────────────

export interface RealtimeState {
  gateway: RealtimeGateway;
  bus: EventBus;
  presence: PresenceManager;
  server: RealtimeServer;
  listeners: Map<string, PostgresNotifyListener>;
  feedsInstalled: Map<string, Set<string>>;
}

export function realtimeFor(ctx: ApiContext): RealtimeState {
  const existing = (ctx as unknown as { __rt?: RealtimeState }).__rt;
  if (existing) return existing;
  const useRedis = ctx.config.REALTIME_DRIVER === 'redis' && ctx.config.NODE_ENV !== 'test';
  const bus: EventBus = useRedis
    ? new RedisEventBus({
        url: ctx.config.REDIS_URL,
        onError: err =>
          ctx.logger.warn('realtime bus degraded', { error: String(err).slice(0, 120) }),
      })
    : new MemoryEventBus();
  const presence: PresenceManager = useRedis
    ? new RedisPresenceManager(ctx.config.REDIS_URL)
    : new MemoryPresenceManager();
  const gateway = new RealtimeGateway(
    bus,
    presence,
    {
      maxConnsPerProject: ctx.config.REALTIME_MAX_CONNS_PER_PROJECT,
      maxSubsPerConn: ctx.config.REALTIME_MAX_SUBS_PER_CONN,
      maxPayloadBytes: ctx.config.REALTIME_MAX_PAYLOAD_BYTES,
      maxMsgPerSecond: ctx.config.REALTIME_MAX_MSG_PER_SECOND,
      maxBroadcastsPerMinute: ctx.config.REALTIME_MAX_BROADCASTS_PER_MINUTE,
      heartbeatIntervalMs: ctx.config.REALTIME_HEARTBEAT_MS,
      heartbeatTimeoutMs: ctx.config.REALTIME_HEARTBEAT_TIMEOUT_MS,
    },
    ctx.rateLimitStore,
    {
      ensureTableFeed: (projectId, table) => ensureTableFeed(ctx, projectId, table),
      tableColumns: (projectId, table) => tableColumns(ctx, projectId, table),
    },
  );
  const server = new RealtimeServer(gateway, (req, projectId) => upgradeAuth(ctx, req, projectId), {
    maxPayloadBytes: ctx.config.REALTIME_MAX_PAYLOAD_BYTES,
    heartbeatIntervalMs: ctx.config.REALTIME_HEARTBEAT_MS,
    pathPrefix: '/api/v1/projects/',
  });
  const state: RealtimeState = {
    gateway,
    bus,
    presence,
    server,
    listeners: new Map(),
    feedsInstalled: new Map(),
  };
  (ctx as unknown as { __rt?: RealtimeState }).__rt = state;
  return state;
}

async function credsFor(
  ctx: ApiContext,
  projectId: string,
): Promise<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}> {
  const db = await ctx.registry.getDatabaseByProject(projectId);
  const cred = await ctx.registry.getCredential(projectId);
  if (!db || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
  return {
    host: db.host,
    port: db.port,
    database: db.dbName,
    user: cred.dbUser,
    password: cred.password,
  };
}

/** Lazy trigger install + LISTEN multiplexer for one project database. */
export async function ensureProjectFeed(ctx: ApiContext, projectId: string): Promise<void> {
  const state = realtimeFor(ctx);
  if (state.listeners.has(projectId)) return;
  if (ctx.provider.provider === 'fake') return;
  const creds = await credsFor(ctx, projectId);
  const connStr = toConnectionString(creds);
  const listener = new PostgresNotifyListener(connStr, {
    onError: err =>
      ctx.logger.warn('realtime cdc error', {
        project: projectId,
        error: String(err).slice(0, 160),
      }),
  });
  listener.onChange(n => {
    const evt: DbChangeEvent = {
      type: n.op,
      project_id: projectId,
      table: n.table,
      schema: n.schema,
      record: n.record,
      old_record: n.old_record,
      timestamp: new Date().toISOString(),
    };
    void state.gateway.publishDatabaseChange(projectId, evt).catch(() => undefined);
  });
  state.listeners.set(projectId, listener);
}

async function ensureTableFeed(ctx: ApiContext, projectId: string, table: string): Promise<void> {
  const state = realtimeFor(ctx);
  let installed = state.feedsInstalled.get(projectId);
  if (!installed) {
    installed = new Set();
    state.feedsInstalled.set(projectId, installed);
  }
  await ensureProjectFeed(ctx, projectId);
  if (installed.has(table) || ctx.provider.provider === 'fake') {
    installed.add(table);
    return;
  }
  const creds = await credsFor(ctx, projectId);
  for (const stmt of changeFeedDdl('public', table)) {
    await queryProjectDb(creds, stmt, [], 15_000);
  }
  installed.add(table);
}

async function tableColumns(ctx: ApiContext, projectId: string, table: string): Promise<string[]> {
  const schema = await ctx.data.readSchema(await credsFor(ctx, projectId));
  return schema.tables.find(t => t.name === table)?.columns.map(c => c.name) ?? [];
}

// ── Upgrade authentication ────────────────────────────────────────────

/**
 * Read the `exp` claim from an already-verified JWT without new dependencies
 * (signature + issuer + audience were checked by the auth package first).
 * Returns an ISO timestamp or null when absent/unparseable. Never throws,
 * never logs the token.
 */
function expiresAtOf(token: string): string | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
}

function upgradeCredentials(req: IncomingMessage): { headers: Record<string, string | undefined> } {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');
  const apikey = url.searchParams.get('apikey');
  const headers: Record<string, string | undefined> = {
    ...(req.headers as Record<string, string | undefined>),
  };
  if (token && !headers['authorization']) headers['authorization'] = `Bearer ${token}`;
  if (apikey && !headers['apikey']) headers['apikey'] = apikey;
  return { headers };
}

async function upgradeAuth(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<AuthContext> {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const rl = await checkRateLimit(ctx.rateLimitStore, `rt-conn:${ip}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.AUTH_RATE_MAX,
    keyPrefix: 'rt-conn',
  });
  if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many connection attempts', 429);
  const project = await ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const { headers } = upgradeCredentials(req);

  const rawKey = headers['apikey'];
  if (typeof rawKey === 'string' && rawKey.length > 0) {
    // Same semantics as the data plane (scope, revocation, expiry).
    let stored;
    try {
      stored = await verifyKey(ctx.keys, rawKey);
    } catch {
      throw new ApiError('UNAUTHORIZED', 'Invalid API key', 401);
    }
    if (stored.projectId !== projectId) {
      throw new ApiError('TENANT_FORBIDDEN', 'API key is not scoped to this project', 403);
    }
    return {
      userId: null,
      role: stored.role,
      projectId: project.id,
      organizationId: project.organizationId,
      expiresAt: stored.expiresAt,
    };
  }

  const token = bearerFromHeader(headers['authorization']);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing credentials', 401);
  // Agent tokens route by prefix before any JWT handling (they are opaque).
  // Subscribe needs realtime.read; broadcast additionally needs
  // realtime.manage (enforced by the gateway via the narrowed role below).
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    const agent = await verifyAgentAccess(ctx, req, maybeAgent, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'realtime.connect',
    });
    await mustOwnProject(ctx.registry, agent.userId, projectId);
    const svc = agentServiceFor(ctx);
    const canPublish = svc.hasScope(agent, 'realtime.read') && svc.hasScope(agent, 'realtime.manage');
    if (!svc.hasScope(agent, 'realtime.read')) {
      await svc
        .log({
          tokenId: agent.id,
          userId: agent.userId,
          organizationId: project.organizationId,
          projectId: project.id,
          action: 'realtime.connect',
          resource: '',
          result: 'denied',
          reason: 'FORBIDDEN_SCOPE: token lacks realtime.read',
          ip:
            (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            'unknown',
        })
        .catch(() => undefined);
      throw new ApiError('FORBIDDEN', 'Agent token lacks required scope: realtime.read', 403);
    }
    return {
      userId: agent.userId,
      role: canPublish ? 'agent' : 'agent:readonly',
      projectId: project.id,
      organizationId: project.organizationId,
      expiresAt: agent.expiresAt,
    };
  }
  // Customer tokens first (audience-bound), then platform sessions.
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
      role: customer.role,
      projectId: project.id,
      organizationId: project.organizationId,
      expiresAt: expiresAtOf(token),
    };
  }
  let sub: string | null = null;
  try {
    sub = (
      await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      })
    ).sub;
  } catch {
    sub = null;
  }
  if (!sub) throw new ApiError('UNAUTHORIZED', 'Invalid or expired credentials', 401);
  const owned = await mustOwnProject(ctx.registry, sub, projectId);
  const role =
    (await ctx.registry.membershipsFor(sub)).find(m => m.organizationId === owned.organizationId)
      ?.role ?? 'viewer';
  return {
    userId: sub,
    role,
    projectId: owned.id,
    organizationId: owned.organizationId,
    expiresAt: expiresAtOf(token),
  };
}

// ── HTTP management routes ────────────────────────────────────────────

/** True when /projects/:id/realtime... belongs to realtime management. */
export function isRealtimeRoute(rest: string[], method: string): boolean {
  if (rest.length < 2 || !rest[0] || rest[1] !== 'realtime') return false;
  void method;
  return true;
}

async function requireMember(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<{ userId: string; role: string; projectId: string; organizationId: string; agent?: AgentToken }> {
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const agent = await verifyAgentAccess(ctx, req, maybeAgent, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'realtime.access',
    });
    await mustOwnProject(ctx.registry, agent.userId, projectId);
    return { userId: agent.userId, role: 'agent', projectId: project.id, organizationId: project.organizationId, agent };
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
  return { userId: session.sub, role, projectId: owned.id, organizationId: owned.organizationId };
}

export async function handleRealtimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
): Promise<boolean> {
  const [projectId, , ...tail] = rest;
  if (!projectId) return false;
  const start = Date.now();
  const [head, ...extra] = tail;
  try {
    const member = await requireMember(ctx, req, projectId);
    if (member.agent) {
      await requireAgentScope(ctx, req, member.agent, {
        scope: 'realtime.read',
        organizationId: member.organizationId,
        projectId: member.projectId,
        action: 'realtime.read',
      });
    }
    const state = realtimeFor(ctx);
    const finish = (status: number, body: unknown): true => {
      logger.info('realtime.request', {
        project: projectId,
        route: tail.join('/') || '(root)',
        method: req.method,
        status,
        latencyMs: Date.now() - start,
      });
      sendJson(res, status, body, baseHeaders);
      return true;
    };
    if (head === undefined && req.method === 'GET') {
      return finish(
        200,
        ok(
          {
            ws: `/api/v1/projects/${projectId}/realtime/ws`,
            drivers: { bus: state.bus.driver, presence: state.presence.driver },
            degraded:
              state.bus.driver === 'redis'
                ? ((state.bus as unknown as { isDegraded?: () => boolean }).isDegraded?.() ?? false)
                : false,
          },
          requestId,
        ),
      );
    }
    if (head === 'stats' && req.method === 'GET' && extra.length === 0) {
      return finish(200, ok({ stats: state.gateway.snapshot() }, requestId));
    }
    if (head === 'channels' && req.method === 'GET' && extra.length === 0) {
      return finish(200, ok({ channels: state.gateway.channelsFor(projectId) }, requestId));
    }
    if (head === 'presence' && req.method === 'GET' && extra.length === 0) {
      const channels = state.gateway.channelsFor(projectId);
      const out: Record<string, unknown> = {};
      for (const c of channels.slice(0, 50)) {
        out[c.channel] = await state.presence.state(c.channel);
      }
      return finish(200, ok({ presence: out }, requestId));
    }
    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    logger.info('realtime.request', {
      project: projectId,
      route: tail.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  }
}
