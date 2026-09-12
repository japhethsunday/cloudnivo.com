import type { IncomingMessage, ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ApiError, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import type { DbAuditEvent } from '@cloudnivo/database';
import {
  AutomationError,
  AutomationService,
  MemoryAutomationStore,
  automationOpenApiPaths,
  exposeWebhook,
  type Delivery,
  type ProjectEvent,
  type Queue,
  type Schedule,
  type Webhook,
} from '@cloudnivo/automation';
import type { Logger } from '@cloudnivo/logging';
import type { AgentToken } from '@cloudnivo/agents';
import type { ApiContext } from './v1.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';
import { agentFromRequest, auditAgent, requireAgentScope, verifyAgentAccess } from './agents.js';
import { functionsFor } from './functions.js';

/**
 * Automation HTTP wiring (queues, schedules, webhooks).
 *
 * - Management requires a platform session with project membership; agents
 *   additionally need `automation.read` (reads) or `automation.write`.
 * - Webhook deliveries attempt inline on trigger; retries and schedule
 *   firing run in the worker (`drainAutomationOnce`). Secrets are hash-only.
 */

export interface AutomationState {
  service: AutomationService;
}

export function automationFor(ctx: ApiContext): AutomationState {
  const existing = (ctx as unknown as { __automation?: AutomationState }).__automation;
  if (existing) return existing;
  const state = { service: new AutomationService(new MemoryAutomationStore()) };
  (ctx as unknown as { __automation?: AutomationState }).__automation = state;
  return state;
}

export function automationOpenApi(): Record<string, unknown> {
  return automationOpenApiPaths();
}

export function isAutomationRoute(rest: string[], method: string): boolean {
  void method;
  if (rest.length < 2 || !rest[0]) return false;
  return rest[1] === 'queues' || rest[1] === 'schedules' || rest[1] === 'webhooks';
}

type Member = {
  userId: string;
  role: string;
  projectId: string;
  organizationId: string;
  agent?: AgentToken;
};

async function requireMember(ctx: ApiContext, req: IncomingMessage, projectId: string): Promise<Member> {
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const agent = await verifyAgentAccess(ctx, req, maybeAgent, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'automation.access',
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
    (await ctx.registry.membershipsFor(session.sub)).find(m => m.organizationId === owned.organizationId)?.role ??
    'viewer';
  return { userId: session.sub, role, projectId: owned.id, organizationId: owned.organizationId };
}

async function gateAuto(
  ctx: ApiContext,
  req: IncomingMessage,
  member: Member,
  opts: { scope: 'automation.read' | 'automation.write'; action: string; resource?: string },
): Promise<void> {
  if (!member.agent) return;
  await requireAgentScope(ctx, req, member.agent, {
    scope: opts.scope,
    organizationId: member.organizationId,
    projectId: member.projectId,
    action: opts.action,
    resource: opts.resource,
  });
}

function requireManager(role: string): void {
  if (role !== 'owner' && role !== 'admin' && role !== 'agent') {
    throw new ApiError('FORBIDDEN', 'Automation management requires admin', 403);
  }
}

// ── HTTP delivery ─────────────────────────────────────────

/**
 * Resolve-time SSRF guard: DNS-rebinding (or a direct private hostname) must
 * not steer a webhook delivery at internal infrastructure. Complements the
 * literal-IP validation in the automation package. Fail-closed on DNS errors.
 */
function isPrivateResolvedIp(addr: string): boolean {
  if (isIP(addr) !== 4 && isIP(addr) !== 6) return true;
  if (addr.includes(':')) {
    const h = addr.toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) {
      const v4 = h.slice(7);
      return v4 === '127.0.0.1' || isPrivateResolvedIp(v4);
    }
    return /^(2001:db8|ff00)/i.test(h);
  }
  const b = addr.split('.').map(Number);
  const [a, c] = b;
  return (
    a === 127 || a === 0 || a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) ||
    (a === 169 && c === 254) || a >= 224
  );
}

