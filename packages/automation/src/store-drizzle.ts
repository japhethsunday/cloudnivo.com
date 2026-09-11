import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import {
  automationDeliveries,
  automationMessages,
  automationQueues,
  automationSchedules,
  automationWebhooks,
  type Database,
} from '@cloudnivo/database';
import type { AutomationStore } from './store.js';
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Queue,
  QueueMessage,
  QueueMessageStatus,
  Schedule,
  Webhook,
} from './types.js';

/** Drizzle-backed automation store. Same contract as the memory store. */

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function asAttempts(value: unknown): DeliveryAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (x): x is DeliveryAttempt => typeof x === 'object' && x !== null && typeof (x as DeliveryAttempt).at === 'string',
  );
}

function rowToQueue(r: typeof automationQueues.$inferSelect): Queue {
  return {
    id: r.id,
    organizationId: r.organizationId,
    projectId: r.projectId,
    name: r.name,
    maxDeliveries: r.maxDeliveries ?? 5,
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
  };
}

function rowToMessage(r: typeof automationMessages.$inferSelect): QueueMessage {
  return {
    id: r.id,
    queueId: r.queueId,
    organizationId: r.organizationId,
    projectId: r.projectId,
    body: asRecord(r.body),
    idempotencyKey: r.idempotencyKey,
    status: (r.status ?? 'queued') as QueueMessageStatus,
    deliveries: r.deliveries ?? 0,
    leaseExpiresAt: iso(r.leaseExpiresAt),
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(r.updatedAt) ?? new Date().toISOString(),
  };
}

function rowToSchedule(r: typeof automationSchedules.$inferSelect): Schedule {
  return {
    id: r.id,
    organizationId: r.organizationId,
    projectId: r.projectId,
    name: r.name,
    functionSlug: r.functionSlug,
    cron: r.cron,
    payload: asRecord(r.payload),
    enabled: r.enabled ?? true,
    nextRunAt: iso(r.nextRunAt),
    lastRunAt: iso(r.lastRunAt),
    lastStatus: r.lastStatus,
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(r.updatedAt) ?? new Date().toISOString(),
  };
}

function rowToWebhook(r: typeof automationWebhooks.$inferSelect): Webhook {
  return {
    id: r.id,
    organizationId: r.organizationId,
    projectId: r.projectId,
    name: r.name,
    url: r.url,
    eventTypes: asStrings(r.eventTypes) as Webhook['eventTypes'],
    secretPrefix: r.secretPrefix,
    secretHash: r.secretHash,
    enabled: r.enabled ?? true,
    maxAttempts: r.maxAttempts ?? 6,
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(r.updatedAt) ?? new Date().toISOString(),
  };
}

function rowToDelivery(r: typeof automationDeliveries.$inferSelect): Delivery {
  return {
    id: r.id,
    webhookId: r.webhookId,
    organizationId: r.organizationId,
    projectId: r.projectId,
    eventType: r.eventType as Delivery['eventType'],
    payload: asRecord(r.payload),
    status: (r.status ?? 'pending') as DeliveryStatus,
    attempts: asAttempts(r.attempts),
    nextAttemptAt: iso(r.nextAttemptAt),
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(r.updatedAt) ?? new Date().toISOString(),
  };
}

export class DrizzleAutomationStore implements AutomationStore {
  constructor(private readonly db: Database) {}

  async createQueue(input: { organizationId: string; projectId: string; name: string; maxDeliveries: number }): Promise<Queue> {
    const [row] = await this.db.insert(automationQueues).values(input).returning();
    if (!row) throw new Error('Queue insert failed');
    return rowToQueue(row);
  }

  async listQueues(projectId: string): Promise<Queue[]> {
    const rows = await this.db.select().from(automationQueues).where(eq(automationQueues.projectId, projectId));
    return rows.map(rowToQueue);
  }

  async getQueue(id: string): Promise<Queue | null> {
    const rows = await this.db.select().from(automationQueues).where(eq(automationQueues.id, id)).limit(1);
    return rows[0] ? rowToQueue(rows[0]) : null;
  }

  async deleteQueue(id: string): Promise<boolean> {
    await this.db.delete(automationMessages).where(eq(automationMessages.queueId, id));
    const rows = await this.db.delete(automationQueues).where(eq(automationQueues.id, id)).returning({ id: automationQueues.id });
    return rows.length > 0;
  }

