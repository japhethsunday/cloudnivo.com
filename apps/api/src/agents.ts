import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import {
  AGENT_SCOPES,
  AgentService,
  AgentTokenError,
  DrizzleActivityStore,
  DrizzleAgentTokenStore,
  DrizzleApprovalStore,
  EXPIRY_PRESETS,
  MemoryActivityStore,
  MemoryAgentTokenStore,
  MemoryApprovalStore,
  agentsOpenApiPaths,
  isKnownScope,
  looksLikeAgentToken,
  type ActivityResult,
  type AgentToken,
  type ApprovalRequest,
} from '@cloudnivo/agents';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';

/**
 * Agent access tokens (Phase 13): dedicated `cn_agent_…` credentials for
 * AI/developer agents, separate from session JWTs and project API keys.
 *
 * This module owns both the management routes (humans: issue/revoke/approve)
 * and the enforcement helpers every plane uses (verify → rate limit →
 * scope → resource isolation → approval gate → activity audit).
 */

export { looksLikeAgentToken } from '@cloudnivo/agents';

export function agentsOpenApi(): Record<string, unknown> {
  return agentsOpenApiPaths();
}

export function agentServiceFor(ctx: ApiContext): AgentService {
  const existing = (ctx as unknown as { __agents?: AgentService }).__agents;
  if (existing) return existing;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const svc = durable && ctx.controlDb
    ? new AgentService(
        new DrizzleAgentTokenStore(ctx.controlDb.db),
        new DrizzleApprovalStore(ctx.controlDb.db),
        new DrizzleActivityStore(ctx.controlDb.db),
      )
    : new AgentService(new MemoryAgentTokenStore(), new MemoryApprovalStore(), new MemoryActivityStore());
  (ctx as unknown as { __agents?: AgentService }).__agents = svc;
  return svc;
}

function toAgentError(err: unknown, requestId: string): { status: number; body: unknown } {
  if (err instanceof AgentTokenError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, requestId } },
    };
  }
  return toPublicError(err, requestId);
}

