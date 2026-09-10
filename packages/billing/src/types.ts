/**
 * Billing domain model.
 *
 * Billing belongs to organizations; usage is measured per organization,
 * project (`''` = org-level rollup), service, and metric, bucketed by UTC
 * `YYYY-MM` period. No payment credentials are ever stored — only provider
 * references (customer/subscription/payment ids) plus CloudNivo-side state.
 */

export type PlanId = 'free' | 'pro' | 'business' | 'enterprise';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'paused';

export type InvoiceStatus = 'open' | 'paid' | 'void';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

/** Metered services. */
export type UsageService = 'api' | 'database' | 'storage' | 'realtime' | 'functions' | 'ai' | 'jobs';

/**
 * Metered metrics. Counter metrics sum within a period; gauge metrics take
 * the period maximum. Units are integers (bytes stay bytes — bigint in pg).
 */
export type UsageMetric =
  | 'api_requests'
  | 'api_bandwidth_bytes'
  | 'db_storage_bytes'
  | 'storage_bytes'
  | 'storage_files'
  | 'storage_operations'
  | 'realtime_connections'
  | 'realtime_messages'
  | 'function_invocations'
  | 'function_gb_seconds'
  | 'ai_requests'
  | 'ai_tokens'
  | 'projects'
  | 'team_members'
  | 'api_keys'
  | 'jobs';

export const GAUGE_METRICS: ReadonlySet<UsageMetric> = new Set([
  'db_storage_bytes',
  'storage_bytes',
  'storage_files',
  'realtime_connections',
  'projects',
  'team_members',
  'api_keys',
]);

export type LimitPolicy = 'hard' | 'soft';
export type WarningLevel = 50 | 75 | 90 | 100;

export interface Subscription {
  id: string;
  organizationId: string;
  planId: PlanId;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  renewsAt: string | null;
  canceledAt: string | null;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLine {
  label: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface Invoice {
  id: string;
  organizationId: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  provider: string;
  providerInvoiceId: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  organizationId: string;
  invoiceId: string | null;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  providerPaymentId: string | null;
  createdAt: string;
}

export interface UsageSlice {
  service: UsageService;
  metric: UsageMetric;
  /** Org-wide total for the period (sums project rows). */
  total: number;
  byProject: { projectId: string; total: number }[];
}

export interface UsageSummary {
  organizationId: string;
  period: string;
  planId: PlanId;
  slices: UsageSlice[];
}

export interface LimitCheck {
  resource: string;
  limit: number;
  used: number;
  remaining: number;
  percent: number;
  policy: LimitPolicy;
  /** True when the requested amount fits (or policy is soft). */
  allowed: boolean;
}

export class BillingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status;
  }
}

/** UTC `YYYY-MM` period for an instant. Month boundaries in UTC, always. */
export function periodOf(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** [start, end) UTC instants bounding a `YYYY-MM` period. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m?.[1] || !m[2]) throw new BillingError('VALIDATION_ERROR', 'Invalid period (expected YYYY-MM)', 400);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new BillingError('VALIDATION_ERROR', 'Invalid period (expected YYYY-MM)', 400);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  return { start, end };
}
