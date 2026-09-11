/**
 * Automation domain: per-project queues, cron schedules, and outbound
 * webhooks. All three are tenant-scoped (organization → project), audited
 * by the API layer, and enforceable by agent scopes (`automation.read`,
 * `automation.write`).
 */

export class AutomationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.status = status;
  }
}

// ── Queues ────────────────────────────────────────────────

export type QueueMessageStatus = 'queued' | 'leased' | 'acked' | 'dead';

export interface Queue {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  /** Deliveries before a message moves to the dead-letter set. */
  maxDeliveries: number;
  createdAt: string;
}

export interface QueueMessage {
  id: string;
  queueId: string;
  organizationId: string;
  projectId: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  status: QueueMessageStatus;
  deliveries: number;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExposedMessage = Omit<QueueMessage, never>;

// ── Schedules (cron → function) ───────────────────────────

export interface Schedule {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  /** Function slug to invoke. */
  functionSlug: string;
  /** Five-field cron expression, UTC. */
  cron: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Webhooks (outbound) ───────────────────────────────────

export type WebhookEventType =
  | 'job.completed'
  | 'job.failed'
  | 'function.deployed'
  | 'function.invoked'
  | 'ai.plan.applied'
  | 'project.deleted';

export const WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  'job.completed',
  'job.failed',
  'function.deployed',
  'function.invoked',
  'ai.plan.applied',
  'project.deleted',
];

export function isWebhookEvent(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export interface Webhook {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  secretPrefix: string;
  /** sha256 of the raw `whsec_` secret — the raw value is shown once. */
  secretHash: string;
  enabled: boolean;
  /** Max delivery attempts before a delivery is marked failed (dead). */
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export type ExposedWebhook = Omit<Webhook, 'secretHash'>;

export type DeliveryStatus = 'pending' | 'sending' | 'succeeded' | 'failed';

export interface DeliveryAttempt {
  at: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  latencyMs: number;
}

export interface Delivery {
  id: string;
  webhookId: string;
  organizationId: string;
  projectId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: DeliveryAttempt[];
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEvent {
  type: WebhookEventType;
  organizationId: string;
  projectId: string;
  payload: Record<string, unknown>;
}
