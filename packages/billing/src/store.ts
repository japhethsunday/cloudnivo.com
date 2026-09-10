import type {
  Invoice,
  InvoiceLine,
  Payment,
  Subscription,
  UsageMetric,
  UsageService,
} from './types.js';
import { GAUGE_METRICS } from './types.js';

/**
 * Billing persistence boundary. `MemoryBillingStore` backs dev/tests;
 * `DrizzleBillingStore` (Phase 8-style, same shapes) is selected with
 * CONTROL_STORE=drizzle. Callers program to this interface only.
 */

export interface SubscriptionInput {
  organizationId: string;
  planId: string;
  status: Subscription['status'];
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  renewsAt: string | null;
  provider?: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
}

export interface UsageEvent {
  organizationId: string;
  projectId: string;
  service: UsageService;
  metric: UsageMetric;
  value: number;
  period: string;
  at?: string;
}

export interface InvoiceInput {
  organizationId: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  amountCents: number;
  currency?: string;
  provider?: string;
  providerInvoiceId?: string | null;
}

export interface PaymentInput {
  organizationId: string;
  invoiceId: string | null;
  amountCents: number;
  currency?: string;
  status: Payment['status'];
  provider: string;
  providerPaymentId?: string | null;
}

export interface WebhookEventInput {
  provider: string;
  eventId: string;
  type: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
}

export interface StoredWebhookEvent {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  organizationId: string | null;
  processedAt: string;
}