async function deliverHttp(
  url: string,
  payloadBytes: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number | null; error: string | null; latencyMs: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // Resolve-then-deliver: block private/metadata targets even if DNS changed
    // after validation (rebinding). Redirects are never followed (manual).
    const host = new URL(url).hostname;
    const resolved = await lookup(host).catch(() => null);
    if (!resolved || isPrivateResolvedIp(resolved.address)) {
      return { ok: false, status: null, error: 'webhook target resolves to a blocked address', latencyMs: Date.now() - started };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payloadBytes,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    await res.arrayBuffer().catch(() => null);
    return { ok: true, status: res.status, error: null, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message.slice(0, 200) : 'delivery failed',
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan out one project event: create deliveries, then attempt each inline so
 * the common case needs no worker. Failures stay pending for retry.
 */
export async function emitAutomationEvent(ctx: ApiContext, event: ProjectEvent): Promise<Delivery[]> {
  const { service } = automationFor(ctx);
  const deliveries = await service.emit(event);
  for (const d of deliveries) {
    try {
      const webhook = await service.storeRef.getWebhook(d.webhookId);
      if (!webhook || !webhook.enabled) continue;
      await service.attemptDelivery(d, webhook, deliverHttp);
    } catch (err) {
      ctx.logger.warn('automation.emit_failed', {
        delivery: d.id,
        error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
    }
  }
  return deliveries;
}

/** Invoke a function as the schedule system (role recorded, never a user). */
export async function invokeScheduledFunction(
  ctx: ApiContext,
  projectId: string,
  functionSlug: string,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const state = functionsFor(ctx);
    const outcome = await state.service.invokeFunction({
      projectId,
      idOrSlug: functionSlug,
      request: { method: 'POST', path: '/', headers: {}, query: {}, body: payload },
      auth: { userId: null, email: null, role: 'system', projectId, callerKind: 'public' },
      requestId,
      rateLimit: ctx.rateLimitStore,
      rateMax: ctx.config.FUNCTION_INVOKE_RATE_MAX,
    });
    ctx.audit.record('automation.schedule_invoked', { projectId });
    return { ok: outcome.result.status >= 200 && outcome.result.status < 300, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'invoke failed' };
  }
}

/** Worker drain: retry due deliveries + fire due schedules (bounded). */
export async function drainAutomationOnce(
  ctx: ApiContext,
  requestId: string,
): Promise<{ deliveries: { retried: number; succeeded: number; failed: number }; schedules: { fired: number; failed: number } }> {
  const { service } = automationFor(ctx);
  const deliveries = await service.retryDueDeliveries(async (d, w) => service.attemptDelivery(d, w, deliverHttp));
  const schedules = await service.fireDueSchedules(async (projectId, slug, payload) =>
    invokeScheduledFunction(ctx, projectId, slug, payload, requestId),
  );
  return { deliveries, schedules };
}

// ── Validation schemas ────────────────────────────────────

const QueueBody = z.object({
  name: z.string().min(1).max(64),
  maxDeliveries: z.number().int().min(1).max(25).optional(),
});

const PublishBody = z.object({
  body: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const ConsumeBody = z.object({
  limit: z.number().int().min(1).max(25).default(1),
  leaseMs: z.number().int().min(1000).max(3_600_000).default(30_000),
});

const NackBody = z.object({ requeue: z.boolean().default(true) });

const PurgeBody = z.object({ statuses: z.array(z.enum(['acked', 'dead'])).min(1).max(2) });

const ScheduleBody = z.object({
  name: z.string().min(1).max(64),
  functionSlug: z.string().min(1).max(100),
  cron: z.string().min(9).max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const SchedulePatch = z.object({
  name: z.string().min(1).max(64).optional(),
  cron: z.string().min(9).max(100).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const WebhookBody = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url().max(2000),
  eventTypes: z.array(z.string().min(1).max(40)).min(1).max(10),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const WebhookPatch = z.object({
  name: z.string().min(1).max(64).optional(),
  url: z.string().url().max(2000).optional(),
  eventTypes: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

function toAutomationError(err: unknown, requestId: string): { status: number; body: unknown } {
  if (err instanceof AutomationError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, requestId } } };
  }
  const { status, body } = toPublicError(err, requestId);
  return { status, body };
}

export async function handleAutomationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
  readBody: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, plane, ...tail] = rest;
  if (!projectId || !plane) return false;
  const start = Date.now();
  const finish = (status: number, body: unknown): true => {
    logger.info('automation.request', {
      project: projectId,
      route: [plane, ...tail].join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toAutomationError(err, requestId);
    logger.info('automation.request', {
      project: projectId,
      route: [plane, ...tail].join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };

  try {
    const member = await requireMember(ctx, req, projectId);
    const { service } = automationFor(ctx);
    const method = req.method ?? 'GET';

    async function scopedQueue(queueId: string): Promise<Queue> {
      const q = await service.storeRef.getQueue(queueId);
      if (!q || q.projectId !== projectId) throw new ApiError('NOT_FOUND', 'Queue not found', 404);
      return q;
    }
    async function scopedSchedule(scheduleId: string): Promise<Schedule> {
      const s = await service.storeRef.getSchedule(scheduleId);
      if (!s || s.projectId !== projectId) throw new ApiError('NOT_FOUND', 'Schedule not found', 404);
      return s;
    }
    async function scopedWebhook(webhookId: string): Promise<Webhook> {
      const w = await service.storeRef.getWebhook(webhookId);
      if (!w || w.projectId !== projectId) throw new ApiError('NOT_FOUND', 'Webhook not found', 404);
      return w;
    }
    function audit(action: string, resource?: string): void {
      ctx.audit.record(`automation.${action}` as DbAuditEvent, {
        projectId,
        organizationId: member.organizationId,
        userId: member.userId,
      });
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

    // ── Queues ──
    if (plane === 'queues') {
      const [queueId, sub, messageId, verb] = tail;
      if (queueId === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.queues.list' });
        const queues = await service.storeRef.listQueues(projectId);
        const withDepth = await Promise.all(
          queues.map(async q => ({ ...q, depth: await service.storeRef.queueDepth(q.id) })),
        );
        return finish(200, ok({ queues: withDepth }, requestId));
      }
      if (queueId === undefined && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.queue.create' });
        const parsed = parseBody(QueueBody, await readBody());
        const queue = await service.createQueue(member.organizationId, projectId, parsed);
        audit('queue.created', queue.name);
        return finish(201, ok({ queue }, requestId));
      }
      if (!queueId) return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
      const queue = await scopedQueue(queueId);
      if (sub === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.queue.get' });
        return finish(200, ok({ queue, depth: await service.storeRef.queueDepth(queue.id) }, requestId));
      }
      if (sub === undefined && method === 'DELETE') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.queue.delete', resource: queue.name });
        await service.storeRef.deleteQueue(queue.id);
        audit('queue.deleted', queue.name);
        return finish(200, ok({ deleted: true }, requestId));
      }
      if (sub === 'purge' && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.queue.purge', resource: queue.name });
        const parsed = parseBody(PurgeBody, await readBody());
        return finish(200, ok(await service.purge(queue, parsed.statuses), requestId));
      }
      if (sub === 'messages' && messageId === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.messages.list' });
        return finish(200, ok({ messages: await service.storeRef.listMessages(queue.id, null, 100) }, requestId));
      }
      if (sub === 'messages' && messageId === undefined && method === 'POST') {
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.message.publish', resource: queue.name });
        const parsed = parseBody(PublishBody, await readBody());
        const { message, duplicate } = await service.publish(queue, parsed);
        audit('message.published', queue.name);
        return finish(duplicate ? 200 : 201, ok({ message, duplicate }, requestId));
      }
      if (sub === 'consume' && method === 'POST') {
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.messages.consume', resource: queue.name });
        const parsed = parseBody(ConsumeBody, await readBody());
        return finish(200, ok({ messages: await service.consume(queue, parsed.limit ?? 1, parsed.leaseMs ?? 30_000) }, requestId));
      }
      if (sub === 'messages' && messageId && verb === 'ack' && method === 'POST') {
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.message.ack' });
        return finish(200, ok({ message: await service.ack(queue, messageId) }, requestId));
      }
      if (sub === 'messages' && messageId && verb === 'nack' && method === 'POST') {
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.message.nack' });
        const parsed = parseBody(NackBody, await readBody());
        return finish(200, ok({ message: await service.nack(queue, messageId, parsed.requeue ?? true) }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    // ── Schedules ──
    if (plane === 'schedules') {
      const [scheduleId, verb] = tail;
      if (scheduleId === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.schedules.list' });
        return finish(200, ok({ schedules: await service.storeRef.listSchedules(projectId) }, requestId));
      }
      if (scheduleId === undefined && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.schedule.create' });
        const parsed = parseBody(ScheduleBody, await readBody());
        const schedule = await service.createSchedule(member.organizationId, projectId, parsed);
        audit('schedule.created', schedule.name);
        return finish(201, ok({ schedule }, requestId));
      }
      if (!scheduleId) return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
      const schedule = await scopedSchedule(scheduleId);
      if (verb === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.schedule.get' });
        return finish(200, ok({ schedule }, requestId));
      }
      if (verb === undefined && method === 'PATCH') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.schedule.update', resource: schedule.name });
        const parsed = parseBody(SchedulePatch, await readBody());
        return finish(200, ok({ schedule: await service.updateSchedule(schedule, parsed) }, requestId));
      }
      if (verb === undefined && method === 'DELETE') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.schedule.delete', resource: schedule.name });
        await service.storeRef.deleteSchedule(schedule.id);
        audit('schedule.deleted', schedule.name);
        return finish(200, ok({ deleted: true }, requestId));
      }
      if (verb === 'trigger' && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.schedule.trigger', resource: schedule.name });
        const result = await invokeScheduledFunction(ctx, projectId, schedule.functionSlug, schedule.payload, requestId);
        await service.storeRef.markScheduleRun(schedule.id, new Date().toISOString(), result.ok ? 'succeeded' : 'failed', schedule.nextRunAt);
        audit('schedule.triggered', schedule.name);
        return finish(200, ok({ ok: result.ok, error: result.error }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    // ── Webhooks ──
    if (plane === 'webhooks') {
      const [webhookId, sub, deliveryId, verb] = tail;
      if (webhookId === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.webhooks.list' });
        const webhooks = await service.storeRef.listWebhooks(projectId);
        return finish(200, ok({ webhooks: webhooks.map(exposeWebhook) }, requestId));
      }
      if (webhookId === undefined && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.webhook.create' });
        const parsed = parseBody(WebhookBody, await readBody());
        const { webhook, secret } = await service.createWebhook(member.organizationId, projectId, parsed);
        audit('webhook.created', webhook.name);
        return finish(201, ok({ webhook, secret }, requestId));
      }
      if (!webhookId) return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
      const webhook = await scopedWebhook(webhookId);
      if (sub === undefined && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.webhook.get' });
        return finish(200, ok({ webhook: exposeWebhook(webhook) }, requestId));
      }
      if (sub === undefined && method === 'PATCH') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.webhook.update', resource: webhook.name });
        const parsed = parseBody(WebhookPatch, await readBody());
        return finish(200, ok({ webhook: await service.updateWebhook(webhook, parsed) }, requestId));
      }
      if (sub === undefined && method === 'DELETE') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.webhook.delete', resource: webhook.name });
        await service.storeRef.deleteWebhook(webhook.id);
        audit('webhook.deleted', webhook.name);
        return finish(200, ok({ deleted: true }, requestId));
      }
      if (sub === 'rotate' && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.webhook.rotate', resource: webhook.name });
        const { webhook: rotated, secret } = await service.rotateSecret(webhook);
        audit('webhook.rotated', webhook.name);
        return finish(200, ok({ webhook: rotated, secret }, requestId));
      }
      if (sub === 'test' && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.webhook.test', resource: webhook.name });
        const pending = await service.storeRef.createDelivery({
          webhookId: webhook.id,
          organizationId: webhook.organizationId,
          projectId: webhook.projectId,
          eventType: 'job.completed',
          payload: { test: true, webhook: webhook.name },
          nextAttemptAt: new Date().toISOString(),
        });
        const done = await service.attemptDelivery(pending, webhook, deliverHttp);
        return finish(200, ok({ delivery: done }, requestId));
      }
      if (sub === 'deliveries' && !deliveryId && method === 'GET') {
        await gateAuto(ctx, req, member, { scope: 'automation.read', action: 'automation.deliveries.list' });
        return finish(200, ok({ deliveries: await service.storeRef.listDeliveries(webhook.id, null, 100) }, requestId));
      }
      if (sub === 'deliveries' && deliveryId && verb === 'replay' && method === 'POST') {
        requireManager(member.role);
        await gateAuto(ctx, req, member, { scope: 'automation.write', action: 'automation.delivery.replay' });
        const original = await service.storeRef.getDelivery(deliveryId);
        if (!original || original.webhookId !== webhook.id) {
          throw new ApiError('NOT_FOUND', 'Delivery not found', 404);
        }
        const pending = await service.storeRef.createDelivery({
          webhookId: webhook.id,
          organizationId: webhook.organizationId,
          projectId: webhook.projectId,
          eventType: original.eventType,
          payload: original.payload,
          nextAttemptAt: new Date().toISOString(),
        });
        const done = await service.attemptDelivery(pending, webhook, deliverHttp);
        audit('delivery.replayed', webhook.name);
        return finish(200, ok({ delivery: done }, requestId));
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
