import { describe, expect, it } from 'vitest';
import { MemoryBillingStore } from './store.js';
import { BillingService } from './service.js';
import { getPlan } from './plans.js';

function service(now?: Date, store?: MemoryBillingStore) {
  return new BillingService(
    store ?? new MemoryBillingStore(),
    { notifyQuotaWarning: async () => undefined },
    now ? () => now : undefined,
  );
}

describe('plans catalog', () => {
  it('exposes four ordered plans with central limits', () => {
    expect(getPlan('free').limits.projects).toBe(3);
    expect(getPlan('pro').limits.projects).toBe(15);
    expect(getPlan('enterprise').limits.projects).toBe(-1);
    expect(() => getPlan('nope')).toThrow();
  });
});

describe('subscriptions', () => {
  it('defaults new orgs to free/active and reconciles expired trials', async () => {
    const store = new MemoryBillingStore();
    const svc = service(new Date('2026-03-10T12:00:00Z'), store);
    const sub = await svc.getSubscription('org-1');
    expect(sub.planId).toBe('free');
    expect(sub.status).toBe('active');
    const trialing = await svc.changePlan('org-1', 'pro', { trialDays: 14 });
    expect(trialing.status).toBe('trialing');
    const later = service(new Date('2026-04-10T12:00:00Z'), store);
    const reconciled = await later.reconcile(trialing);
    expect(reconciled.status).toBe('expired');
    expect((await later.effectiveLimits('org-1')).planId).toBe('free');
  });

  it('blocks downgrades that would breach gauge limits', async () => {
    const svc = service();
    await svc.changePlan('org-1', 'business', {});
    await expect(
      svc.changePlan('org-1', 'free', { gaugeReader: async () => 10 }),
    ).rejects.toMatchObject({ code: 'DOWNGRADE_BLOCKED' });
  });

  it('cancels while keeping service until period end', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.changePlan('org-1', 'pro', {});
    const canceled = await svc.cancelSubscription('org-1');
    expect(canceled.status).toBe('canceled');
    expect((await svc.effectiveLimits('org-1')).planId).toBe('pro');
  });
});

