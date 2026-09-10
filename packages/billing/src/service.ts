import { BillingError, GAUGE_METRICS, periodBounds, periodOf } from './types.js';
import type {
  Invoice,
  LimitCheck,
  Payment,
  PlanId,
  Subscription,
  UsageMetric,
  UsageService,
  UsageSlice,
  UsageSummary,
  WarningLevel,
} from './types.js';
import { getPlan, limitKeyFor, toLimitUnits } from './plans.js';
import type { BillingStore } from './store.js';

/**
 * Central billing + usage service. Every quota decision in CloudNivo flows
 * through here (`getLimits` / `checkLimit`); services never hardcode plan
 * numbers. Usage is recorded at API-route choke points (never estimated in
 * the frontend); gauges are read live by callers, counters accumulate here.
 */

export interface QuotaCheck {
  allowed: boolean;
  check: LimitCheck | null;
  /** Newly crossed warning thresholds (for notifications). */
  crossed: WarningLevel[];
}

export interface Notifier {
  /** Best-effort warning delivery. Must never throw. */
  notifyQuotaWarning(input: {
    organizationId: string;
    resource: string;
    percent: number;
    threshold: WarningLevel;
    period: string;
  }): Promise<void>;
}

export const WARNING_LEVELS: WarningLevel[] = [50, 75, 90, 100];

/** Keep only id/status/type/org shape from provider payloads. Never card data. */
function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'id',
    'type',
    'status',
    'amountCents',
    'currency',
    'invoiceId',
    'subscriptionId',
    'paymentId',
  ]) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
  }
  return out;
}

export interface EffectiveLimits {
  planId: PlanId;
  subscriptionStatus: Subscription['status'];
  limits: ReturnType<typeof getPlan>['limits'];
}

export class BillingService {
  constructor(
    private readonly store: BillingStore,
    private readonly notifier: Notifier = { notifyQuotaWarning: async () => undefined },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Subscriptions ───────────────────────────────────────────────

  /** Lazily ensures a subscription row (new orgs start on free/active). */
  async getSubscription(organizationId: string): Promise<Subscription> {
    const existing = await this.store.getSubscription(organizationId);
    if (existing) return this.reconcile(existing);
    const start = this.now();
    return this.store.upsertSubscription({
      organizationId,
      planId: 'free',
      status: 'active',
      trialEndsAt: null,
      currentPeriodStart: start.toISOString(),
      currentPeriodEnd: new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
      ).toISOString(),
      renewsAt: null,
    });
  }