  async publish(input: { queue: Queue; body: Record<string, unknown>; idempotencyKey: string | null }): Promise<{ message: QueueMessage; duplicate: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select()
        .from(automationMessages)
        .where(
          and(
            eq(automationMessages.queueId, input.queue.id),
            eq(automationMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const open = existing[0] && existing[0].status !== 'acked' ? existing[0] : null;
      if (open) return { message: rowToMessage(open), duplicate: true };
    }
    const [row] = await this.db
      .insert(automationMessages)
      .values({
        queueId: input.queue.id,
        organizationId: input.queue.organizationId,
        projectId: input.queue.projectId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    if (!row) throw new Error('Message insert failed');
    return { message: rowToMessage(row), duplicate: false };
  }

  async consume(queueId: string, limit: number, leaseMs: number, now: Date): Promise<QueueMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    // Claim expired leases and fresh rows in one pass (bounded, single statement per row).
    const rows = await this.db
      .update(automationMessages)
      .set({
        status: 'leased',
        deliveries: sql`${automationMessages.deliveries} + 1`,
        leaseExpiresAt: new Date(leaseUntil),
        updatedAt: now,
      })
      .where(
        and(
          eq(automationMessages.queueId, queueId),
          sql`(${automationMessages.status} = 'queued' OR (${automationMessages.status} = 'leased' AND ${automationMessages.leaseExpiresAt} <= ${now}))`,
        ),
      )
      .returning();
    return rows.slice(0, limit).map(rowToMessage);
  }

  async ack(messageId: string): Promise<QueueMessage | null> {
    const rows = await this.db
      .update(automationMessages)
      .set({ status: 'acked', leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(automationMessages.id, messageId))
      .returning();
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  async nack(messageId: string, requeue: boolean): Promise<QueueMessage | null> {
    const current = await this.db.select().from(automationMessages).where(eq(automationMessages.id, messageId)).limit(1);
    const row = current[0];
    if (!row) return null;
    const queue = await this.getQueue(row.queueId);
    const max = queue?.maxDeliveries ?? 5;
    const status: QueueMessageStatus = !requeue || (row.deliveries ?? 0) >= max ? 'dead' : 'queued';
    const rows = await this.db
      .update(automationMessages)
      .set({ status, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(automationMessages.id, messageId))
      .returning();
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  async setMessageStatus(id: string, status: QueueMessageStatus, leaseExpiresAt: string | null): Promise<QueueMessage | null> {
    const rows = await this.db
      .update(automationMessages)
      .set({ status, leaseExpiresAt: leaseExpiresAt ? new Date(leaseExpiresAt) : null, updatedAt: new Date() })
      .where(eq(automationMessages.id, id))
      .returning();
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  async listMessages(queueId: string, status: QueueMessageStatus | null, limit: number): Promise<QueueMessage[]> {
    const rows = await this.db
      .select()
      .from(automationMessages)
      .where(
        status === null
          ? eq(automationMessages.queueId, queueId)
          : and(eq(automationMessages.queueId, queueId), eq(automationMessages.status, status)),
      )
      .orderBy(asc(automationMessages.createdAt))
      .limit(limit);
    return rows.map(rowToMessage);
  }

  async queueDepth(queueId: string): Promise<{ queued: number; leased: number; dead: number }> {
    const rows = await this.db
      .select({ status: automationMessages.status })
      .from(automationMessages)
      .where(eq(automationMessages.queueId, queueId));
    let queued = 0;
    let leased = 0;
    let dead = 0;
    for (const r of rows) {
      if (r.status === 'queued') queued += 1;
      else if (r.status === 'leased') leased += 1;
      else if (r.status === 'dead') dead += 1;
    }
    return { queued, leased, dead };
  }

  async purgeMessages(queueId: string, statuses: QueueMessageStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const rows = await this.db
      .delete(automationMessages)
      .where(
        and(
          eq(automationMessages.queueId, queueId),
          sql`${automationMessages.status} IN (${sql.join(statuses.map(s => sql`${s}`), sql`, `)})`,
        ),
      )
      .returning({ id: automationMessages.id });
    return rows.length;
  }

  async createSchedule(input: {
    organizationId: string;
    projectId: string;
    name: string;
    functionSlug: string;
    cron: string;
    payload: Record<string, unknown>;
    nextRunAt: string | null;
  }): Promise<Schedule> {
    const [row] = await this.db
      .insert(automationSchedules)
      .values({ ...input, payload: input.payload, nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : null })
      .returning();
    if (!row) throw new Error('Schedule insert failed');
    return rowToSchedule(row);
  }

  async listSchedules(projectId: string): Promise<Schedule[]> {
    const rows = await this.db.select().from(automationSchedules).where(eq(automationSchedules.projectId, projectId));
    return rows.map(rowToSchedule);
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    const rows = await this.db.select().from(automationSchedules).where(eq(automationSchedules.id, id)).limit(1);
    return rows[0] ? rowToSchedule(rows[0]) : null;
  }

  async updateSchedule(id: string, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'payload' | 'enabled' | 'nextRunAt'>>): Promise<Schedule | null> {
    const rows = await this.db
      .update(automationSchedules)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt ? new Date(patch.nextRunAt) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(automationSchedules.id, id))
      .returning();
    return rows[0] ? rowToSchedule(rows[0]) : null;
  }

  async markScheduleRun(id: string, at: string, status: string, nextRunAt: string | null): Promise<Schedule | null> {
    const rows = await this.db
      .update(automationSchedules)
      .set({ lastRunAt: new Date(at), lastStatus: status, nextRunAt: nextRunAt ? new Date(nextRunAt) : null, updatedAt: new Date() })
      .where(eq(automationSchedules.id, id))
      .returning();
    return rows[0] ? rowToSchedule(rows[0]) : null;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const rows = await this.db.delete(automationSchedules).where(eq(automationSchedules.id, id)).returning({ id: automationSchedules.id });
    return rows.length > 0;
  }

  async dueSchedules(now: Date, limit: number): Promise<Schedule[]> {
    const rows = await this.db
      .select()
      .from(automationSchedules)
      .where(and(eq(automationSchedules.enabled, true), lte(automationSchedules.nextRunAt, now)))
      .orderBy(asc(automationSchedules.nextRunAt))
      .limit(limit);
    return rows.map(rowToSchedule);
  }

  async createWebhook(input: {
    organizationId: string;
    projectId: string;
    name: string;
    url: string;
    eventTypes: string[];
    secretPrefix: string;
    secretHash: string;
    maxAttempts: number;
  }): Promise<Webhook> {
    const [row] = await this.db.insert(automationWebhooks).values({ ...input, eventTypes: input.eventTypes }).returning();
    if (!row) throw new Error('Webhook insert failed');
    return rowToWebhook(row);
  }

  async listWebhooks(projectId: string): Promise<Webhook[]> {
    const rows = await this.db.select().from(automationWebhooks).where(eq(automationWebhooks.projectId, projectId));
    return rows.map(rowToWebhook);
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const rows = await this.db.select().from(automationWebhooks).where(eq(automationWebhooks.id, id)).limit(1);
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async updateWebhook(id: string, patch: Partial<Pick<Webhook, 'name' | 'url' | 'eventTypes' | 'enabled' | 'maxAttempts'>>): Promise<Webhook | null> {
    const rows = await this.db
      .update(automationWebhooks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(automationWebhooks.id, id))
      .returning();
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async rotateSecret(id: string, secretPrefix: string, secretHash: string): Promise<Webhook | null> {
    const rows = await this.db
      .update(automationWebhooks)
      .set({ secretPrefix, secretHash, updatedAt: new Date() })
      .where(eq(automationWebhooks.id, id))
      .returning();
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async deleteWebhook(id: string): Promise<boolean> {
    await this.db.delete(automationDeliveries).where(eq(automationDeliveries.webhookId, id));
    const rows = await this.db.delete(automationWebhooks).where(eq(automationWebhooks.id, id)).returning({ id: automationWebhooks.id });
    return rows.length > 0;
  }

  async createDelivery(input: {
    webhookId: string;
    organizationId: string;
    projectId: string;
    eventType: string;
    payload: Record<string, unknown>;
    nextAttemptAt: string | null;
  }): Promise<Delivery> {
    const [row] = await this.db
      .insert(automationDeliveries)
      .values({ ...input, payload: input.payload, attempts: [], nextAttemptAt: input.nextAttemptAt ? new Date(input.nextAttemptAt) : null })
      .returning();
    if (!row) throw new Error('Delivery insert failed');
    return rowToDelivery(row);
  }

  async getDelivery(id: string): Promise<Delivery | null> {
    const rows = await this.db.select().from(automationDeliveries).where(eq(automationDeliveries.id, id)).limit(1);
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async listDeliveries(webhookId: string, status: DeliveryStatus | null, limit: number): Promise<Delivery[]> {
    const rows = await this.db
      .select()
      .from(automationDeliveries)
      .where(
        status === null
          ? eq(automationDeliveries.webhookId, webhookId)
          : and(eq(automationDeliveries.webhookId, webhookId), eq(automationDeliveries.status, status)),
      )
      .orderBy(desc(automationDeliveries.createdAt))
      .limit(limit);
    return rows.map(rowToDelivery);
  }

  async updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'attempts' | 'nextAttemptAt'>>): Promise<Delivery | null> {
    const rows = await this.db
      .update(automationDeliveries)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.nextAttemptAt !== undefined ? { nextAttemptAt: patch.nextAttemptAt ? new Date(patch.nextAttemptAt) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(automationDeliveries.id, id))
      .returning();
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async dueDeliveries(now: Date, limit: number): Promise<Delivery[]> {
    const rows = await this.db
      .select()
      .from(automationDeliveries)
      .where(
        and(
          sql`${automationDeliveries.status} IN ('pending', 'sending')`,
          lte(automationDeliveries.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(automationDeliveries.nextAttemptAt))
      .limit(limit);
    return rows.map(rowToDelivery);
  }
}
