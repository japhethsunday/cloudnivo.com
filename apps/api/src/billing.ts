import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import {
  BillingError,
  billingOpenApiPaths,
  getPlan,
  listPlans,
  periodBounds,
  periodOf,
  providerFromConfig,
  type BillingProvider,
} from '@cloudnivo/billing';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';

/**
 * Billing + usage metering HTTP wiring (Phase 12).
 *
 * - Org-scoped reads (plan, subscription, usage, invoices, payments) require
 *   org membership; any role can read.
 * - Mutations (change/cancel plan, generate invoice, portal) require
 *   owner/admin — same rule as org invites.
 * - Webhooks are unauthenticated by session but HMAC-verified against
 *   BILLING_WEBHOOK_SECRET, idempotent via (provider, eventId), and never
 *   trust client claims for billing state.
 * - No payment credentials are ever accepted, stored, logged, or returned —
 *   only provider references (customer/subscription/payment ids).
 */

export function billingOpenApi(): Record<string, unknown> {
  return billingOpenApiPaths();
}

export function isBillingRoute(pathname: string, method: string): boolean {
  void method;
  if (pathname.startsWith('/api/v1/billing/webhooks/')) return true;
  return /^\/api\/v1\/organizations\/[^/]+\/billing\//.test(pathname);
}

function billingProviderFor(ctx: ApiContext): BillingProvider {
  const existing = (ctx as unknown as { __billingProvider?: BillingProvider }).__billingProvider;
  if (existing) return existing;
  const provider = providerFromConfig({
    provider: ctx.config.BILLING_PROVIDER,
    webhookSecret: ctx.config.BILLING_WEBHOOK_SECRET,
    dashboardUrl: ctx.config.APP_URL,
  });
  (ctx as unknown as { __billingProvider?: BillingProvider }).__billingProvider = provider;
  return provider;
}

function toBillingError(err: unknown, requestId: string): { status: number; body: unknown } {
  if (err instanceof BillingError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, requestId } },
    };
  }
  return toPublicError(err, requestId);
}

async function requireOrgMember(
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<{ userId: string; email: string; organizationId: string; role: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = /^\/api\/v1\/organizations\/([^/]+)\/billing\//.exec(url.pathname);
  const organizationId = m?.[1] ?? '';
  if (!organizationId) throw new ApiError('NOT_FOUND', 'Not found', 404);
  const memberships = await ctx.registry.membershipsFor(session.sub);
  const mine = memberships.find(x => x.organizationId === organizationId);
  if (!mine) throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
  return { userId: session.sub, email: session.email, organizationId, role: mine.role };
}

function requireOwnerOrAdmin(role: string): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Billing administration requires owner or admin', 403);
  }
}