  /**
   * Reconcile time-driven transitions without a cron: expired trials fall
   * back to free, ended canceled periods expire. Pure + idempotent; the
   * worker calls the same path on a schedule.
   */
  async reconcile(sub: Subscription): Promise<Subscription> {
    const now = this.now();
    if (sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt) <= now) {
      return this.store.upsertSubscription({
        organizationId: sub.organizationId,
        planId: 'free',
        status: 'expired',
        trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        renewsAt: null,
        provider: sub.provider,
        providerCustomerId: sub.providerCustomerId,
        providerSubscriptionId: sub.providerSubscriptionId,
      });
    }
    if (
      sub.status === 'canceled' &&
      sub.currentPeriodEnd &&
      new Date(sub.currentPeriodEnd) <= now
    ) {
      return this.store.upsertSubscription({
        organizationId: sub.organizationId,
        planId: 'free',
        status: 'expired',
        trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        renewsAt: null,
        provider: sub.provider,
        providerCustomerId: sub.providerCustomerId,
        providerSubscriptionId: sub.providerSubscriptionId,
      });
    }
    return sub;
  }

  /**
   * Change plan (upgrade/downgrade architecture). Takes effect immediately
   * with a fresh period; the previous state stays in audit history.
   * Downgrades that would breach the new plan's gauge limits are rejected
   * with the offending resources listed — never silently applied.
   */
  async changePlan(
    organizationId: string,
    planId: PlanId,
    opts: {
      trialDays?: number;
      provider?: string;
      providerSubscriptionId?: string | null;
      gaugeReader?: (metric: UsageMetric) => Promise<number>;
    } = {},
  ): Promise<Subscription> {
    const plan = getPlan(planId);
    const current = await this.getSubscription(organizationId);
    if (opts.gaugeReader) {
      const breaches: string[] = [];
      const gauges: UsageMetric[] = [
        'projects',
        'team_members',
        'storage_bytes',
        'storage_files',
        'api_keys',
      ];
      for (const metric of gauges) {
        const key = limitKeyFor('api' as UsageService, metric);
        if (!key) continue;
        const limit = plan.limits[key];
        if (limit < 0) continue;
        const used = await opts.gaugeReader(metric);
        if (toLimitUnits(metric, used) > limit) breaches.push(`${metric} (${used} > ${limit})`);
      }
      if (breaches.length > 0) {
        throw new BillingError(
          'DOWNGRADE_BLOCKED',
          `Downgrade would breach limits: ${breaches.join(', ')}`,
          409,
        );
      }
    }
    const now = this.now();
    const trialEndsAt =
      opts.trialDays && opts.trialDays > 0 && plan.trialDays > 0
        ? new Date(
            now.getTime() + Math.min(opts.trialDays, plan.trialDays) * 86_400_000,
          ).toISOString()
        : null;
    return this.store.upsertSubscription({
      organizationId,
      planId,
      status: trialEndsAt ? 'trialing' : 'active',
      trialEndsAt,
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      ).toISOString(),
      renewsAt: plan.priceCents
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
        : null,
      provider: opts.provider ?? current.provider,
      providerCustomerId: current.providerCustomerId,
      providerSubscriptionId: opts.providerSubscriptionId ?? current.providerSubscriptionId,
    });
  }

  async cancelSubscription(organizationId: string): Promise<Subscription> {
    const current = await this.getSubscription(organizationId);
    return this.store.upsertSubscription({
      organizationId,
      planId: current.planId,
      status: 'canceled',
      trialEndsAt: current.trialEndsAt,
      currentPeriodStart: current.currentPeriodStart,
      currentPeriodEnd: current.currentPeriodEnd,
      renewsAt: null,
      provider: current.provider,
      providerCustomerId: current.providerCustomerId,
      providerSubscriptionId: current.providerSubscriptionId,
    });
  }

  /** Effective plan: trialing serves its plan; canceled serves until period end; expired/past_due fall back to free. */
  async effectiveLimits(organizationId: string): Promise<EffectiveLimits> {
    const sub = await this.getSubscription(organizationId);
    if (sub.status === 'expired' || sub.status === 'past_due') {
      return { planId: 'free', subscriptionStatus: sub.status, limits: getPlan('free').limits };
    }
    return {
      planId: sub.planId,
      subscriptionStatus: sub.status,
      limits: getPlan(sub.planId).limits,
    };
  }

  // ── Metering ────────────────────────────────────────────────────

  async record(
    organizationId: string,
    projectId: string,
    service: UsageService,
    metric: UsageMetric,
    value: number,
    at?: Date,
  ): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new BillingError(
        'VALIDATION_ERROR',
        'Usage value must be a non-negative safe integer',
        400,
      );
    }
    const instant = at ?? this.now();
    await this.store.recordUsage({
      organizationId,
      projectId,
      service,
      metric,
      value,
      period: periodOf(instant),
      at: instant.toISOString(),
    });
    // Warnings are evaluated on counter growth (gauges evaluated on read).
    if (!GAUGE_METRICS.has(metric)) {
      await this.evaluateWarnings(organizationId, service, metric, periodOf(instant)).catch(
        () => undefined,
      );
    }
  }

  async increment(
    organizationId: string,
    projectId: string,
    service: UsageService,
    metric: UsageMetric,
    amount = 1,
  ): Promise<void> {
    await this.record(organizationId, projectId, service, metric, amount);
  }

  async aggregate(
    organizationId: string,
    period: string,
  ): Promise<{ service: UsageService; metric: UsageMetric; projectId: string; total: number }[]> {
    periodBounds(period);
    return this.store.aggregateUsage(organizationId, period);
  }

  async getCurrentUsage(organizationId: string, at?: Date): Promise<UsageSummary> {
    const period = periodOf(at ?? this.now());
    const { planId } = await this.effectiveLimits(organizationId);
    const rows = await this.aggregate(organizationId, period);
    const byKey = new Map<
      string,
      {
        service: UsageService;
        metric: UsageMetric;
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
    return {
      organizationId,
      period,
      planId,
      slices: [...byKey.values()].map(s => ({
        ...s,
        byProject: s.byProject.sort((a, b) => b.total - a.total),
      })),
    };
  }

  async getHistoricalUsage(organizationId: string, periods: string[]): Promise<UsageSummary[]> {
    if (periods.length > 24)
      throw new BillingError('VALIDATION_ERROR', 'At most 24 periods per request', 400);
    const out: UsageSummary[] = [];
    for (const period of periods.slice(0, 24)) {
      periodBounds(period);
      const { planId } = await this.effectiveLimits(organizationId);
      const rows = await this.aggregate(organizationId, period);
      const byKey = new Map<string, UsageSlice>();
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
      out.push({ organizationId, period, planId, slices: [...byKey.values()] });
    }
    return out;
  }

  // ── Quotas ──────────────────────────────────────────────────────

  getLimit(planId: PlanId, service: UsageService, metric: UsageMetric): number | null {
    const key = limitKeyFor(service, metric);
    if (!key) return null;
    return getPlan(planId).limits[key];
  }

  /**
   * Central quota gate. `used` is the current total (counter aggregate or
   * live gauge reading) in RAW units; conversion to plan units happens here.
   * Hard policy: deny past the limit. Soft policy: always allow, report.
   * Warnings fire at 50/75/90/100 exactly once per period.
   */
  async checkLimit(
    organizationId: string,
    service: UsageService,
    metric: UsageMetric,
    used: number,
    requested = 1,
    policy: 'hard' | 'soft' = 'hard',
    at?: Date,
  ): Promise<QuotaCheck> {
    const instant = at ?? this.now();
    const { planId } = await this.effectiveLimits(organizationId);
    const limit = this.getLimit(planId, service, metric);
    if (limit === null || limit < 0) {
      return { allowed: true, check: null, crossed: [] };
    }
    const usedUnits = toLimitUnits(metric, used);
    const requestedUnits = toLimitUnits(metric, requested);
    const percent =
      limit === 0
        ? usedUnits > 0 || requestedUnits > 0
          ? 100
          : 0
        : Math.min(100, Math.floor(((usedUnits + requestedUnits) / limit) * 100));
    const remaining = Math.max(0, limit - usedUnits - requestedUnits);
    const check = {
      resource: `${service}.${metric}`,
      limit,
      used: usedUnits,
      remaining,
      percent,
      policy,
      allowed: policy === 'soft' || usedUnits + requestedUnits <= limit,
    };
    const crossed = await this.fireWarnings(
      organizationId,
      check.resource,
      percent,
      periodOf(instant),
    );
    return { allowed: check.allowed, check, crossed };
  }

  private async fireWarnings(
    organizationId: string,
    resource: string,
    percent: number,
    period: string,
  ): Promise<WarningLevel[]> {
    const crossed = WARNING_LEVELS.filter(t => percent >= t);
    if (crossed.length === 0) return [];
    const fired = await this.store.getWarningThresholds(organizationId, resource, period);
    const fresh = crossed.filter(t => !fired.includes(String(t)));
    if (fresh.length === 0) return [];
    await this.store.setWarningThresholds(organizationId, resource, period, [
      ...fired,
      ...fresh.map(String),
    ]);
    for (const threshold of fresh) {
      await this.notifier
        .notifyQuotaWarning({ organizationId, resource, percent, threshold, period })
        .catch(() => undefined);
    }
    return fresh;
  }

  private async evaluateWarnings(
    organizationId: string,
    service: UsageService,
    metric: UsageMetric,
    period: string,
  ): Promise<void> {
    const { planId } = await this.effectiveLimits(organizationId);
    const limit = this.getLimit(planId, service, metric);
    if (limit === null || limit < 0) return;
    const rows = await this.aggregate(organizationId, period);
    const total = rows
      .filter(r => r.service === service && r.metric === metric)
      .reduce((a, r) => a + r.total, 0);
    const percent =
      limit === 0
        ? total > 0
          ? 100
          : 0
        : Math.min(100, Math.floor((toLimitUnits(metric, total) / limit) * 100));
    await this.fireWarnings(organizationId, `${service}.${metric}`, percent, period);
  }

  // ── Invoices / payments / credits ───────────────────────────────

  /**
   * Generate an open invoice from real usage: plan base price + metered
   * overage lines where the plan offers overage rates. Never invents
   * charges — every line traces to the plan catalog or a usage aggregate.
   */
  async generateInvoice(organizationId: string, period?: string): Promise<Invoice> {
    const { planId } = await this.effectiveLimits(organizationId);
    const plan = getPlan(planId);
    const target = period ?? periodOf(this.now());
    const { start, end } = periodBounds(target);
    const rows = await this.aggregate(organizationId, target);
    const sum = (service: UsageService, metric: UsageMetric): number =>
      rows
        .filter(r => r.service === service && r.metric === metric)
        .reduce((a, r) => a + r.total, 0);
    const lines: Invoice['lines'] = [];
    if ((plan.priceCents ?? 0) > 0) {
      lines.push({
        label: `${plan.name} plan (${target})`,
        quantity: 1,
        unitCents: plan.priceCents ?? 0,
        amountCents: plan.priceCents ?? 0,
      });
    }
    const over = (
      service: UsageService,
      metric: UsageMetric,
      key: 'api_requests' | 'bandwidth_mb' | 'ai_tokens' | 'function_invocations',
      toBillable: (rawOver: number) => { units: number; unitCents: number; unit: string },
    ): void => {
      const rate = plan.overage[key];
      const limitKey = limitKeyFor(service, metric);
      if (!rate?.unitCents || !limitKey) return;
      const rawLimit = plan.limits[limitKey];
      // Byte-denominated plan limits are configured in MB; usage is raw bytes.
      const rawLimitUnits = metric === 'api_bandwidth_bytes' ? rawLimit * 1024 * 1024 : rawLimit;
      if (rawLimitUnits < 0) return;
      const usedRaw = sum(service, metric);
      if (usedRaw <= rawLimitUnits) return;
      const { units, unitCents, unit } = toBillable(usedRaw - rawLimitUnits);
      if (units <= 0) return;
      const amountCents = Math.ceil(units) * unitCents;
      lines.push({
        label: `${key} overage (${units} ${unit} over plan)`,
        quantity: Math.ceil(units),
        unitCents,
        amountCents,
      });
    };
    over('api', 'api_requests', 'api_requests', raw => ({
      units: raw / 10_000,
      unitCents: 1,
      unit: '10k requests',
    }));
    over('api', 'api_bandwidth_bytes', 'bandwidth_mb', raw => ({
      units: raw / (1024 * 1024 * 1024),
      unitCents: 8,
      unit: 'GB',
    }));
    over('ai', 'ai_tokens', 'ai_tokens', raw => ({
      units: raw / 1_000_000,
      unitCents: 60,
      unit: '1M tokens',
    }));
    over('functions', 'function_invocations', 'function_invocations', raw => ({
      units: raw / 1_000_000,
      unitCents: 20,
      unit: '1M invocations',
    }));
    const amountCents = lines.reduce((a, l) => a + l.amountCents, 0);
    const existing = await this.store.listInvoices(organizationId);
    const number = `INV-${target.replace('-', '')}-${String(existing.length + 1).padStart(3, '0')}`;
    return this.store.createInvoice({
      organizationId,
      number,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      lines,
      amountCents,
      currency: plan.currency,
    });
  }

  async listInvoices(organizationId: string): Promise<Invoice[]> {
    return this.store.listInvoices(organizationId);
  }

  async getInvoice(organizationId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.store.getInvoice(invoiceId);
    if (!invoice || invoice.organizationId !== organizationId) {
      throw new BillingError('NOT_FOUND', 'Invoice not found', 404);
    }
    return invoice;
  }

  async listPayments(organizationId: string): Promise<Payment[]> {
    return this.store.listPayments(organizationId);
  }

  async creditBalanceCents(organizationId: string): Promise<number> {
    return this.store.creditBalanceCents(organizationId);
  }

  async grantCredit(
    organizationId: string,
    amountCents: number,
    reason: string,
    expiresAt?: string | null,
  ): Promise<void> {
    await this.store.addCredit(organizationId, amountCents, reason, expiresAt);
  }

  /** Apply usable credits against an open invoice total (reporting aid). */
  async invoiceBalanceCents(organizationId: string, invoiceId: string): Promise<number> {
    const invoice = await this.store.getInvoice(invoiceId);
    if (!invoice || invoice.organizationId !== organizationId) {
      throw new BillingError('NOT_FOUND', 'Invoice not found', 404);
    }
    const credits = await this.store.creditBalanceCents(organizationId);
    return Math.max(0, invoice.amountCents - credits);
  }

  /**
   * Apply an already-verified, deduplicated provider event to local state.
   * Only known event types mutate anything; unknown types are recorded and
   * ignored. Billing status is derived here from server-side events — never
   * from client claims.
   */
  async applyProviderEvent(input: {
    provider: string;
    eventId: string;
    type: string;
    organizationId: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ applied: boolean; detail: string }> {
    const seen = await this.store.findWebhookEvent(input.provider, input.eventId);
    if (seen) return { applied: false, detail: 'duplicate event ignored' };
    await this.store.recordWebhookEvent({
      provider: input.provider,
      eventId: input.eventId,
      type: input.type,
      organizationId: input.organizationId,
      payload: sanitizeEventPayload(input.payload),
    });
    if (!input.organizationId)
      return { applied: false, detail: 'no organization scope; recorded only' };
    switch (input.type) {
      case 'payment.succeeded': {
        const amount = input.payload['amountCents'];
        const invoiceId = input.payload['invoiceId'];
        if (!Number.isInteger(amount) || (amount as number) <= 0) {
          return { applied: false, detail: 'payment event missing a valid amountCents' };
        }
        const payment = await this.store.createPayment({
          organizationId: input.organizationId,
          invoiceId: typeof invoiceId === 'string' ? invoiceId : null,
          amountCents: amount as number,
          currency:
            typeof input.payload['currency'] === 'string'
              ? (input.payload['currency'] as string).slice(0, 3)
              : 'USD',
          status: 'succeeded',
          provider: input.provider,
          providerPaymentId:
            typeof input.payload['paymentId'] === 'string'
              ? (input.payload['paymentId'] as string)
              : null,
        });
        if (payment.invoiceId) {
          const invoice = await this.store.getInvoice(payment.invoiceId);
          if (
            invoice &&
            invoice.organizationId === input.organizationId &&
            invoice.status === 'open'
          ) {
            const paid = await this.listPaymentsTotal(input.organizationId, invoice.id);
            if (paid >= invoice.amountCents) await this.store.setInvoiceStatus(invoice.id, 'paid');
          }
        }
        return { applied: true, detail: `payment ${payment.id} recorded` };
      }
      case 'payment.failed':
      case 'payment.refunded': {
        return { applied: true, detail: `payment event noted (${input.type}); no local mutation` };
      }
      case 'subscription.updated':
      case 'subscription.canceled': {
        const sub = await this.getSubscription(input.organizationId);
        const status = input.type === 'subscription.canceled' ? 'canceled' : sub.status;
        await this.store.upsertSubscription({
          organizationId: sub.organizationId,
          planId: sub.planId,
          status,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          renewsAt: sub.renewsAt,
          provider: input.provider,
          providerCustomerId: sub.providerCustomerId,
          providerSubscriptionId:
            typeof input.payload['subscriptionId'] === 'string'
              ? (input.payload['subscriptionId'] as string)
              : sub.providerSubscriptionId,
        });
        return { applied: true, detail: `subscription marked ${status}` };
      }
      default:
        return {
          applied: false,
          detail: `unknown event type ${input.type.slice(0, 60)}; recorded only`,
        };
    }
  }

  private async listPaymentsTotal(organizationId: string, invoiceId: string): Promise<number> {
    const payments = await this.store.listPayments(organizationId);
    return payments
      .filter(p => p.invoiceId === invoiceId && p.status === 'succeeded')
      .reduce((a, p) => a + p.amountCents, 0);
  }

  // ── Maintenance (worker-called; idempotent, retryable, observable) ──
  /**
   * Recurring billing maintenance: reconcile time-driven subscription
   * transitions and prune raw usage past retention. Safe to run on any
   * schedule — every step is idempotent and failure-isolated per org.
   */
  async runMaintenance(
    organizationIds: string[],
    opts: { rawRetentionDays?: number } = {},
  ): Promise<{
    reconciled: number;
    pruned: number;
    errors: { organizationId: string; error: string }[];
  }> {
    const retentionDays = opts.rawRetentionDays ?? 90;
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    let reconciled = 0;
    const errors: { organizationId: string; error: string }[] = [];
    for (const organizationId of organizationIds.slice(0, 10_000)) {
      try {
        const sub = await this.store.getSubscription(organizationId);
        if (sub) {
          await this.reconcile(sub);
          reconciled += 1;
        }
      } catch (err) {
        errors.push({
          organizationId,
          error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
      }
    }
    let pruned = 0;
    try {
      pruned = await this.store.pruneUsageRecords(cutoff);
    } catch (err) {
      errors.push({
        organizationId: '',
        error: `prune failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      });
    }
    return { reconciled, pruned, errors: errors.slice(0, 50) };
  }
}
