import type { PlanId, UsageMetric, UsageService } from './types.js';

/**
 * Central plan catalog. Limits live HERE and nowhere else — routes and
 * services resolve an organization's effective limits through
 * `BillingService.getLimits()`, never from config constants or literals.
 * `-1` means unlimited. Prices are informational list prices for invoices;
 * no charge is ever collected except through a verified provider webhook.
 */

export interface PlanOverage {
  /** Cents per overage unit, or null when overage is not offered (hard stop). */
  unitCents: number | null;
  unit: string;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  description: string;
  /** List price, cents/month. Null = custom (enterprise, negotiated). */
  priceCents: number | null;
  currency: string;
  trialDays: number;
  limits: {
    projects: number;
    teamMembers: number;
    apiKeysPerProject: number;
    databaseStorageMbPerDb: number;
    apiRequestsPerMonth: number;
    bandwidthMbPerMonth: number;
    storageMb: number;
    storageFiles: number;
    storageBuckets: number;
    realtimeConnections: number;
    realtimeMessagesPerMonth: number;
    functionInvocationsPerMonth: number;
    functionGbSecondsPerMonth: number;
    functionsPerProject: number;
    jobsPerMonth: number;
    aiRequestsPerMonth: number;
    aiTokensPerMonth: number;
    logRetentionDays: number;
  };
  overage: Partial<Record<'api_requests' | 'bandwidth_mb' | 'ai_tokens' | 'function_invocations', PlanOverage>>;
}

const UNLIMITED = -1;

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'For prototypes and evaluation. Real limits, no payment required.',
    priceCents: 0,
    currency: 'USD',
    trialDays: 0,
    limits: {
      projects: 3,
      teamMembers: 3,
      apiKeysPerProject: 5,
      databaseStorageMbPerDb: 512,
      apiRequestsPerMonth: 100_000,
      bandwidthMbPerMonth: 5_120,
      storageMb: 1_024,
      storageFiles: 10_000,
      storageBuckets: 5,
      realtimeConnections: 100,
      realtimeMessagesPerMonth: 1_000_000,
      functionInvocationsPerMonth: 100_000,
      functionGbSecondsPerMonth: 50_000,
      functionsPerProject: 10,
      jobsPerMonth: 1_000,
      aiRequestsPerMonth: 200,
      aiTokensPerMonth: 500_000,
      logRetentionDays: 7,
    },
    overage: {},
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For production side projects and small teams.',
    priceCents: 2_000,
    currency: 'USD',
    trialDays: 14,
    limits: {
      projects: 15,
      teamMembers: 10,
      apiKeysPerProject: 25,
      databaseStorageMbPerDb: 5_120,
      apiRequestsPerMonth: 5_000_000,
      bandwidthMbPerMonth: 102_400,
      storageMb: 25_600,
      storageFiles: 250_000,
      storageBuckets: 25,
      realtimeConnections: 1_000,
      realtimeMessagesPerMonth: 25_000_000,
      functionInvocationsPerMonth: 2_500_000,
      functionGbSecondsPerMonth: 1_000_000,
      functionsPerProject: 50,
      jobsPerMonth: 25_000,
      aiRequestsPerMonth: 5_000,
      aiTokensPerMonth: 10_000_000,
      logRetentionDays: 30,
    },
    overage: {
      api_requests: { unitCents: 1, unit: '10k requests' },
      bandwidth_mb: { unitCents: 8, unit: 'GB' },
      ai_tokens: { unitCents: 60, unit: '1M tokens' },
      function_invocations: { unitCents: 20, unit: '1M invocations' },
    },
  },
  business: {
    id: 'business',
    name: 'Business',
    description: 'For teams with compliance needs and higher scale.',
    priceCents: 9_900,
    currency: 'USD',
    trialDays: 14,
    limits: {
      projects: 50,
      teamMembers: 50,
      apiKeysPerProject: 100,
      databaseStorageMbPerDb: 51_200,
      apiRequestsPerMonth: 50_000_000,
      bandwidthMbPerMonth: 1_024_000,
      storageMb: 262_144,
      storageFiles: 2_500_000,
      storageBuckets: 100,
      realtimeConnections: 10_000,
      realtimeMessagesPerMonth: 250_000_000,
      functionInvocationsPerMonth: 25_000_000,
      functionGbSecondsPerMonth: 10_000_000,
      functionsPerProject: 200,
      jobsPerMonth: 250_000,
      aiRequestsPerMonth: 50_000,
      aiTokensPerMonth: 100_000_000,
      logRetentionDays: 90,
    },
    overage: {
      api_requests: { unitCents: 1, unit: '10k requests' },
      bandwidth_mb: { unitCents: 6, unit: 'GB' },
      ai_tokens: { unitCents: 50, unit: '1M tokens' },
      function_invocations: { unitCents: 15, unit: '1M invocations' },
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Negotiated limits, SSO, audit exports, and support.',
    priceCents: null,
    currency: 'USD',
    trialDays: 30,
    limits: {
      projects: UNLIMITED,
      teamMembers: UNLIMITED,
      apiKeysPerProject: UNLIMITED,
      databaseStorageMbPerDb: UNLIMITED,
      apiRequestsPerMonth: UNLIMITED,
      bandwidthMbPerMonth: UNLIMITED,
      storageMb: UNLIMITED,
      storageFiles: UNLIMITED,
      storageBuckets: UNLIMITED,
      realtimeConnections: UNLIMITED,
      realtimeMessagesPerMonth: UNLIMITED,
      functionInvocationsPerMonth: UNLIMITED,
      functionGbSecondsPerMonth: UNLIMITED,
      functionsPerProject: UNLIMITED,
      jobsPerMonth: UNLIMITED,
      aiRequestsPerMonth: UNLIMITED,
      aiTokensPerMonth: UNLIMITED,
      logRetentionDays: 365,
    },
    overage: {},
  },
};