function clientIp(req: IncomingMessage): string {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

// ── Enforcement helpers (used by every plane) ───────────────

/** Null when the request carries no agent bearer; throws when it is invalid. */
export async function agentFromRequest(
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<AgentToken | null> {
  const raw = bearerFromHeader(req.headers.authorization);
  if (!raw || !looksLikeAgentToken(raw)) return null;
  return agentServiceFor(ctx).verifyToken(raw);
}

/** Session-shaped identity for agent bearers (planes add scope checks). */
export async function agentSessionFor(
  ctx: ApiContext,
  _req: IncomingMessage,
  raw: string,
): Promise<{ sub: string; email: string; agent: AgentToken }> {
  void _req;
  const token = await agentServiceFor(ctx).verifyToken(raw);
  return { sub: token.userId, email: '', agent: token };
}

async function agentRateLimit(ctx: ApiContext, req: IncomingMessage, token: AgentToken): Promise<void> {
  const rl = await checkRateLimit(ctx.rateLimitStore, `agent:${token.id}:${clientIp(req)}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.AGENT_RATE_MAX,
    keyPrefix: 'agent',
  });
  if (!rl.allowed) {
    await auditAgent(ctx, req, {
      token,
      userId: token.userId,
      organizationId: token.organizationId,
      action: 'request.rate_limited',
      result: 'denied',
      reason: 'agent rate limit exceeded',
    });
    throw new ApiError('RATE_LIMITED', 'Agent rate limit exceeded', 429);
  }
}

export function auditAgent(
  ctx: ApiContext,
  req: IncomingMessage,
  entry: {
    token: AgentToken | null;
    userId: string;
    organizationId: string | null;
    projectId?: string | null;
    action: string;
    resource?: string;
    result: ActivityResult;
    reason?: string;
  },
): void {
  const ip = clientIp(req);
  void agentServiceFor(ctx)
    .log({
      tokenId: entry.token ? entry.token.id : null,
      userId: entry.userId,
      organizationId: entry.organizationId,
      projectId: entry.projectId ?? null,
      action: entry.action,
      resource: entry.resource ?? '',
      result: entry.result,
      reason: entry.reason ?? '',
      ip,
    })
    .catch(err => ctx.logger.warn('agent audit failed', { error: String(err).slice(0, 120) }));
  if (entry.result === 'denied' || entry.result === 'blocked') {
    ctx.logger.warn('agent denied', { action: entry.action, reason: entry.reason ?? '' });
  }
}

/**
 * Identity + isolation gate without a scope requirement: verifies the token,
 * rate-limits, and confines it to the organization/project. Operations add
 * their own scope via requireAgentScope below.
 */
export async function verifyAgentAccess(
  ctx: ApiContext,
  req: IncomingMessage,
  token: AgentToken,
  opts: { organizationId?: string; projectId?: string; action: string },
): Promise<AgentToken> {
  const svc = agentServiceFor(ctx);
  try {
    await agentRateLimit(ctx, req, token);
    if (opts.organizationId !== undefined) svc.requireInScope(token, opts.organizationId, opts.projectId);
    return token;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'denied';
    const code = err instanceof AgentTokenError ? err.code : err instanceof ApiError ? err.code : 'FORBIDDEN';
    await svc
      .log({
        tokenId: token.id,
        userId: token.userId,
        organizationId: opts.organizationId ?? token.organizationId,
        projectId: opts.projectId ?? null,
        action: opts.action,
        resource: '',
        result: 'denied',
        reason: `${code}: ${reason}`.slice(0, 300),
        ip: clientIp(req),
      })
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Scope-only gate (no rate limiting): for requests already verified through
 * verifyAgentAccess (which rate-limits once per request). Enforces one scope
 * plus resource isolation, logging every denial.
 */
export async function requireAgentScope(
  ctx: ApiContext,
  req: IncomingMessage,
  token: AgentToken,
  opts: { scope: string; organizationId?: string; projectId?: string; action: string; resource?: string },
): Promise<AgentToken> {
  const svc = agentServiceFor(ctx);
  try {
    svc.requireScope(token, opts.scope, opts.resource ?? '');
    if (opts.organizationId !== undefined) svc.requireInScope(token, opts.organizationId, opts.projectId);
    return token;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'denied';
    const code = err instanceof AgentTokenError ? err.code : 'FORBIDDEN';
    await svc
      .log({
        tokenId: token.id,
        userId: token.userId,
        organizationId: opts.organizationId ?? token.organizationId,
        projectId: opts.projectId ?? null,
        action: opts.action,
        resource: opts.resource ?? '',
        result: 'denied',
        reason: `${code}: ${reason}`.slice(0, 300),
        ip: clientIp(req),
      })
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Full gate for one agent operation: verify already done by the caller via
 * agentFromRequest; this enforces rate limit, scope, and resource isolation,
 * logging every denial. Throws ApiError (never returns null).
 */
export async function requireAgent(
  ctx: ApiContext,
  req: IncomingMessage,
  token: AgentToken,
  opts: { scope: string; organizationId?: string; projectId?: string; action: string; resource?: string },
): Promise<AgentToken> {
  const svc = agentServiceFor(ctx);
  try {
    await agentRateLimit(ctx, req, token);
    svc.requireScope(token, opts.scope, opts.resource ?? '');
    if (opts.organizationId !== undefined) svc.requireInScope(token, opts.organizationId, opts.projectId);
    return token;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'denied';
    const code = err instanceof AgentTokenError ? err.code : err instanceof ApiError ? err.code : 'FORBIDDEN';
    await svc
      .log({
        tokenId: token.id,
        userId: token.userId,
        organizationId: opts.organizationId ?? token.organizationId,
        projectId: opts.projectId ?? null,
        action: opts.action,
        resource: opts.resource ?? '',
        result: 'denied',
        reason: `${code}: ${reason}`.slice(0, 300),
        ip: clientIp(req),
      })
      .catch(() => undefined);
    throw err;
  }
}

export function approvalIdFrom(req: IncomingMessage): string | null {
  const raw = req.headers['x-approval-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string' || value.length > 200) return null;
  return value;
}

export function sendApprovalRequired(
  res: ServerResponse,
  baseHeaders: Record<string, string>,
  requestId: string,
  approval: ApprovalRequest,
): void {
  sendJson(
    res,
    428,
    {
      error: {
        code: 'APPROVAL_REQUIRED',
        message: `Destructive operation held for approval (${approval.action}). Ask an organization owner to approve, then repeat the exact request with X-Approval-Id.`,
        requestId,
      },
      data: {
        approval: {
          id: approval.id,
          action: approval.action,
          status: approval.status,
          expiresAt: approval.expiresAt,
        },
      },
    },
    baseHeaders,
  );
}

/**
 * Destructive gate. Returns `{ proceed: true }` when the token holds the
 * scope or presents a valid one-time approval; otherwise records the
 * approval request and returns it for the 428 response. Throws on hard deny.
 */
export async function gateDestructive(
  ctx: ApiContext,
  req: IncomingMessage,
  opts: {
    agent: AgentToken;
    scope: string;
    action: string;
    organizationId: string;
    projectId?: string | null;
    method: string;
    path: string;
    body: unknown;
    resource?: string;
  },
): Promise<{ proceed: true } | { proceed: false; approval: ApprovalRequest }> {
  const svc = agentServiceFor(ctx);
  const gate = svc.gate(opts.agent, opts.scope);
  if (gate.allowed) return { proceed: true };
  if (!gate.needsApproval) {
    await auditAgent(ctx, req, {
      token: opts.agent,
      userId: opts.agent.userId,
      organizationId: opts.organizationId,
      projectId: opts.projectId ?? null,
      action: opts.action,
      resource: opts.resource ?? opts.path,
      result: 'denied',
      reason: `FORBIDDEN_SCOPE: token lacks ${opts.scope}`,
    });
    throw new ApiError('FORBIDDEN', `Agent token lacks required scope: ${opts.scope}`, 403);
  }
  const presented = approvalIdFrom(req);
  if (presented) {
    try {
      await svc.consumeApproval({
        approvalId: presented,
        token: opts.agent,
        method: opts.method,
        path: opts.path,
        body: opts.body,
      });
      await auditAgent(ctx, req, {
        token: opts.agent,
        userId: opts.agent.userId,
        organizationId: opts.organizationId,
        projectId: opts.projectId ?? null,
        action: opts.action,
        resource: `${opts.resource ?? opts.path} (approved ${presented.slice(0, 24)})`,
        result: 'success',
      });
      return { proceed: true };
    } catch (err) {
      await auditAgent(ctx, req, {
        token: opts.agent,
        userId: opts.agent.userId,
        organizationId: opts.organizationId,
        projectId: opts.projectId ?? null,
        action: opts.action,
        result: 'blocked',
        reason: err instanceof Error ? err.message.slice(0, 300) : 'invalid approval',
      });
      throw err;
    }
  }
  const approval = await svc.requestApproval({
    organizationId: opts.organizationId,
    projectId: opts.projectId ?? null,
    token: opts.agent,
    action: opts.action,
    method: opts.method,
    path: opts.path,
    body: opts.body,
  });
  await auditAgent(ctx, req, {
    token: opts.agent,
    userId: opts.agent.userId,
    organizationId: opts.organizationId,
    projectId: opts.projectId ?? null,
    action: opts.action,
    resource: `${opts.resource ?? opts.path} (approval ${approval.id.slice(0, 24)})`,
    result: 'blocked',
    reason: 'approval required',
  });
  return { proceed: false, approval };
}

// ── Management routes (human session, owner/admin) ──────────

export function isAgentRoute(pathname: string, method: string): boolean {
  void method;
  if (pathname === '/api/v1/agent/approvals' || pathname === '/api/v1/agent/whoami') return true;
  return /^\/api\/v1\/organizations\/[^/]+\/(agent-tokens|agent-activity|approvals)/.test(pathname);
}

async function requireOrgManager(
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<{ userId: string; organizationId: string; role: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = /^\/api\/v1\/organizations\/([^/]+)\//.exec(url.pathname);
  const organizationId = m?.[1] ?? '';
  if (!organizationId) throw new ApiError('NOT_FOUND', 'Not found', 404);
  const memberships = await ctx.registry.membershipsFor(session.sub);
  const mine = memberships.find(x => x.organizationId === organizationId);
  if (!mine) throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
  if (mine.role !== 'owner' && mine.role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Agent administration requires owner or admin', 403);
  }
  return { userId: session.sub, organizationId, role: mine.role };
}

const CreateTokenBody = z.object({
  name: z.string().min(1).max(100),
  organizationId: z.string().uuid().nullable().optional(),
  scopes: z.array(z.string().max(60)).min(1).max(40),
  projectIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  approvalRequired: z.boolean().default(false),
  expiresIn: z.enum(['7d', '30d', '90d', '365d', 'never']).default('30d'),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  if (text.length > 262_144) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const start = Date.now();
  const finish = (status: number, body: unknown): true => {
    logger.info('agents.request', { route: pathname, method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toAgentError(err, requestId);
    logger.info('agents.request', { route: pathname, method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };

  try {
    // Agent self-service: identify this credential (agent bearer).
    if (pathname === '/api/v1/agent/whoami' && method === 'GET') {
      const agent = await agentFromRequest(ctx, req);
      if (!agent) throw new ApiError('UNAUTHORIZED', 'Missing or invalid agent token', 401);
      const { hash: _dropped, ...exposed } = agent;
      void _dropped;
      return finish(200, ok({ token: exposed, scopes: agent.scopes }, requestId));
    }

    // Agent self-service: list own pending approvals (agent bearer).
    if (pathname === '/api/v1/agent/approvals' && method === 'GET') {      const agent = await agentFromRequest(ctx, req);
      if (!agent) throw new ApiError('UNAUTHORIZED', 'Missing or invalid agent token', 401);
      const svc = agentServiceFor(ctx);
      const status = url.searchParams.get('status') as 'pending' | 'approved' | null;
      const items = await svc.listApprovalsByToken(agent.id, status ?? undefined);
      return finish(200, ok({ approvals: items }, requestId));
    }

    const orgMatch = /^\/api\/v1\/organizations\/([^/]+)\/(agent-tokens|agent-activity|approvals)(?:\/([^/]+))?(\/[^/]+)?\/?$/.exec(
      pathname,
    );
    if (!orgMatch?.[1] || !orgMatch[2]) return false;
    const [, , section, sub, verb] = orgMatch;
    const member = await requireOrgManager(ctx, req);
    const svc = agentServiceFor(ctx);

    // ── Tokens ──
    if (section === 'agent-tokens' && !sub && method === 'GET') {
      const tokens = await svc.listTokens(member.userId);
      const mine = tokens.filter(
        t => t.organizationId === null || t.organizationId === member.organizationId,
      );
      return finish(
        200,
        ok({ tokens: mine, scopes: AGENT_SCOPES, expiryPresets: EXPIRY_PRESETS }, requestId),
      );
    }

    if (section === 'agent-tokens' && !sub && method === 'POST') {
      const parsed = parseBody(CreateTokenBody, await readJsonBody(req));
      for (const scope of parsed.scopes) {
        if (!isKnownScope(scope)) throw new ApiError('VALIDATION_ERROR', `Unknown scope: ${scope}`, 400);
      }
      // Scope the token to this organization unless the caller explicitly
      // asked for account-wide (null) — still bound by their memberships.
      const organizationId = parsed.organizationId === undefined ? member.organizationId : parsed.organizationId;
      if (organizationId !== null) {
        const memberships = await ctx.registry.membershipsFor(member.userId);
        if (!memberships.some(m => m.organizationId === organizationId)) {
          throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
        }
      }
      // Every listed project must exist inside the token's organization.
      for (const projectId of parsed.projectIds ?? []) {
        const project = await ctx.registry.getProject(projectId);
        if (!project) throw new ApiError('NOT_FOUND', `Project not found: ${projectId.slice(0, 24)}`, 404);
        if (organizationId && project.organizationId !== organizationId) {
          throw new ApiError('VALIDATION_ERROR', 'Project is not in the token organization', 400);
        }
        if (!organizationId) {
          const memberships = await ctx.registry.membershipsFor(member.userId);
          if (!memberships.some(m => m.organizationId === project.organizationId)) {
            throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
          }
        }
      }
      const { token, raw } = await svc.createToken({
        userId: member.userId,
        organizationId,
        name: parsed.name,
        scopes: [...new Set(parsed.scopes)],
        projectIds: [...new Set(parsed.projectIds ?? [])],
        approvalRequired: parsed.approvalRequired,
        expiresIn: parsed.expiresIn,
      });
      await ctx.registry.recordAudit('agent.token.created', {
        organizationId: organizationId ?? undefined,
        userId: member.userId,
      });
      return finish(201, ok({ token, raw }, requestId));
    }

    if (section === 'agent-tokens' && sub && !verb && method === 'GET') {
      const token = await svc.getToken(member.userId, sub);
      if (token.organizationId !== null && token.organizationId !== member.organizationId) {
        throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
      }
      return finish(200, ok({ token, scopes: AGENT_SCOPES }, requestId));
    }

    if (section === 'agent-tokens' && sub && !verb && method === 'DELETE') {
      const existing = await svc.getToken(member.userId, sub).catch(() => null);
      if (existing && existing.organizationId !== null && existing.organizationId !== member.organizationId) {
        throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
      }
      const revoked = await svc.revokeToken(sub, member.userId);
      await ctx.registry.recordAudit('agent.token.revoked', {
        organizationId: member.organizationId,
        userId: member.userId,
      });
      return finish(200, ok({ token: revoked }, requestId));
    }

    // ── Activity ──
    if (section === 'agent-activity' && method === 'GET') {
      const tokenId = url.searchParams.get('tokenId') ?? undefined;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
      if (tokenId) {
        const token = await svc.getToken(member.userId, tokenId).catch(() => null);
        if (!token) throw new ApiError('NOT_FOUND', 'Agent token not found', 404);
      }
      const entries = await svc.listActivity({ organizationId: member.organizationId, tokenId, limit });
      return finish(200, ok({ activity: entries }, requestId));
    }

    // ── Approvals inbox ──
    if (section === 'approvals' && !sub && method === 'GET') {
      const status = url.searchParams.get('status') as 'pending' | 'approved' | null;
      const items = await svc.listApprovalsByOrganization(
        member.organizationId,
        status ?? undefined,
      );
      return finish(200, ok({ approvals: items }, requestId));
    }

    if (section === 'approvals' && sub && (verb === '/approve' || verb === '/reject') && method === 'POST') {
      const current = await svc.getApproval(sub);
      if (!current || current.organizationId !== member.organizationId) {
        throw new ApiError('NOT_FOUND', 'Approval request not found', 404);
      }
      const decided = await svc.decideApproval(sub, verb === '/approve' ? 'approved' : 'rejected');
      await ctx.registry.recordAudit(
        verb === '/approve' ? 'agent.approval.approved' : 'agent.approval.rejected',
        { organizationId: member.organizationId, userId: member.userId },
      );
      return finish(200, ok({ approval: decided }, requestId));
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
