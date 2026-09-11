import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, ok, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import type { Logger } from '@cloudnivo/logging';
import type { AgentToken } from '@cloudnivo/agents';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';
import { agentFromRequest, requireAgentScope, verifyAgentAccess } from './agents.js';

/**
 * Request-metrics reads (org-scoped).
 *
 * Samples are process-local ("since boot", labeled in every response) and
 * carry only service/route/status/latency/project — never bodies, headers,
 * or identities. Callers see exactly the projects their membership (and, for
 * agents, project allow-list) admits; platform samples without a project are
 * never exposed here.
 */

const WINDOWS: Record<string, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

export function isMetricsRoute(pathname: string, method: string): boolean {
  void method;
  return /^\/api\/v1\/organizations\/[^/]+\/metrics\/?$/.test(pathname);
}

export function metricsOpenApi(): Record<string, unknown> {
  return {
    '/organizations/{id}/metrics': {
      get: { summary: 'Request metrics summary (since boot)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
    },
  };
}

export async function handleMetricsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/api\/v1\/organizations\/([^/]+)\/metrics\/?$/.exec(url.pathname);
  if (!match?.[1]) return false;
  const organizationId = match[1] as string;
  const start = Date.now();
  const finish = (status: number, body: unknown): true => {
    logger.info('metrics.request', { organization: organizationId, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  try {
    if ((req.method ?? 'GET') !== 'GET') {
      return finish(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId } });
    }
    // ── Caller: human member or agent (automation.read) ──
    let userId: string;
    let agent: AgentToken | undefined;
    const maybeAgent = await agentFromRequest(ctx, req);
    if (maybeAgent) {
      const agent = await verifyAgentAccess(ctx, req, maybeAgent, {
        organizationId,
        action: 'metrics.read',
      });
      userId = agent.userId;
      const memberships = await ctx.registry.membershipsFor(agent.userId);
      if (!memberships.some(m => m.organizationId === organizationId)) {
        throw new ApiError('TENANT_FORBIDDEN', 'No access to this organization', 403);
      }
      await requireAgentScope(ctx, req, agent, {
        scope: 'automation.read',
        organizationId,
        action: 'metrics.read',
      });
    } else {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      userId = session.sub;
      const memberships = await ctx.registry.membershipsFor(session.sub);
      if (!memberships.some(m => m.organizationId === organizationId)) {
        throw new ApiError('TENANT_FORBIDDEN', 'No access to this organization', 403);
      }
    }

    const window = url.searchParams.get('window') ?? '1h';
    const windowMs = WINDOWS[window];
    if (!windowMs) throw new ApiError('VALIDATION_ERROR', 'window must be one of 1h, 6h, 24h, 7d', 400);
    const projects = await ctx.registry.listProjects(userId);
    let allowed = projects.filter(p => p.organizationId === organizationId).map(p => p.id);
    if (agent && agent.projectIds.length > 0) {
      const set = new Set(agent.projectIds);
      allowed = allowed.filter(id => set.has(id));
    }
    const only = url.searchParams.get('projectId');
    if (only) {
      if (!allowed.includes(only)) throw new ApiError('NOT_FOUND', 'Project not found', 404);
      allowed = [only];
    }
    const summary = ctx.metrics.summarize(windowMs, Date.now(), new Set(allowed));
    return finish(
      200,
      ok(
        {
          organizationId,
          window,
          sinceBoot: new Date(summary.since).toISOString(),
          note: 'Process-local request metrics since boot; durable time-series is on the roadmap.',
          projects: allowed,
          ...summary,
        },
        requestId,
      ),
    );
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    logger.info('metrics.request', { organization: organizationId, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  }
}
