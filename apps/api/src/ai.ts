import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import { changeFeedDdl } from '@cloudnivo/database';
import {
  AIAuditLog,
  AIUsageTracker,
  PlanStore,
  aiOpenApiPaths,
  buildMigration,
  builderFromConfig,
  contextToExisting,
  levelForRole,
  diagnose,
  type AIBackendBuilder,
  type DestructiveOp,
  type ProjectContext,
  type ToolAdapters,
} from '@cloudnivo/ai';
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
  requireAgentScope,
  sendApprovalRequired,
  verifyAgentAccess,
} from './agents.js';
import { storageFor } from './storage.js';
import { functionsFor } from './functions.js';
import { emitAutomationEvent } from './automation.js';
import { ensureProjectFeed, realtimeFor } from './realtime.js';

/**
 * AI Backend Builder HTTP wiring.
 *
 * Generation (plan) and execution (apply) are separate routes with separate
 * permission gates. Plans are validated structured data — never executed
 * without approval, and destructive plans additionally require explicit
 * per-operation confirmations. Every transition is audit-logged; prompts are
 * stored redacted; provider credentials never leave server env.
 */

// ── Builder singleton (one per API process) ─────────────────────────

export interface AIState {
  builder: AIBackendBuilder;
}

export function aiFor(ctx: ApiContext): AIState {
  const existing = (ctx as unknown as { __ai?: AIState }).__ai;
  if (existing) return existing;
  const c = ctx.config;
  const builder = builderFromConfig(
    {
      provider: c.AI_PROVIDER === 'openai-compatible' ? 'openai-compatible' : 'local',
      model: c.AI_MODEL,
      apiKey: c.AI_API_KEY,
      baseUrl: c.AI_BASE_URL,
      timeoutMs: c.AI_REQUEST_TIMEOUT_MS,
    },
    { plans: new PlanStore(), audit: new AIAuditLog(), usage: new AIUsageTracker() },
  );
  const state = { builder };
  (ctx as unknown as { __ai?: AIState }).__ai = state;
  return state;
}

/** True when /projects/:id/ai... belongs to the AI builder. */
export function isAiRoute(rest: string[], method: string): boolean {
  void method;
  if (rest.length < 2 || !rest[0] || rest[1] !== 'ai') return false;
  return true;
}

export function aiOpenApi(): Record<string, unknown> {
  return aiOpenApiPaths();
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
      action: 'ai.access',
    });
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

function requireAdmin(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'AI plan approval requires admin', 403);
  }
}

