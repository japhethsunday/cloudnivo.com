import { describe, expect, it } from 'vitest';
import { createDatabaseService } from '@cloudnivo/database';
import { DrizzleBillingStore } from './store-drizzle.js';
import { BillingService } from './service.js';

// Live round-trip against real PostgreSQL (migrated control schema).
// Runs only with LIVE_PG_URL set — same convention as realtime-cdc.live.test.ts.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('billing drizzle store on live postgres', () => {
  it('persists subscriptions, usage, invoices, and webhook dedup', async () => {
    const svc = createDatabaseService(LIVE_PG_URL);
    try {
      const store = new DrizzleBillingStore(svc.db);
      const billing = new BillingService(store, { notifyQuotaWarning: async () => undefined });
      const org = `org-${Date.now() % 1000000}`;
      await billing.changePlan(org, 'pro', {});
      expect((await billing.getSubscription(org)).planId).toBe('pro');
      await Promise.all(Array.from({ length: 50 }, () => billing.increment(org, 'p1', 'api', 'api_requests', 2)));
      const summary = await billing.getCurrentUsage(org);
      expect(summary.slices.find(s => s.metric === 'api_requests')?.total).toBe(100);
      const invoice = await billing.generateInvoice(org);
      expect(invoice.amountCents).toBe(2000);
      const first = await billing.applyProviderEvent({
        provider: 'manual',
        eventId: `evt-${Date.now()}`,
        type: 'payment.succeeded',
        organizationId: org,
        payload: { amountCents: 2000, currency: 'USD', invoiceId: invoice.id, paymentId: `pay-${Date.now()}` },
      });
      expect(first.applied).toBe(true);
      expect((await billing.getInvoice(org, invoice.id)).status).toBe('paid');
    } finally {
      await svc.close();
    }
  }, 60_000);
});
