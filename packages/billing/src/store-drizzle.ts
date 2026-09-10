import { and, desc, eq, lte, sql } from 'drizzle-orm';
import {
  billingCredits,
  billingEvents,
  billingInvoices,
  billingPayments,
  billingSubscriptions,
  billingWarnings,
  usageAggregates,
  usageRecords,
  type Database,
} from '@cloudnivo/database';
import type {
  Invoice,
  InvoiceLine,
  Payment,
  Subscription,
  UsageMetric,
  UsageService,
} from './types.js';
import { GAUGE_METRICS } from './types.js';
import type {
  BillingStore,
  InvoiceInput,
  PaymentInput,
  StoredWebhookEvent,
  SubscriptionInput,
  UsageEvent,
  WebhookEventInput,
} from './store.js';

/**
 * Drizzle-backed billing store. Same `BillingStore` contract as memory.
 * Counter increments use single-statement atomic upserts
 * (`total = total + excluded`), so concurrent recorders cannot lose counts.
 */

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToSubscription(row: typeof billingSubscriptions.$inferSelect): Subscription {
  return {
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId as Subscription['planId'],
    status: row.status as Subscription['status'],
    trialEndsAt: iso(row.trialEndsAt),
    currentPeriodStart: iso(row.currentPeriodStart) ?? new Date(0).toISOString(),
    currentPeriodEnd: iso(row.currentPeriodEnd) ?? new Date(0).toISOString(),
    renewsAt: iso(row.renewsAt),
    canceledAt: iso(row.canceledAt),
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    providerSubscriptionId: row.providerSubscriptionId,
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date().toISOString(),
  };
}

