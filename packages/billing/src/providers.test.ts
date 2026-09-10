import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManualBillingProvider, providerFromConfig, verifyWebhookSignature } from './providers.js';

const SECRET = 'whsec-test-secret-value';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
}

describe('webhook signature verification', () => {
  it('accepts valid signatures (bare and sha256= prefixed)', () => {
    const body = '{"id":"evt_1","type":"payment.succeeded"}';
    expect(() => verifyWebhookSignature(body, sign(body), SECRET)).not.toThrow();
    expect(() => verifyWebhookSignature(body, `sha256=${sign(body)}`, SECRET)).not.toThrow();
  });

  it('rejects forged, empty, and oversized signatures', () => {
    const body = '{"id":"evt_1"}';
    expect(() => verifyWebhookSignature(body, '0'.repeat(64), SECRET)).toThrow();
    expect(() => verifyWebhookSignature(body, '', SECRET)).toThrow();
    expect(() => verifyWebhookSignature(body, 'x'.repeat(513), SECRET)).toThrow();
    expect(() => verifyWebhookSignature(body, sign(body), '')).toThrow();
  });

  it('tampered bodies fail verification', () => {
    const sig = sign('{"id":"evt_1"}');
    expect(() => verifyWebhookSignature('{"id":"evt_2"}', sig, SECRET)).toThrow();
  });
});

describe('manual provider honesty', () => {
  it('never invents customers, subscriptions, or portals', async () => {
    const provider = new ManualBillingProvider({ webhookSecret: SECRET, dashboardUrl: '' });
    expect(provider.name).toBe('manual');
    const customer = await provider.createCustomer('org-1', 'a@b.c');
    expect(customer.providerCustomerId).toContain('org-1');
    expect((await provider.createSubscription('org-1', 'pro')).providerSubscriptionId).toBe(null);
    expect((await provider.getSubscription('sub-1'))).toBe(null);
    const checkout = await provider.createCheckout('org-1', 'pro');
    expect(checkout.url).toBe(null);
    expect(checkout.instructions.length).toBeGreaterThan(0);
    const portal = await provider.createPortalSession('org-1');
    expect(portal.url).toBe(null);
    await expect(provider.cancelSubscription(null)).resolves.toBeUndefined();
  });

  it('resolves providers from config without hardcoding', () => {
    expect(providerFromConfig({ provider: 'manual', webhookSecret: SECRET, dashboardUrl: '' }).name).toBe('manual');
    expect(providerFromConfig({ provider: 'stripe', webhookSecret: SECRET, dashboardUrl: '' }).name).toBe('manual');
  });
});