export function getPlan(planId: string): PlanDefinition {
  const plan = (PLANS as Record<string, PlanDefinition>)[planId];
  if (!plan) throw new Error(`Unknown plan: ${String(planId).slice(0, 40)}`);
  return plan;
}

/** Public plan comparison (limits + prices only — safe for dashboards). */
export function listPlans(): Pick<PlanDefinition, 'id' | 'name' | 'description' | 'priceCents' | 'currency' | 'trialDays' | 'limits'>[] {
  return (Object.keys(PLANS) as PlanId[]).map(id => {
    const p = PLANS[id] as PlanDefinition;
    return { id: p.id, name: p.name, description: p.description, priceCents: p.priceCents, currency: p.currency, trialDays: p.trialDays, limits: p.limits };
  });
}

/** Which plan limit backs a (service, metric) pair, if any. */
export function limitKeyFor(
  service: UsageService,
  metric: UsageMetric,
): keyof PlanDefinition['limits'] | null {
  const map: Partial<Record<UsageMetric, keyof PlanDefinition['limits']>> = {
    api_requests: 'apiRequestsPerMonth',
    api_bandwidth_bytes: 'bandwidthMbPerMonth',
    db_storage_bytes: 'databaseStorageMbPerDb',
    storage_bytes: 'storageMb',
    storage_files: 'storageFiles',
    realtime_connections: 'realtimeConnections',
    realtime_messages: 'realtimeMessagesPerMonth',
    function_invocations: 'functionInvocationsPerMonth',
    function_gb_seconds: 'functionGbSecondsPerMonth',
    ai_requests: 'aiRequestsPerMonth',
    ai_tokens: 'aiTokensPerMonth',
    projects: 'projects',
    team_members: 'teamMembers',
    api_keys: 'apiKeysPerProject',
    jobs: 'jobsPerMonth',
  };
  return map[metric] ?? null;
}

/**
 * Convert a raw usage total into plan-limit units. Byte-denominated limits
 * are configured in MB; everything else counts 1:1.
 */
export function toLimitUnits(metric: UsageMetric, total: number): number {
  switch (metric) {
    case 'api_bandwidth_bytes':
    case 'db_storage_bytes':
    case 'storage_bytes':
      return total / (1024 * 1024);
    default:
      return total;
  }
}