function rowToInvoice(row: typeof billingInvoices.$inferSelect): Invoice {
  return {
    id: row.id,
    organizationId: row.organizationId,
    number: row.number,
    periodStart: iso(row.periodStart) ?? new Date(0).toISOString(),
    periodEnd: iso(row.periodEnd) ?? new Date(0).toISOString(),
    lines: (row.lines ?? []).map(l => ({ ...(l as unknown as InvoiceLine) })),
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as Invoice['status'],
    provider: row.provider,
    providerInvoiceId: row.providerInvoiceId,
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

function rowToPayment(row: typeof billingPayments.$inferSelect): Payment {
  return {
    id: row.id,
    organizationId: row.organizationId,
    invoiceId: row.invoiceId,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as Payment['status'],
    provider: row.provider,
    providerPaymentId: row.providerPaymentId,
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

export class DrizzleBillingStore implements BillingStore {
  constructor(private readonly db: Database) {}

  async getSubscription(organizationId: string): Promise<Subscription | null> {
    const rows = await this.db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    const row = rows[0];
    return row ? rowToSubscription(row) : null;
  }

  async upsertSubscription(input: SubscriptionInput): Promise<Subscription> {
    const rows = await this.db
      .insert(billingSubscriptions)
      .values({
        organizationId: input.organizationId,
        planId: input.planId,
        status: input.status,
        trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
        currentPeriodStart: new Date(input.currentPeriodStart),
        currentPeriodEnd: new Date(input.currentPeriodEnd),
        renewsAt: input.renewsAt ? new Date(input.renewsAt) : null,
        provider: input.provider ?? 'manual',
        providerCustomerId: input.providerCustomerId ?? null,
        providerSubscriptionId: input.providerSubscriptionId ?? null,
      })
      .onConflictDoUpdate({
        target: billingSubscriptions.organizationId,
        set: {
          planId: input.planId,
          status: input.status,
          trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
          currentPeriodStart: new Date(input.currentPeriodStart),
          currentPeriodEnd: new Date(input.currentPeriodEnd),
          renewsAt: input.renewsAt ? new Date(input.renewsAt) : null,
          provider: input.provider ?? 'manual',
          providerCustomerId: input.providerCustomerId ?? null,
          providerSubscriptionId: input.providerSubscriptionId ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Subscription upsert failed');
    // Preserve canceledAt semantics: set on cancel/expire transitions only.
    if (['canceled', 'expired'].includes(input.status) && !row.canceledAt) {
      const again = await this.db
        .update(billingSubscriptions)
        .set({ canceledAt: new Date(), updatedAt: new Date() })
        .where(eq(billingSubscriptions.id, row.id))
        .returning();
      const updated = again[0];
      if (updated) return rowToSubscription(updated);
    }
    return rowToSubscription(row);
  }

  async recordUsage(event: UsageEvent): Promise<void> {
    if (!Number.isInteger(event.value) || event.value < 0) {
      throw new Error('Usage value must be a non-negative integer');
    }
    await this.db.insert(usageRecords).values({
      organizationId: event.organizationId,
      projectId: event.projectId,
      service: event.service,
      metric: event.metric,
      value: event.value,
      period: event.period,
    });
    // Gauge metrics converge on the period maximum, counters accumulate.
    // Both go through one atomic statement — concurrent writers are safe.
    const inc = GAUGE_METRICS.has(event.metric)
      ? sql`GREATEST(${usageAggregates.total}, ${event.value})`
      : sql`${usageAggregates.total} + ${event.value}`;
    await this.db
      .insert(usageAggregates)
      .values({
        organizationId: event.organizationId,
        projectId: event.projectId,
        service: event.service,
        metric: event.metric,
        period: event.period,
        total: event.value,
      })
      .onConflictDoUpdate({
        target: [
          usageAggregates.organizationId,
          usageAggregates.projectId,
          usageAggregates.service,
          usageAggregates.metric,
          usageAggregates.period,
        ],
        set: { total: inc, updatedAt: new Date() },
      });
  }

  async aggregateUsage(
    organizationId: string,
    period: string,
  ): Promise<{ service: UsageService; metric: UsageMetric; projectId: string; total: number }[]> {
    const rows = await this.db
      .select()
      .from(usageAggregates)
      .where(
        and(eq(usageAggregates.organizationId, organizationId), eq(usageAggregates.period, period)),
      );
    return rows.map(r => ({
      service: r.service as UsageService,
      metric: r.metric as UsageMetric,
      projectId: r.projectId,
      total: r.total,
    }));
  }

  async pruneUsageRecords(olderThanIso: string): Promise<number> {
    const cutoff = new Date(olderThanIso);
    if (Number.isNaN(cutoff.getTime())) throw new Error('Invalid cutoff timestamp');
    // drizzle delete without returning gives no count portably; count first.
    const doomed = await this.db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(lte(usageRecords.recordedAt, cutoff));
    if (doomed.length === 0) return 0;
    await this.db.delete(usageRecords).where(lte(usageRecords.recordedAt, cutoff));
    return doomed.length;
  }

  async getWarningThresholds(
    organizationId: string,
    resource: string,
    period: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(billingWarnings)
      .where(
        and(
          eq(billingWarnings.organizationId, organizationId),
          eq(billingWarnings.resource, resource),
          eq(billingWarnings.period, period),
        ),
      )
      .limit(1);
    return [...(rows[0]?.thresholds ?? [])];
  }

  async setWarningThresholds(
    organizationId: string,
    resource: string,
    period: string,
    thresholds: string[],
  ): Promise<void> {
    await this.db
      .insert(billingWarnings)
      .values({ organizationId, resource, period, thresholds: [...thresholds] })
      .onConflictDoUpdate({
        target: [billingWarnings.organizationId, billingWarnings.resource, billingWarnings.period],
        set: { thresholds: [...thresholds], updatedAt: new Date() },
      });
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const rows = await this.db
      .insert(billingInvoices)
      .values({
        organizationId: input.organizationId,
        number: input.number,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        lines: input.lines,
        amountCents: input.amountCents,
        currency: input.currency ?? 'USD',
        provider: input.provider ?? 'manual',
        providerInvoiceId: input.providerInvoiceId ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Invoice insert failed');
    return rowToInvoice(row);
  }

  async listInvoices(organizationId: string): Promise<Invoice[]> {
    const rows = await this.db
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.organizationId, organizationId))
      .orderBy(desc(billingInvoices.createdAt));
    return rows.map(rowToInvoice);
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const rows = await this.db
      .select()
      .from(billingInvoices)
      .where(eq(billingInvoices.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToInvoice(row) : null;
  }

  async setInvoiceStatus(id: string, status: Invoice['status']): Promise<Invoice | null> {
    const current = await this.getInvoice(id);
    if (!current) return null;
    if (current.status === 'paid' && status !== 'paid') return current;
    const rows = await this.db
      .update(billingInvoices)
      .set({ status })
      .where(eq(billingInvoices.id, id))
      .returning();
    const row = rows[0];
    return row ? rowToInvoice(row) : null;
  }

  async createPayment(input: PaymentInput): Promise<Payment> {
    if (input.providerPaymentId) {
      const dup = await this.findPaymentByProviderId(input.provider, input.providerPaymentId);
      if (dup) return dup;
    }
    try {
      const rows = await this.db
        .insert(billingPayments)
        .values({
          organizationId: input.organizationId,
          invoiceId: input.invoiceId,
          amountCents: input.amountCents,
          currency: input.currency ?? 'USD',
          status: input.status,
          provider: input.provider,
          providerPaymentId: input.providerPaymentId ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Payment insert failed');
      return rowToPayment(row);
    } catch (err) {
      if (String((err as { code?: unknown }).code) === '23505' && input.providerPaymentId) {
        const dup = await this.findPaymentByProviderId(input.provider, input.providerPaymentId);
        if (dup) return dup;
      }
      throw err;
    }
  }

  async listPayments(organizationId: string): Promise<Payment[]> {
    const rows = await this.db
      .select()
      .from(billingPayments)
      .where(eq(billingPayments.organizationId, organizationId))
      .orderBy(desc(billingPayments.createdAt));
    return rows.map(rowToPayment);
  }

  async findPaymentByProviderId(
    provider: string,
    providerPaymentId: string,
  ): Promise<Payment | null> {
    const rows = await this.db
      .select()
      .from(billingPayments)
      .where(
        and(
          eq(billingPayments.provider, provider),
          eq(billingPayments.providerPaymentId, providerPaymentId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToPayment(row) : null;
  }

  async setPaymentStatus(
    id: string,
    status: Payment['status'],
    invoiceId?: string | null,
  ): Promise<Payment | null> {
    const rows = await this.db
      .update(billingPayments)
      .set({ status, ...(invoiceId !== undefined ? { invoiceId } : {}) })
      .where(eq(billingPayments.id, id))
      .returning();
    const row = rows[0];
    return row ? rowToPayment(row) : null;
  }

  async creditBalanceCents(organizationId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(billingCredits)
      .where(eq(billingCredits.organizationId, organizationId));
    const now = new Date().toISOString();
    return rows
      .filter(r => !r.expiresAt || (iso(r.expiresAt) ?? '') > now)
      .reduce((sum, r) => sum + r.amountCents, 0);
  }

  async addCredit(
    organizationId: string,
    amountCents: number,
    reason: string,
    expiresAt?: string | null,
  ): Promise<void> {
    if (!Number.isInteger(amountCents) || amountCents === 0)
      throw new Error('Credit amount must be a non-zero integer');
    await this.db.insert(billingCredits).values({
      organizationId,
      amountCents,
      reason: reason.slice(0, 200),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
  }

  async findWebhookEvent(provider: string, eventId: string): Promise<StoredWebhookEvent | null> {
    const rows = await this.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.provider, provider), eq(billingEvents.eventId, eventId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      eventId: row.eventId,
      type: row.type,
      organizationId: row.organizationId,
      processedAt: iso(row.processedAt) ?? new Date().toISOString(),
    };
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<StoredWebhookEvent> {
    const existing = await this.findWebhookEvent(input.provider, input.eventId);
    if (existing) return existing;
    try {
      const rows = await this.db
        .insert(billingEvents)
        .values({
          provider: input.provider,
          eventId: input.eventId,
          type: input.type,
          organizationId: input.organizationId,
          payload: input.payload,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Event insert failed');
      return {
        id: row.id,
        provider: row.provider,
        eventId: row.eventId,
        type: row.type,
        organizationId: row.organizationId,
        processedAt: iso(row.processedAt) ?? new Date().toISOString(),
      };
    } catch (err) {
      if (String((err as { code?: unknown }).code) === '23505') {
        const dup = await this.findWebhookEvent(input.provider, input.eventId);
        if (dup) return dup;
      }
      throw err;
    }
  }
}
