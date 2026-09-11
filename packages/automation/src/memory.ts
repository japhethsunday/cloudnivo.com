import { randomUUID } from 'node:crypto';
import type {
  AutomationStore,
} from './store.js';
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

/** In-memory automation store (dev/test). No cross-tenant leakage: every lookup filters by id AND scope. */
export class MemoryAutomationStore implements AutomationStore {
  private readonly queues = new Map<string, Queue>();
  private readonly messages = new Map<string, QueueMessage>();
  private readonly schedules = new Map<string, Schedule>();
  private readonly webhooks = new Map<string, Webhook>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // ── Queues ──

  async createQueue(input: { organizationId: string; projectId: string; name: string; maxDeliveries: number }): Promise<Queue> {
    const q: Queue = { id: randomUUID(), createdAt: this.stamp(), ...input };
    this.queues.set(q.id, q);
    return { ...q };
  }

  async listQueues(projectId: string): Promise<Queue[]> {
    return [...this.queues.values()].filter(q => q.projectId === projectId).map(q => ({ ...q }));
  }

  async getQueue(id: string): Promise<Queue | null> {
    const q = this.queues.get(id);
    return q ? { ...q } : null;
  }

  async deleteQueue(id: string): Promise<boolean> {
    for (const [mid, m] of this.messages) {
      if (m.queueId === id) this.messages.delete(mid);
    }
    return this.queues.delete(id);
  }