export interface BillingStore {
  // Subscriptions (one row per org, upserted).
  getSubscription(organizationId: string): Promise<Subscription | null>;
  upsertSubscription(input: SubscriptionInput): Promise<Subscription>;
  // Usage.
  recordUsage(event: UsageEvent): Promise<void>;
  /** Counter sums + gauge maxima grouped by project for one period. */
  aggregateUsage(
    organizationId: string,
    period: string,
  ): Promise<{ service: UsageService; metric: UsageMetric; projectId: string; total: number }[]>;
  pruneUsageRecords(olderThanIso: string): Promise<number>;
  // Warnings.
  getWarningThresholds(organizationId: string, resource: string, period: string): Promise<string[]>;
  setWarningThresholds(organizationId: string, resource: string, period: string, thresholds: string[]): Promise<void>;
  // Invoices / payments / credits.
  createInvoice(input: InvoiceInput): Promise<Invoice>;
  listInvoices(organizationId: string): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;
  setInvoiceStatus(id: string, status: Invoice['status']): Promise<Invoice | null>;
  createPayment(input: PaymentInput): Promise<Payment>;
  listPayments(organizationId: string): Promise<Payment[]>;
  findPaymentByProviderId(provider: string, providerPaymentId: string): Promise<Payment | null>;
  setPaymentStatus(id: string, status: Payment['status'], invoiceId?: string | null): Promise<Payment | null>;
  creditBalanceCents(organizationId: string): Promise<number>;
  addCredit(organizationId: string, amountCents: number, reason: string, expiresAt?: string | null): Promise<void>;
  // Webhook idempotency.
  findWebhookEvent(provider: string, eventId: string): Promise<StoredWebhookEvent | null>;
  recordWebhookEvent(input: WebhookEventInput): Promise<StoredWebhookEvent>;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class MemoryBillingStore implements BillingStore {
  private readonly subs = new Map<string, Subscription>();
  private readonly records: {
    organizationId: string;
    projectId: string;
    service: UsageService;
    metric: UsageMetric;
    value: number;
    period: string;
    at: string;
  }[] = [];
  private readonly warnings = new Map<string, { thresholds: string[]; updatedAt: string }>();
  private readonly invoices = new Map<string, Invoice>();
  private readonly payments = new Map<string, Payment>();
  private readonly events = new Map<string, StoredWebhookEvent>();
  private readonly credits: { organizationId: string; amountCents: number; reason: string; expiresAt: string | null; at: string }[] = [];
  private invoiceCounter = 0;
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  async getSubscription(organizationId: string): Promise<Subscription | null> {
    return this.subs.get(organizationId) ?? null;
  }

  async upsertSubscription(input: SubscriptionInput): Promise<Subscription> {
    const now = isoNow();
    const prev = this.subs.get(input.organizationId);
    const sub: Subscription = {
      id: prev?.id ?? this.nextId('sub'),
      organizationId: input.organizationId,
      planId: input.planId as Subscription['planId'],
      status: input.status,
      trialEndsAt: input.trialEndsAt,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      renewsAt: input.renewsAt,
      canceledAt: ['canceled', 'expired'].includes(input.status) ? (prev?.canceledAt ?? now) : null,
      provider: input.provider ?? prev?.provider ?? 'manual',
      providerCustomerId: input.providerCustomerId ?? prev?.providerCustomerId ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? prev?.providerSubscriptionId ?? null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.subs.set(input.organizationId, sub);
    return { ...sub };
  }

  async recordUsage(event: UsageEvent): Promise<void> {
    if (!Number.isInteger(event.value) || event.value < 0) {
      throw new Error('Usage value must be a non-negative integer');
    }
    this.records.push({ ...event, at: event.at ?? isoNow() });
  }

  async aggregateUsage(
    organizationId: string,
    period: string,
  ): Promise<{ service: UsageService; metric: UsageMetric; projectId: string; total: number }[]> {
    const groups = new Map<string, { service: UsageService; metric: UsageMetric; projectId: string; values: number[] }>();
    for (const r of this.records) {
      if (r.organizationId !== organizationId || r.period !== period) continue;
      const key = `${r.service}\n${r.metric}\n${r.projectId}`;
      let g = groups.get(key);
      if (!g) {
        g = { service: r.service, metric: r.metric, projectId: r.projectId, values: [] };
        groups.set(key, g);
      }
      g.values.push(r.value);
    }
    return [...groups.values()].map(g => ({
      service: g.service,
      metric: g.metric,
      projectId: g.projectId,
      total: GAUGE_METRICS.has(g.metric) ? Math.max(...g.values) : g.values.reduce((a, b) => a + b, 0),
    }));
  }

  async pruneUsageRecords(olderThanIso: string): Promise<number> {
    const before = this.records.length;
    const kept = this.records.filter(r => r.at >= olderThanIso);
    this.records.length = 0;
    this.records.push(...kept);
    return before - kept.length;
  }

  async getWarningThresholds(organizationId: string, resource: string, period: string): Promise<string[]> {
    return this.warnings.get(`${organizationId}\n${resource}\n${period}`)?.thresholds ?? [];
  }

  async setWarningThresholds(organizationId: string, resource: string, period: string, thresholds: string[]): Promise<void> {
    this.warnings.set(`${organizationId}\n${resource}\n${period}`, { thresholds: [...thresholds], updatedAt: isoNow() });
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const now = isoNow();
    this.invoiceCounter += 1;
    const invoice: Invoice = {
      id: this.nextId('in'),
      organizationId: input.organizationId,
      number: input.number || `INV-${String(this.invoiceCounter).padStart(6, '0')}`,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      lines: input.lines.map(l => ({ ...l })),
      amountCents: input.amountCents,
      currency: input.currency ?? 'USD',
      status: 'open',
      provider: input.provider ?? 'manual',
      providerInvoiceId: input.providerInvoiceId ?? null,
      createdAt: now,
    };
    this.invoices.set(invoice.id, invoice);
    return { ...invoice, lines: invoice.lines.map(l => ({ ...l })) };
  }

  async listInvoices(organizationId: string): Promise<Invoice[]> {
    return [...this.invoices.values()]
      .filter(i => i.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(i => ({ ...i, lines: i.lines.map(l => ({ ...l })) }));
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const inv = this.invoices.get(id);
    return inv ? { ...inv, lines: inv.lines.map(l => ({ ...l })) } : null;
  }

  async setInvoiceStatus(id: string, status: Invoice['status']): Promise<Invoice | null> {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    if (inv.status === 'paid' && status !== 'paid') return { ...inv, lines: inv.lines.map(l => ({ ...l })) };
    inv.status = status;
    return { ...inv, lines: inv.lines.map(l => ({ ...l })) };
  }

  async createPayment(input: PaymentInput): Promise<Payment> {
    if (input.providerPaymentId) {
      const dup = await this.findPaymentByProviderId(input.provider, input.providerPaymentId);
      if (dup) return dup;
    }
    const payment: Payment = {
      id: this.nextId('pay'),
      organizationId: input.organizationId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      currency: input.currency ?? 'USD',
      status: input.status,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId ?? null,
      createdAt: isoNow(),
    };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }

  async listPayments(organizationId: string): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter(p => p.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(p => ({ ...p }));
  }

  async findPaymentByProviderId(provider: string, providerPaymentId: string): Promise<Payment | null> {
    for (const p of this.payments.values()) {
      if (p.provider === provider && p.providerPaymentId === providerPaymentId) return { ...p };
    }
    return null;
  }

  async setPaymentStatus(id: string, status: Payment['status'], invoiceId?: string | null): Promise<Payment | null> {
    const p = this.payments.get(id);
    if (!p) return null;
    p.status = status;
    if (invoiceId !== undefined) p.invoiceId = invoiceId;
    return { ...p };
  }

  async creditBalanceCents(organizationId: string): Promise<number> {
    const now = isoNow();
    return this.credits
      .filter(c => c.organizationId === organizationId && (!c.expiresAt || c.expiresAt > now))
      .reduce((sum, c) => sum + c.amountCents, 0);
  }

  async addCredit(organizationId: string, amountCents: number, reason: string, expiresAt?: string | null): Promise<void> {
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error('Credit amount must be a non-zero integer');
    this.credits.push({ organizationId, amountCents, reason: reason.slice(0, 200), expiresAt: expiresAt ?? null, at: isoNow() });
  }

  async findWebhookEvent(provider: string, eventId: string): Promise<StoredWebhookEvent | null> {
    return this.events.get(`${provider}\n${eventId}`) ?? null;
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<StoredWebhookEvent> {
    const existing = await this.findWebhookEvent(input.provider, input.eventId);
    if (existing) return existing;
    const entry: StoredWebhookEvent = {
      id: this.nextId('evt'),
      provider: input.provider,
      eventId: input.eventId,
      type: input.type,
      organizationId: input.organizationId,
      processedAt: isoNow(),
    };
    this.events.set(`${input.provider}\n${input.eventId}`, entry);
    return { ...entry };
  }
}