describe('metering and quotas', () => {
  it('sums counters and maxes gauges per period', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.increment('org-1', 'p1', 'api', 'api_requests', 40);
    await svc.increment('org-1', 'p1', 'api', 'api_requests', 60);
    await svc.increment('org-1', 'p2', 'api', 'api_requests', 10);
    await svc.record('org-1', 'p1', 'storage', 'storage_bytes', 100);
    await svc.record('org-1', 'p1', 'storage', 'storage_bytes', 50);
    const summary = await svc.getCurrentUsage('org-1', new Date('2026-03-10T12:00:00Z'));
    const api = summary.slices.find(s => s.metric === 'api_requests');
    expect(api?.total).toBe(110);
    expect(api?.byProject).toHaveLength(2);
    const bytes = summary.slices.find(s => s.metric === 'storage_bytes');
    expect(bytes?.total).toBe(100);
  });

  it('enforces hard limits with machine-readable checks', async () => {
    const svc = service();
    const ok = await svc.checkLimit('org-1', 'api', 'api_requests', 10, 5);
    expect(ok.allowed).toBe(true);
    expect(ok.check?.remaining).toBe(100_000 - 15);
    const denied = await svc.checkLimit('org-1', 'api', 'api_requests', 99_999, 5);
    expect(denied.allowed).toBe(false);
    expect(denied.check?.percent).toBe(100);
    const soft = await svc.checkLimit('org-1', 'api', 'api_requests', 999_999, 5, 'soft');
    expect(soft.allowed).toBe(true);
  });

  it('fires each warning threshold exactly once per period', async () => {
    const seen: number[] = [];
    const svc = new BillingService(new MemoryBillingStore(), {
      notifyQuotaWarning: async input => {
        seen.push(input.threshold);
      },
    });
    await svc.increment('org-1', '', 'api', 'api_requests', 60_000);
    expect(seen).toEqual([50]);
    await svc.increment('org-1', '', 'api', 'api_requests', 20_000);
    expect(seen).toEqual([50, 75]);
    await svc.increment('org-1', '', 'api', 'api_requests', 1);
    expect(seen).toEqual([50, 75]);
  });

  it('handles concurrent increments without losing counts', async () => {
    const svc = service();
    await Promise.all(Array.from({ length: 200 }, () => svc.increment('org-1', 'p1', 'functions', 'function_invocations', 1)));
    const summary = await svc.getCurrentUsage('org-1');
    expect(summary.slices.find(s => s.metric === 'function_invocations')?.total).toBe(200);
  });

  it('rejects negative/overflow usage values', async () => {
    const svc = service();
    await expect(svc.record('org-1', '', 'api', 'api_requests', -1)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(svc.record('org-1', '', 'api', 'api_requests', 1.5)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('periods', () => {
  it('buckets by UTC month across boundaries', async () => {
    const svc = service();
    await svc.record('org-1', '', 'api', 'api_requests', 5, new Date('2026-01-31T23:59:59Z'));
    await svc.record('org-1', '', 'api', 'api_requests', 7, new Date('2026-02-01T00:00:01Z'));
    const jan = await svc.aggregate('org-1', '2026-01');
    const feb = await svc.aggregate('org-1', '2026-02');
    expect(jan.reduce((a, r) => a + r.total, 0)).toBe(5);
    expect(feb.reduce((a, r) => a + r.total, 0)).toBe(7);
    await expect(svc.aggregate('org-1', 'not-a-period')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('invoices and credits', () => {
  it('invoices metered overage from real usage only', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.changePlan('org-1', 'pro', {});
    await svc.increment('org-1', '', 'api', 'api_requests', 5_010_000);
    const invoice = await svc.generateInvoice('org-1', '2026-03');
    expect(invoice.lines[0]?.label).toContain('Pro plan');
    const over = invoice.lines.find(l => l.label.includes('overage'));
    expect(over?.quantity).toBe(1);
    expect(invoice.amountCents).toBe(2000 + 1);
    expect(await svc.invoiceBalanceCents('org-1', invoice.id)).toBe(2001);
    await svc.grantCredit('org-1', 501, 'goodwill');
    expect(await svc.invoiceBalanceCents('org-1', invoice.id)).toBe(1500);
  });

  it('ignores expired credits', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.grantCredit('org-1', 100, 'old', '2026-01-01T00:00:00.000Z');
    await svc.grantCredit('org-1', 100, 'fresh', null);
    const inv = await svc.generateInvoice('org-1', '2026-03');
    expect(await svc.invoiceBalanceCents('org-1', inv.id)).toBe(0);
  });

  it('prices overage from the plan catalog (business rates differ from pro)', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.changePlan('org-1', 'business', {});
    // Business: 100M AI tokens included at 50c/1M overage (pro would be 60c).
    await svc.increment('org-1', '', 'ai', 'ai_tokens', 101_000_000);
    const invoice = await svc.generateInvoice('org-1', '2026-03');
    const over = invoice.lines.find(l => l.label.includes('overage'));
    expect(over?.quantity).toBe(1);
    expect(over?.unitCents).toBe(50);
    expect(invoice.amountCents).toBe(9900 + 50);
  });
});

describe('provider events', () => {
  it('applies payment.succeeded once and closes the invoice', async () => {
    const svc = service(new Date('2026-03-10T12:00:00Z'));
    await svc.changePlan('org-1', 'pro', {});
    const inv = await svc.generateInvoice('org-1', '2026-03');
    const evt = {
      provider: 'manual',
      eventId: 'evt-1',
      type: 'payment.succeeded',
      organizationId: 'org-1',
      payload: { amountCents: 2000, currency: 'USD', invoiceId: inv.id, paymentId: 'pay-1' },
    };
    expect((await svc.applyProviderEvent(evt)).applied).toBe(true);
    expect((await svc.applyProviderEvent(evt)).applied).toBe(false);
    const updated = await svc.getInvoice('org-1', inv.id);
    expect(updated?.status).toBe('paid');
  });

  it('ignores unknown types and unscoped events safely', async () => {
    const svc = service();
    const res = await svc.applyProviderEvent({
      provider: 'manual',
      eventId: 'evt-x',
      type: 'something.else',
      organizationId: 'org-1',
      payload: {},
    });
    expect(res.applied).toBe(false);
    const unscoped = await svc.applyProviderEvent({
      provider: 'manual',
      eventId: 'evt-y',
      type: 'payment.succeeded',
      organizationId: null,
      payload: {},
    });
    expect(unscoped.applied).toBe(false);
  });
});

describe('maintenance', () => {
  it('reconciles trials and prunes old raw events idempotently', async () => {
    const store = new MemoryBillingStore();
    const svc = service(new Date('2026-04-10T12:00:00Z'), store);
    await svc.changePlan('org-1', 'pro', { trialDays: 14 });
    await svc.record('org-1', '', 'api', 'api_requests', 3, new Date('2026-01-01T00:00:00Z'));
    const later = service(new Date('2026-05-10T12:00:00Z'), store);
    const first = await later.runMaintenance(['org-1'], { rawRetentionDays: 30 });
    expect(first.reconciled).toBe(1);
    expect(first.pruned).toBe(1);
    expect(first.errors).toEqual([]);
    const second = await later.runMaintenance(['org-1'], { rawRetentionDays: 30 });
    expect(second.pruned).toBe(0);
    expect((await later.getSubscription('org-1')).status).toBe('expired');
  });
});
