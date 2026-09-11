import type {
  Delivery,
  DeliveryStatus,
  Queue,
  QueueMessage,
  QueueMessageStatus,
  Schedule,
  Webhook,
  WebhookEventType,
} from './types.js';

/**
 * Automation store contract. Memory (dev/test) and Drizzle (durable)
 * implementations share it; the service owns validation and orchestration.
 */
export interface AutomationStore {
  // ── Queues ──
  createQueue(input: { organizationId: string; projectId: string; name: string; maxDeliveries: number }): Promise<Queue>;
  listQueues(projectId: string): Promise<Queue[]>;
  getQueue(id: string): Promise<Queue | null>;
  deleteQueue(id: string): Promise<boolean>;
  publish(input: {
    queue: Queue;
    body: Record<string, unknown>;
    idempotencyKey: string | null;
  }): Promise<{ message: QueueMessage; duplicate: boolean }>;
  consume(queueId: string, limit: number, leaseMs: number, now: Date): Promise<QueueMessage[]>;
  ack(messageId: string): Promise<QueueMessage | null>;
  nack(messageId: string, requeue: boolean): Promise<QueueMessage | null>;
  setMessageStatus(id: string, status: QueueMessageStatus, leaseExpiresAt: string | null): Promise<QueueMessage | null>;
  listMessages(queueId: string, status: QueueMessageStatus | null, limit: number): Promise<QueueMessage[]>;
  purgeMessages(queueId: string, statuses: QueueMessageStatus[]): Promise<number>;
  queueDepth(queueId: string): Promise<{ queued: number; leased: number; dead: number }>;

  // ── Schedules ──
  createSchedule(input: {
    organizationId: string;
    projectId: string;
    name: string;
    functionSlug: string;
    cron: string;
    payload: Record<string, unknown>;
    nextRunAt: string | null;
  }): Promise<Schedule>;
  listSchedules(projectId: string): Promise<Schedule[]>;
  getSchedule(id: string): Promise<Schedule | null>;
  updateSchedule(id: string, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'payload' | 'enabled' | 'nextRunAt'>>): Promise<Schedule | null>;
  markScheduleRun(id: string, at: string, status: string, nextRunAt: string | null): Promise<Schedule | null>;
  deleteSchedule(id: string): Promise<boolean>;
  dueSchedules(now: Date, limit: number): Promise<Schedule[]>;

  // ── Webhooks ──
  createWebhook(input: {
    organizationId: string;
    projectId: string;
    name: string;
    url: string;
    eventTypes: WebhookEventType[];
    secretPrefix: string;
    secretHash: string;
    maxAttempts: number;
  }): Promise<Webhook>;
  listWebhooks(projectId: string): Promise<Webhook[]>;
  getWebhook(id: string): Promise<Webhook | null>;
  updateWebhook(id: string, patch: Partial<Pick<Webhook, 'name' | 'url' | 'eventTypes' | 'enabled' | 'maxAttempts'>>): Promise<Webhook | null>;
  rotateSecret(id: string, secretPrefix: string, secretHash: string): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;
  createDelivery(input: {
    webhookId: string;
    organizationId: string;
    projectId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
    nextAttemptAt: string | null;
  }): Promise<Delivery>;
  getDelivery(id: string): Promise<Delivery | null>;
  listDeliveries(webhookId: string, status: DeliveryStatus | null, limit: number): Promise<Delivery[]>;
  updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'attempts' | 'nextAttemptAt'>>): Promise<Delivery | null>;
  dueDeliveries(now: Date, limit: number): Promise<Delivery[]>;
}
