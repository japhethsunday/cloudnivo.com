import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Invoice, Payment, Subscription } from './types.js';

/**
 * Payment-provider abstraction. The billing domain never imports a vendor
 * SDK: providers implement this interface, selected by BILLING_PROVIDER.
 * `ManualBillingProvider` is the honest default — it assigns plans, trials,
 * and invoices without ever claiming a charge happened. A Stripe (or other)
 * provider plugs in later behind the same boundary, reading secrets only
 * from environment.
 */

export interface CheckoutSession {
  url: string | null;
  instructions: string;
}

export interface PortalSession {
  url: string | null;
  instructions: string;
}

export interface ProviderSyncResult {
  status: Subscription['status'];
  renewsAt: string | null;
  providerSubscriptionId: string | null;
}

export interface BillingProvider {
  readonly name: string;
  createCustomer(organizationId: string, email: string): Promise<{ providerCustomerId: string }>;
  createCheckout(organizationId: string, planId: string): Promise<CheckoutSession>;
  createSubscription(organizationId: string, planId: string): Promise<{ providerSubscriptionId: string | null }>;
  cancelSubscription(providerSubscriptionId: string | null): Promise<void>;
  updateSubscription(providerSubscriptionId: string | null, planId: string): Promise<void>;
  getSubscription(providerSubscriptionId: string | null): Promise<ProviderSyncResult | null>;
  createPortalSession(organizationId: string): Promise<PortalSession>;
  /** Verify a raw webhook body against its signature. Throws on mismatch. */
  verifyWebhook(rawBody: string, signature: string): void;
}

/**
 * Manual provider: plan/trial/invoice administration without a payment
 * rail. Checkout and portal return human instructions (dashboard-driven);
 * webhooks still verify + process for providers that forward events here.
 * It never synthesizes payments, charges, or provider ids.
 */
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';

  constructor(private readonly opts: { webhookSecret: string; dashboardUrl: string } = { webhookSecret: '', dashboardUrl: '' }) {}

  async createCustomer(organizationId: string, _email: string): Promise<{ providerCustomerId: string }> {
    void _email;
    return { providerCustomerId: `manual:${organizationId}` };
  }

  async createCheckout(organizationId: string, planId: string): Promise<CheckoutSession> {
    return {
      url: null,
      instructions: `Manual billing is enabled: an owner can activate the ${planId} plan for organization ${organizationId} from the dashboard billing page. No payment is collected by this provider.`,
    };
  }

  async createSubscription(
    _organizationId: string,
    _planId: string,
  ): Promise<{ providerSubscriptionId: string | null }> {
    void _organizationId;
    void _planId;
    return { providerSubscriptionId: null };
  }

  async cancelSubscription(_providerSubscriptionId: string | null): Promise<void> {
    // Nothing remote to cancel; local state transitions in BillingService.
  }

  async updateSubscription(_providerSubscriptionId: string | null, _planId: string): Promise<void> {
    void _planId;
  }

  async getSubscription(_providerSubscriptionId: string | null): Promise<ProviderSyncResult | null> {
    return null;
  }

  async createPortalSession(_organizationId: string): Promise<PortalSession> {
    return {
      url: null,
      instructions: 'Manual billing has no customer portal. Manage the plan from the dashboard billing page.',
    };
  }

  verifyWebhook(rawBody: string, signature: string): void {
    verifyWebhookSignature(rawBody, signature, this.opts.webhookSecret);
  }
}

/** HMAC-SHA256 webhook verification (constant-time compare, replay-checked by callers). */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): void {
  if (!secret) throw new Error('BILLING_WEBHOOK_SECRET is not configured');
  if (!signature || signature.length > 512) throw new Error('Invalid webhook signature');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().replace(/^sha256=/, ''), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid webhook signature');
  }
}

export function providerFromConfig(opts: { provider: string; webhookSecret: string; dashboardUrl: string }): BillingProvider {
  void opts.provider;
  // Only the manual provider ships today; named providers resolve here when
  // their credentials + SDK wiring land (never hardcoded).
  return new ManualBillingProvider({ webhookSecret: opts.webhookSecret, dashboardUrl: opts.dashboardUrl });
}

export type { Invoice, Payment };