  async publish(input: { queue: Queue; body: Record<string, unknown>; idempotencyKey: string | null }): Promise<{ message: QueueMessage; duplicate: boolean }> {
    if (input.idempotencyKey) {
      for (const m of this.messages.values()) {
        if (m.queueId === input.queue.id && m.idempotencyKey === input.idempotencyKey && m.status !== 'acked') {
          return { message: { ...m }, duplicate: true };
        }
      }
    }
    const at = this.stamp();
    const m: QueueMessage = {
      id: randomUUID(),
      queueId: input.queue.id,
      organizationId: input.queue.organizationId,
      projectId: input.queue.projectId,
      body: { ...input.body },
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      deliveries: 0,
      leaseExpiresAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.messages.set(m.id, m);
    return { message: { ...m }, duplicate: false };
  }

  async consume(queueId: string, limit: number, leaseMs: number, now: Date): Promise<QueueMessage[]> {
    const out: QueueMessage[] = [];
    const expired = (m: QueueMessage): boolean =>
      m.status === 'leased' && m.leaseExpiresAt !== null && Date.parse(m.leaseExpiresAt) <= now.getTime();
    for (const m of this.messages.values()) {
      if (out.length >= limit) break;
      if (m.queueId !== queueId) continue;
      if (m.status !== 'queued' && !expired(m)) continue;
      m.status = 'leased';
      m.deliveries += 1;
      m.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      m.updatedAt = now.toISOString();
      out.push({ ...m, body: { ...m.body } });
    }
    return out;
  }

  async ack(messageId: string): Promise<QueueMessage | null> {
    const m = this.messages.get(messageId);
    if (!m) return null;
    m.status = 'acked';
    m.leaseExpiresAt = null;
    m.updatedAt = this.stamp();
    return { ...m, body: { ...m.body } };
  }

  async nack(messageId: string, requeue: boolean): Promise<QueueMessage | null> {
    const m = this.messages.get(messageId);
    if (!m) return null;
    const queue = this.queues.get(m.queueId);
    const max = queue?.maxDeliveries ?? 5;
    if (!requeue || m.deliveries >= max) {
      m.status = 'dead';
    } else {
      m.status = 'queued';
    }
    m.leaseExpiresAt = null;
    m.updatedAt = this.stamp();
    return { ...m, body: { ...m.body } };
  }

  async setMessageStatus(id: string, status: QueueMessageStatus, leaseExpiresAt: string | null): Promise<QueueMessage | null> {
    const m = this.messages.get(id);
    if (!m) return null;
    m.status = status;
    m.leaseExpiresAt = leaseExpiresAt;
    m.updatedAt = this.stamp();
    return { ...m, body: { ...m.body } };
  }

  async listMessages(queueId: string, status: QueueMessageStatus | null, limit: number): Promise<QueueMessage[]> {
    return [...this.messages.values()]
      .filter(m => m.queueId === queueId && (status === null || m.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(m => ({ ...m, body: { ...m.body } }));
  }

  async purgeMessages(queueId: string, statuses: QueueMessageStatus[]): Promise<number> {
    const set = new Set(statuses);
    let n = 0;
    for (const [mid, m] of this.messages) {
      if (m.queueId === queueId && set.has(m.status)) {
        this.messages.delete(mid);
        n += 1;
      }
    }
    return n;
  }

  async queueDepth(queueId: string): Promise<{ queued: number; leased: number; dead: number }> {
    let queued = 0;
    let leased = 0;
    let dead = 0;
    for (const m of this.messages.values()) {
      if (m.queueId !== queueId || m.status === 'acked') continue;
      if (m.status === 'queued') queued += 1;
      else if (m.status === 'leased') leased += 1;
      else dead += 1;
    }
    return { queued, leased, dead };
  }

  // ── Schedules ──

  async createSchedule(input: {
    organizationId: string;
    projectId: string;
    name: string;
    functionSlug: string;
    cron: string;
    payload: Record<string, unknown>;
    nextRunAt: string | null;
  }): Promise<Schedule> {
    const at = this.stamp();
    const s: Schedule = {
      id: randomUUID(),
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      createdAt: at,
      updatedAt: at,
      ...input,
    };
    this.schedules.set(s.id, s);
    return { ...s, payload: { ...s.payload } };
  }

  async listSchedules(projectId: string): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter(s => s.projectId === projectId)
      .map(s => ({ ...s, payload: { ...s.payload } }));
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    return s ? { ...s, payload: { ...s.payload } } : null;
  }

  async updateSchedule(id: string, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'payload' | 'enabled' | 'nextRunAt'>>): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: this.stamp() });
    return { ...s, payload: { ...s.payload } };
  }

  async markScheduleRun(id: string, at: string, status: string, nextRunAt: string | null): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    if (!s) return null;
    s.lastRunAt = at;
    s.lastStatus = status;
    s.nextRunAt = nextRunAt;
    s.updatedAt = this.stamp();
    return { ...s, payload: { ...s.payload } };
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.schedules.delete(id);
  }

  async dueSchedules(now: Date, limit: number): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter(s => s.enabled && s.nextRunAt !== null && Date.parse(s.nextRunAt) <= now.getTime())
      .sort((a, b) => (a.nextRunAt as string) < (b.nextRunAt as string) ? -1 : 1)
      .slice(0, limit)
      .map(s => ({ ...s, payload: { ...s.payload } }));
  }

  // ── Webhooks ──

  async createWebhook(input: {
    organizationId: string;
    projectId: string;
    name: string;
    url: string;
    eventTypes: WebhookEventType[];
    secretPrefix: string;
    secretHash: string;
    maxAttempts: number;
  }): Promise<Webhook> {
    const at = this.stamp();
    const w: Webhook = { id: randomUUID(), enabled: true, createdAt: at, updatedAt: at, ...input };
    this.webhooks.set(w.id, w);
    return { ...w, eventTypes: [...w.eventTypes] };
  }

  async listWebhooks(projectId: string): Promise<Webhook[]> {
    return [...this.webhooks.values()]
      .filter(w => w.projectId === projectId)
      .map(w => ({ ...w, eventTypes: [...w.eventTypes] }));
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const w = this.webhooks.get(id);
    return w ? { ...w, eventTypes: [...w.eventTypes] } : null;
  }

  async updateWebhook(id: string, patch: Partial<Pick<Webhook, 'name' | 'url' | 'eventTypes' | 'enabled' | 'maxAttempts'>>): Promise<Webhook | null> {
    const w = this.webhooks.get(id);
    if (!w) return null;
    Object.assign(w, patch, { updatedAt: this.stamp() });
    return { ...w, eventTypes: [...w.eventTypes] };
  }

  async rotateSecret(id: string, secretPrefix: string, secretHash: string): Promise<Webhook | null> {
    const w = this.webhooks.get(id);
    if (!w) return null;
    w.secretPrefix = secretPrefix;
    w.secretHash = secretHash;
    w.updatedAt = this.stamp();
    return { ...w, eventTypes: [...w.eventTypes] };
  }

  async deleteWebhook(id: string): Promise<boolean> {
    for (const [did, d] of this.deliveries) {
      if (d.webhookId === id) this.deliveries.delete(did);
    }
    return this.webhooks.delete(id);
  }

  async createDelivery(input: {
    webhookId: string;
    organizationId: string;
    projectId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
    nextAttemptAt: string | null;
  }): Promise<Delivery> {
    const at = this.stamp();
    const d: Delivery = {
      id: randomUUID(),
      status: 'pending',
      attempts: [],
      createdAt: at,
      updatedAt: at,
      ...input,
    };
    this.deliveries.set(d.id, d);
    return { ...d, payload: { ...d.payload }, attempts: [...d.attempts] };
  }

  async getDelivery(id: string): Promise<Delivery | null> {
    const d = this.deliveries.get(id);
    return d ? { ...d, payload: { ...d.payload }, attempts: [...d.attempts] } : null;
  }

  async listDeliveries(webhookId: string, status: DeliveryStatus | null, limit: number): Promise<Delivery[]> {
    return [...this.deliveries.values()]
      .filter(d => d.webhookId === webhookId && (status === null || d.status === status))
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map(d => ({ ...d, payload: { ...d.payload }, attempts: [...d.attempts] }));
  }

  async updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'attempts' | 'nextAttemptAt'>>): Promise<Delivery | null> {
    const d = this.deliveries.get(id);
    if (!d) return null;
    Object.assign(d, patch, { updatedAt: this.stamp() });
    return { ...d, payload: { ...d.payload }, attempts: [...d.attempts] };
  }

  async dueDeliveries(now: Date, limit: number): Promise<Delivery[]> {
    return [...this.deliveries.values()]
      .filter(
        d =>
          (d.status === 'pending' || d.status === 'sending') &&
          d.nextAttemptAt !== null &&
          Date.parse(d.nextAttemptAt) <= now.getTime(),
      )
      .sort((a, b) => (a.nextAttemptAt as string) < (b.nextAttemptAt as string) ? -1 : 1)
      .slice(0, limit)
      .map(d => ({ ...d, payload: { ...d.payload }, attempts: [...d.attempts] }));
  }
}