async function billingLimit(ctx: ApiContext, req: IncomingMessage, scope: string): Promise<void> {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const rl = await checkRateLimit(ctx.rateLimitStore, `billing:${scope}:${ip}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.BILLING_RATE_MAX,
    keyPrefix: 'billing',
  });
  if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Billing rate limit exceeded', 429);
}

const SubscriptionChangeBody = z.object({
  action: z.enum(['change', 'cancel']),
  planId: z.enum(['free', 'pro', 'business', 'enterprise']).optional(),
  trialDays: z.coerce.number().int().min(0).max(30).optional(),
});

const InvoiceGenerateBody = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid period (expected YYYY-MM)')
    .optional(),
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

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length > 262_144) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
  return text;
}

export async function handleBillingRoutes(
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
    logger.info('billing.request', {
      route: pathname,
      method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toBillingError(err, requestId);
    logger.info('billing.request', {
      route: pathname,
      method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };

  try {
    // ── Webhooks (no session; HMAC + idempotency) ──
    const webhookMatch = /^\/api\/v1\/billing\/webhooks\/([^/]+)\/?$/.exec(pathname);
    if (webhookMatch?.[1]) {
      if (method !== 'POST')
        return finish(405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
        });
      const providerName = webhookMatch[1].slice(0, 40);
      await billingLimit(ctx, req, `webhook:${providerName}`);
      const provider = billingProviderFor(ctx);
      const rawBody = await readRawBody(req);
      if (!rawBody) throw new ApiError('VALIDATION_ERROR', 'Empty webhook body', 400);
      const signature =
        (Array.isArray(req.headers['x-billing-signature'])
          ? req.headers['x-billing-signature'][0]
          : req.headers['x-billing-signature']) ??
        (Array.isArray(req.headers['stripe-signature'])
          ? req.headers['stripe-signature'][0]
          : req.headers['stripe-signature']) ??
        '';
      try {
        provider.verifyWebhook(rawBody, typeof signature === 'string' ? signature : '');
      } catch (err) {
        logger.warn('billing.webhook.bad_signature', { provider: providerName });
        return finish(401, {
          error: {
            code: 'INVALID_SIGNATURE',
            message: err instanceof Error ? err.message.slice(0, 120) : 'Invalid webhook signature',
            requestId,
          },
        });
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new ApiError('MALFORMED_JSON', 'Webhook body is not valid JSON', 400);
      }
      const eventId = String(parsed['eventId'] ?? parsed['id'] ?? '').slice(0, 200);
      const type = String(parsed['type'] ?? '').slice(0, 100);
      if (!eventId || !type)
        throw new ApiError('VALIDATION_ERROR', 'Webhook event requires id and type', 400);
      const organizationId =
        typeof parsed['organizationId'] === 'string' && parsed['organizationId'].length >= 1
          ? String(parsed['organizationId']).slice(0, 64)
          : null;
      const result = await ctx.billing.applyProviderEvent({
        provider: providerName,
        eventId,
        type,
        organizationId,
        payload: parsed,
      });
      await ctx.registry
        .recordAudit('billing.webhook.processed', {
          organizationId: organizationId ?? undefined,
        })
        .catch(() => undefined);
      ctx.audit.record('billing.webhook.processed', {
        organizationId: organizationId ?? undefined,
      });
      return finish(
        200,
        ok({ received: true, applied: result.applied, detail: result.detail }, requestId),
      );
    }

    // ── Org-scoped billing ──
    const orgMatch = /^\/api\/v1\/organizations\/([^/]+)\/billing\/([^/]+)\/?$/.exec(pathname);
    if (!orgMatch?.[1] || !orgMatch[2]) return false;
    const tail = orgMatch[2];
    const member = await requireOrgMember(ctx, req);
    await billingLimit(ctx, req, `org:${member.organizationId}`);

    // Gauge reader for downgrade protection: live member/project counts.
    const gaugeReader = async (metric: string): Promise<number> => {
      if (metric === 'team_members') {
        return (await ctx.registry.listOrganizationMembers(member.organizationId)).length;
      }
      if (metric === 'projects') {
        const projects = await ctx.registry.listProjects(member.userId);
        return projects.filter(p => p.organizationId === member.organizationId).length;
      }
      return 0;
    };

    if (tail === 'plan' && method === 'GET') {
      const subscription = await ctx.billing.getSubscription(member.organizationId);
      const effective = await ctx.billing.effectiveLimits(member.organizationId);
      const plan = getPlan(effective.planId);
      return finish(
        200,
        ok(
          {
            subscription,
            planId: effective.planId,
            plan: {
              id: plan.id,
              name: plan.name,
              priceCents: plan.priceCents,
              currency: plan.currency,
            },
            limits: effective.limits,
            subscriptionStatus: effective.subscriptionStatus,
          },
          requestId,
        ),
      );
    }

    if (tail === 'plans' && method === 'GET') {
      return finish(200, ok({ plans: listPlans() }, requestId));
    }

    if (tail === 'subscription' && method === 'GET') {
      const subscription = await ctx.billing.getSubscription(member.organizationId);
      return finish(200, ok({ subscription }, requestId));
    }

    if (tail === 'subscription' && method === 'POST') {
      requireOwnerOrAdmin(member.role);
      const parsed = parseBody(SubscriptionChangeBody, await readJsonBody(req));
      const provider = billingProviderFor(ctx);
      if (parsed.action === 'cancel') {
        const current = await ctx.billing.getSubscription(member.organizationId);
        await provider.cancelSubscription(current.providerSubscriptionId).catch(err => {
          logger.warn('billing.provider.cancel_failed', { error: String(err).slice(0, 120) });
        });
        const subscription = await ctx.billing.cancelSubscription(member.organizationId);
        await ctx.registry.recordAudit('billing.subscription.canceled', {
          organizationId: member.organizationId,
          userId: member.userId,
        });
        ctx.audit.record('billing.subscription.canceled', {
          organizationId: member.organizationId,
          userId: member.userId,
        });
        return finish(200, ok({ subscription }, requestId));
      }
      if (!parsed.planId)
        throw new ApiError('VALIDATION_ERROR', 'planId is required to change plan', 400);
      const previous = await ctx.billing.getSubscription(member.organizationId);
      await provider
        .updateSubscription(previous.providerSubscriptionId, parsed.planId)
        .catch(err => {
          logger.warn('billing.provider.update_failed', { error: String(err).slice(0, 120) });
        });
      try {
        const subscription = await ctx.billing.changePlan(member.organizationId, parsed.planId, {
          trialDays: parsed.trialDays,
          provider: provider.name,
          gaugeReader,
        });
        await ctx.registry.recordAudit('billing.plan.changed', {
          organizationId: member.organizationId,
          userId: member.userId,
        });
        ctx.audit.record('billing.plan.changed', {
          organizationId: member.organizationId,
          userId: member.userId,
        });
        return finish(200, ok({ subscription }, requestId));
      } catch (err) {
        if (err instanceof BillingError && err.code === 'DOWNGRADE_BLOCKED') {
          return finish(409, { error: { code: err.code, message: err.message, requestId } });
        }
        throw err;
      }
    }

    if (tail === 'usage' && method === 'GET') {
      const periodParam = url.searchParams.get('period');
      const period = periodParam ?? periodOf(new Date());
      periodBounds(period);
      const rows = await ctx.billing.aggregate(member.organizationId, period);
      const effective = await ctx.billing.effectiveLimits(member.organizationId);
      const creditBalanceCents = await ctx.billing.creditBalanceCents(member.organizationId);
      const byKey = new Map<
        string,
        {
          service: string;
          metric: string;
          total: number;
          byProject: { projectId: string; total: number }[];
        }
      >();
      for (const r of rows) {
        const key = `${r.service}\n${r.metric}`;
        let slice = byKey.get(key);
        if (!slice) {
          slice = { service: r.service, metric: r.metric, total: 0, byProject: [] };
          byKey.set(key, slice);
        }
        slice.total += r.total;
        if (r.projectId) slice.byProject.push({ projectId: r.projectId, total: r.total });
      }
      return finish(
        200,
        ok(
          {
            organizationId: member.organizationId,
            period,
            planId: effective.planId,
            subscriptionStatus: effective.subscriptionStatus,
            limits: effective.limits,
            slices: [...byKey.values()],
            creditBalanceCents,
          },
          requestId,
        ),
      );
    }

    if (tail === 'invoices' && method === 'GET') {
      const invoices = await ctx.billing.listInvoices(member.organizationId);
      return finish(200, ok({ invoices }, requestId));
    }

    if (tail === 'invoices' && method === 'POST') {
      requireOwnerOrAdmin(member.role);
      const parsed = parseBody(InvoiceGenerateBody, (await readJsonBody(req)) ?? {});
      const invoice = await ctx.billing.generateInvoice(member.organizationId, parsed.period);
      const balanceCents = await ctx.billing.invoiceBalanceCents(member.organizationId, invoice.id);
      await ctx.registry.recordAudit('billing.invoice.generated', {
        organizationId: member.organizationId,
        userId: member.userId,
      });
      ctx.audit.record('billing.invoice.generated', {
        organizationId: member.organizationId,
        userId: member.userId,
      });
      return finish(201, ok({ invoice, balanceCents }, requestId));
    }

    if (tail === 'payments' && method === 'GET') {
      const payments = await ctx.billing.listPayments(member.organizationId);
      return finish(200, ok({ payments }, requestId));
    }

    if (tail === 'portal' && method === 'POST') {
      requireOwnerOrAdmin(member.role);
      const provider = billingProviderFor(ctx);
      const portal = await provider.createPortalSession(member.organizationId);
      return finish(200, ok({ portal }, requestId));
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