async function aiLimit(ctx: ApiContext, req: IncomingMessage, scope: string): Promise<void> {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const rl = await checkRateLimit(ctx.rateLimitStore, `ai:${scope}:${ip}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.AI_RATE_MAX,
    keyPrefix: 'ai',
  });
  if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'AI request rate exceeded', 429);
}

// ── Project-bound tool adapters (real services) ─────────────────────

async function projectCreds(ctx: ApiContext, projectId: string) {
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

async function buildProjectContext(
  ctx: ApiContext,
  projectId: string,
  member: { userId: string; role: string; organizationId: string },
): Promise<ProjectContext> {
  const tables: ProjectContext['tables'] = [];
  try {
    const schema = await ctx.gateway.inspect(await projectCreds(ctx, projectId));
    for (const t of schema.tables)
      tables.push({ schema: t.schema, name: t.name, columns: t.columns.map(c => c.name) });
  } catch {
    // Unprovisioned DB: context simply has no tables yet.
  }
  let buckets: ProjectContext['buckets'] = [];
  try {
    const svc = storageFor(ctx);
    const listed = await svc.listBuckets({
      kind: 'session',
      userId: member.userId,
      role: member.role,
      projectId,
      organizationId: member.organizationId,
    });
    buckets = listed.map(b => ({ name: b.name, visibility: b.visibility }));
  } catch {
    buckets = [];
  }
  let functions: ProjectContext['functions'] = [];
  try {
    functions = (await functionsFor(ctx).service.listFunctions(projectId)).map(f => ({
      slug: f.slug,
      status: f.status,
    }));
  } catch {
    functions = [];
  }
  let channels: string[] = [];
  try {
    channels = realtimeFor(ctx)
      .gateway.snapshot()
      .channels.filter(c => c.startsWith(`project:${projectId}:`));
  } catch {
    channels = [];
  }
  let recentChanges: string[] = [];
  try {
    recentChanges = (await aiFor(ctx).builder.getHistory(projectId, 10)).map(
      e => `${e.action} ${e.resource} (${e.result})`,
    );
  } catch {
    recentChanges = [];
  }
  return {
    projectId,
    tables,
    buckets,
    functions,
    channels,
    roles: ['owner', 'admin', 'member', 'viewer'],
    recentChanges,
  };
}

function buildAdapters(
  ctx: ApiContext,
  projectId: string,
  organizationId: string,
  member: { userId: string; email: string; role: string },
): ToolAdapters {
  const fullMember = { ...member, organizationId };
  return {
    inspectProject: async () => buildProjectContext(ctx, projectId, fullMember),
    inspectDatabase: async () => {
      const schema = await ctx.gateway.inspect(await projectCreds(ctx, projectId));
      return schema.tables.map(t => ({
        schema: t.schema,
        name: t.name,
        columns: t.columns.map(c => c.name),
      }));
    },
    executeMigration: async statements => {
      const creds = await projectCreds(ctx, projectId);
      let executed = 0;
      for (const stmt of statements) {
        await ctx.gateway.query(creds, stmt, {
          maxStatementMs: Math.min(ctx.config.PROVISION_MAX_SQL_MS, 30_000),
          maxRows: 0,
          maxLength: 20_000,
        });
        executed += 1;
      }
      return { executed };
    },
    rollbackMigration: async rollbackStatements => {
      const creds = await projectCreds(ctx, projectId);
      let rolledBack = 0;
      for (const stmt of rollbackStatements) {
        try {
          await ctx.gateway.query(creds, stmt, {
            maxStatementMs: Math.min(ctx.config.PROVISION_MAX_SQL_MS, 30_000),
            maxRows: 0,
            maxLength: 20_000,
          });
          rolledBack += 1;
        } catch {
          break;
        }
      }
      return { rolledBack };
    },
    createBucket: async input => {
      const svc = storageFor(ctx);
      const bucket = await svc.createBucket(
        { kind: 'session', userId: member.userId, role: member.role, projectId, organizationId },
        {
          name: input.name,
          visibility: input.visibility,
          allowedMimeTypes: input.allowedMimeTypes,
          ownerIsolation: true,
        },
      );
      return { name: bucket.name };
    },
    createFunction: async input => {
      const svc = functionsFor(ctx).service;
      const created = await svc.createFunction({
        projectId,
        organizationId,
        userId: member.userId,
        name: input.name,
        slug: input.name,
        description: input.purpose,
        runtime: 'node22',
        entrypoint: 'handler',
      });
      const { job } = await svc.deployFunction({
        projectId,
        organizationId,
        userId: member.userId,
        idOrSlug: created.id,
        source: input.source,
        runtime: 'node22',
        entrypoint: 'handler',
      });
      // Bounded wait: deploy pipeline is async; report honestly either way.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const current = await svc.getDeployment(projectId, created.id, job.id);
        if (current.status === 'ready') break;
        if (current.status === 'failed')
          throw new Error(`deploy failed: ${current.lastError ?? 'unknown'}`);
        if (Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const status = await svc.getFunctionStatus(projectId, created.id);
      if (status.status !== 'ready' && status.status !== 'running') {
        throw new Error(`function not ready after deploy window (status: ${status.status})`);
      }
      return { slug: created.slug, jobId: job.id };
    },
    enableRealtime: async input => {
      if (input.kind === 'table' && input.table) {
        const creds = await projectCreds(ctx, projectId);
        for (const stmt of changeFeedDdl('public', input.table)) {
          await ctx.gateway.query(creds, stmt, {
            maxStatementMs: Math.min(ctx.config.PROVISION_MAX_SQL_MS, 15_000),
            maxRows: 0,
            maxLength: 20_000,
          });
        }
        await ensureProjectFeed(ctx, projectId).catch(() => undefined);
        return { topic: `project:${projectId}:table:${input.table}` };
      }
      // Broadcast/presence channels are structural — they exist when used.
      return { topic: `project:${projectId}:${input.topic}` };
    },
  };
}

// ── Route schemas ───────────────────────────────────────────────────

const PlanBody = z.object({
  prompt: z.string().min(10).max(50_000),
});

const ApproveBody = z.object({
  confirmations: z.array(z.string()).max(10).default([]),
});

const DiagnoseBody = z.object({
  ref: z.string().min(1).max(100).optional(),
  note: z.string().max(2000).optional(),
});

// ── Handler ─────────────────────────────────────────────────────────

export async function handleAiRoutes(
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
  const finish = (status: number, body: unknown): true => {
    logger.info('ai.request', {
      project: projectId,
      route: tail.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toPublicError(err, requestId);
    logger.info('ai.request', {
      project: projectId,
      route: tail.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const readJson = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
    }
  };
  try {
    const member = await requireMember(ctx, req, projectId);
    // Agents resolve builder permission from scopes (never from member roles).
    const agent = member.agent ?? null;
    const level = agent
      ? agentServiceFor(ctx).hasScope(agent, 'database.migrate')
        ? 'ADMIN'
        : 'APPROVAL_REQUIRED'
      : levelForRole(member.role);
    const state = aiFor(ctx);
    const [head, ...extra] = tail;

    async function gateAi(opts: { scope: string; action: string }): Promise<void> {
      if (!agent) return;
      await requireAgentScope(ctx, req, agent, {
        scope: opts.scope,
        organizationId: member.organizationId,
        projectId,
        action: opts.action,
      });
    }

    function auditAi(action: string): void {
      if (!agent) return;
      auditAgent(ctx, req, {
        token: agent,
        userId: agent.userId,
        organizationId: member.organizationId,
        projectId,
        action,
        result: 'success',
      });
    }

    if (head === undefined) {
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    // POST /ai/plan — generate (never executes).
    if (head === 'plan' && extra.length === 0 && req.method === 'POST') {
      if (agent) {
        await gateAi({ scope: 'projects.read', action: 'ai.plan' });
      } else if (level === 'READ_ONLY') {
        throw new ApiError('FORBIDDEN', 'Planning requires a project role', 403);
      }
      await aiLimit(ctx, req, `plan:${member.userId}:${projectId}`);
      const parsed = parseBody(PlanBody, await readJson());
      if (parsed.prompt.length > ctx.config.AI_MAX_PROMPT_CHARS) {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Prompt exceeds the size limit', 413);
      }
      const projectContext = await buildProjectContext(ctx, projectId, member);
      const stored = await state.builder.requestPlan({
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
        prompt: parsed.prompt,
        existing: contextToExisting(projectContext),
        context: projectContext as unknown as Record<string, unknown>,
      });
      ctx.audit.record('ai.plan.requested', {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
      ctx.audit.record('ai.plan.generated', {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
      return finish(201, ok({ plan: exposePlan(stored) }, requestId));
    }

    // GET /ai/plans — list.
    if (head === 'plans' && extra.length === 0 && req.method === 'GET') {
      await gateAi({ scope: 'projects.read', action: 'ai.plans.list' });
      const plans = state.builder.listPlans(projectId);
      return finish(200, ok({ plans: plans.map(exposePlan) }, requestId));
    }

    // GET /ai/usage, GET /ai/history.
    if (head === 'usage' && extra.length === 0 && req.method === 'GET') {
      await gateAi({ scope: 'projects.read', action: 'ai.usage' });
      return finish(200, ok({ usage: state.builder.getUsage(projectId) }, requestId));
    }
    if (head === 'history' && extra.length === 0 && req.method === 'GET') {
      await gateAi({ scope: 'projects.read', action: 'ai.history' });
      return finish(
        200,
        ok({ history: state.builder.getHistory(projectId) }, requestId),
      );
    }

    // POST /ai/diagnose — deterministic failure analysis over real evidence.
    if (head === 'diagnose' && extra.length === 0 && req.method === 'POST') {
      await gateAi({ scope: 'projects.read', action: 'ai.diagnose' });
      await aiLimit(ctx, req, `diagnose:${member.userId}:${projectId}`);
      const parsed = parseBody(DiagnoseBody, await readJson());
      const ref = parsed.ref?.slice(0, 100) ?? null;
      const jobs = await ctx.jobs.listByProject(projectId).catch(() => []);
      const scopedJobs = (ref ? jobs.filter(j => j.id === ref || j.kind === ref) : jobs)
        .slice(-20)
        .map(j => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          lastError: j.lastError,
          updatedAt: j.updatedAt,
        }));
      const functionErrors: { function: string; message: string; at: string }[] = [];
      try {
        const fns = await functionsFor(ctx).service.listFunctions(projectId);
        const scoped = ref ? fns.filter(f => f.id === ref || f.slug === ref) : fns.slice(0, 10);
        for (const fn of scoped) {
          const logs = await functionsFor(ctx).service.getFunctionLogs(projectId, fn.id, { level: 'error', limit: 5 });
          for (const l of logs) {
            functionErrors.push({ function: fn.slug, message: l.message, at: l.timestamp });
          }
        }
      } catch {
        // Functions surface is best-effort; jobs + plans still diagnose.
      }
      const history = state.builder.getHistory(projectId);
      const planFailures = history
        .filter(h => h.result === 'error')
        .slice(0, 5)
        .map(h => ({ planId: h.resource, summary: h.detail, error: h.detail, at: h.createdAt }));
      const diagnosis = diagnose({
        jobs: scopedJobs,
        functionErrors: functionErrors.slice(0, 10),
        planFailures,
        note: parsed.note,
      });
      ctx.audit.record('ai.diagnosed', {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
      auditAi('ai.diagnose');
      return finish(200, ok({ diagnosis }, requestId));
    }

    // GET /ai/plans/:id — detail with preview + migration SQL.
    if (head === 'plans' && extra.length === 1 && extra[0] && req.method === 'GET') {
      await gateAi({ scope: 'projects.read', action: 'ai.plan.get' });
      const stored = state.builder.getPlan(projectId, extra[0]);
      return finish(200, ok({ plan: exposePlanDetail(stored) }, requestId));
    }

    // POST /ai/plans/:id/approve|reject — admin only.
    if (
      head === 'plans' &&
      extra.length === 2 &&
      extra[0] &&
      extra[1] === 'approve' &&
      req.method === 'POST'
    ) {
      if (agent) {
        await gateAi({ scope: 'projects.update', action: 'ai.plan.approve' });
      } else {
        requireAdmin(member.role);
      }
      const parsed = ApproveBody.parse((await readJson()) ?? {});
      const stored = state.builder.approvePlan(
        projectId,
        extra[0],
        level,
        (parsed.confirmations as DestructiveOp[]).filter(c =>
          [
            'DROP TABLE',
            'DROP COLUMN',
            'DELETE DATABASE',
            'DELETE BUCKET',
            'DELETE FUNCTION',
            'REMOVE AUTH PROVIDER',
          ].includes(c),
        ),
      );
      state.builder.recordAudit({
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
        action: 'AI_PLAN_APPROVED',
        resource: stored.id,
        result: 'ok',
        detail: `confirmations: ${stored.confirmations.join(', ') || 'none'}`,
      });
      ctx.audit.record('ai.plan.approved', {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
      auditAi('ai.plan.approved');
      return finish(200, ok({ plan: exposePlan(stored) }, requestId));
    }
    if (
      head === 'plans' &&
      extra.length === 2 &&
      extra[0] &&
      extra[1] === 'reject' &&
      req.method === 'POST'
    ) {
      if (agent) {
        await gateAi({ scope: 'projects.update', action: 'ai.plan.reject' });
      } else {
        requireAdmin(member.role);
      }
      const stored = state.builder.rejectPlan(projectId, extra[0]);
      state.builder.recordAudit({
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
        action: 'AI_PLAN_REJECTED',
        resource: stored.id,
        result: 'ok',
        detail: '',
      });
      ctx.audit.record('ai.plan.rejected', {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
      auditAi('ai.plan.rejected');
      return finish(200, ok({ plan: exposePlan(stored) }, requestId));
    }

    // POST /ai/plans/:id/apply — approved only, admin only, bounded execution.
    if (
      head === 'plans' &&
      extra.length === 2 &&
      extra[0] &&
      extra[1] === 'apply' &&
      req.method === 'POST'
    ) {
      const stored = state.builder.getPlan(projectId, extra[0]);
      if (agent) {
        // Applying executes migrations: approval-capable, plus a destructive
        // gate when the plan itself is destructive. Exactly one gate runs per
        // request (first missing scope) so a single approval covers the call.
        const svc = agentServiceFor(ctx);
        const needed = ['database.migrate'];
        if (stored.validation.destructive.length > 0) needed.push('database.destructive');
        const missing = needed.find(s => !svc.hasScope(agent, s));
        if (missing) {
          const decision = await gateDestructive(ctx, req, {
            agent,
            scope: missing,
            action: 'ai.plan.apply',
            organizationId: member.organizationId,
            projectId,
            method: 'POST',
            path: `/api/v1/projects/${projectId}/ai/plans/${stored.id}/apply`,
            body: {},
            resource: stored.id,
          });
          if (!decision.proceed) {
            sendApprovalRequired(res, baseHeaders, requestId, decision.approval);
            return true;
          }
        }
      } else {
        requireAdmin(member.role);
      }
      if (stored.status !== 'approved') {
        throw new ApiError('CONFLICT', 'Only approved plans can be applied', 409);
      }
      const outcome = await state.builder.applyPlan({
        projectId,
        planId: stored.id,
        adapters: buildAdapters(ctx, projectId, member.organizationId, member),
        level,
        userId: member.userId,
        organizationId: member.organizationId,
      });
      ctx.audit.record(
        outcome.rolledBack
          ? 'ai.plan.rolled_back'
          : outcome.ok
            ? 'ai.plan.applied'
            : 'ai.plan.failed',
        {
          projectId,
          organizationId: member.organizationId,
          userId: member.userId,
        },
      );
      auditAi(outcome.ok ? 'ai.plan.applied' : 'ai.plan.failed');
      if (outcome.ok) {
        void emitAutomationEvent(ctx, {
          type: 'ai.plan.applied',
          organizationId: member.organizationId,
          projectId,
          payload: { planId: stored.id, rolledBack: outcome.rolledBack },
        }).catch(() => undefined);
      }
      return finish(
        outcome.ok ? 200 : 500,
        ok(
          {
            ok: outcome.ok,
            rolledBack: outcome.rolledBack,
            error: outcome.error,
            steps: outcome.steps,
            plan: exposePlan(outcome.plan),
          },
          requestId,
        ),
      );
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}

type StoredPlanT = ReturnType<PlanStore['get']>;

function exposePlan(p: StoredPlanT): Record<string, unknown> {
  return {
    id: p.id,
    summary: p.plan.summary,
    status: p.status,
    validation: {
      ok: p.validation.ok,
      errors: p.validation.errors,
      warnings: p.validation.warnings,
      destructive: p.validation.destructive,
    },
    changes: p.changes,
    estimate: p.estimate,
    provider: p.provider,
    model: p.model,
    error: p.error,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function exposePlanDetail(p: StoredPlanT): Record<string, unknown> {
  const migrationSql =
    p.plan.database.tables.length > 0
      ? buildMigration(p.plan, p.id, p.projectId).statements.map(s => s.slice(0, 500))
      : [];
  return {
    ...exposePlan(p),
    plan: p.plan,
    migrationSql,
    steps: p.appliedSteps,
  };
}

