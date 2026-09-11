import { nextRunFor, parseCron } from './cron.js';
import { backoffMs, createWebhookSecret, signPayload } from './signing.js';
import type { AutomationStore } from './store.js';
import {
  AutomationError,
  isWebhookEvent,
  type Delivery,
  type DeliveryAttempt,
  type ExposedWebhook,
  type ProjectEvent,
  type Queue,
  type QueueMessage,
  type QueueMessageStatus,
  type Schedule,
  type Webhook,
} from './types.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const MAX_BODY_BYTES = 256_000;
const MAX_IMPORT_PAYLOAD = 64;

function assertName(name: string, what: string): void {
  if (!NAME_RE.test(name)) {
    throw new AutomationError('VALIDATION_ERROR', `${what} name must be 1-64 chars: letters, numbers, space, _ . -`, 400);
  }
}

function assertUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AutomationError('VALIDATION_ERROR', 'Webhook URL must be absolute http(s)', 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AutomationError('VALIDATION_ERROR', 'Webhook URL must be absolute http(s)', 400);
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    throw new AutomationError(
      'VALIDATION_ERROR',
      'Webhook URL must be publicly reachable (loopback blocked to prevent SSRF)',
      400,
    );
  }
  return parsed;
}

function assertBodySize(body: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new AutomationError('PAYLOAD_TOO_LARGE', `Message body exceeds ${MAX_BODY_BYTES} bytes`, 413);
  }
}

export interface DeliverFn {
  (url: string, payloadBytes: string, headers: Record<string, string>): Promise<{
    ok: boolean;
    status: number | null;
    error: string | null;
    latencyMs: number;
  }>;
}

export interface InvokeFn {
  (projectId: string, functionSlug: string, payload: Record<string, unknown>): Promise<{
    ok: boolean;
    error: string | null;
  }>;
}

export function exposeWebhook(w: Webhook): ExposedWebhook {
  const { secretHash: _dropped, ...rest } = w;
  void _dropped;
  return { ...rest, eventTypes: [...rest.eventTypes] };
}

/**
 * Automation orchestration. Owns validation, cron computation, webhook
 * fan-out, delivery retries, and schedule firing. Project existence and
 * membership are verified by the API layer; every method here also takes
 * explicit tenant ids so a wrong id can never cross scopes.
 */
export class AutomationService {
  constructor(
    private readonly store: AutomationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get storeRef(): AutomationStore {
    return this.store;
  }

  // ── Queues ──

  async createQueue(organizationId: string, projectId: string, input: { name: string; maxDeliveries?: number }): Promise<Queue> {
    assertName(input.name, 'Queue');
    const maxDeliveries = input.maxDeliveries ?? 5;
    if (!Number.isInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 25) {
      throw new AutomationError('VALIDATION_ERROR', 'maxDeliveries must be an integer 1-25', 400);
    }
    const existing = await this.store.listQueues(projectId);
    if (existing.some(q => q.name === input.name)) {
      throw new AutomationError('CONFLICT', `Queue "${input.name}" already exists`, 409);
    }
    return this.store.createQueue({ organizationId, projectId, name: input.name, maxDeliveries });
  }

  async publish(
    queue: Queue,
    input: { body: Record<string, unknown>; idempotencyKey?: string },
  ): Promise<{ message: QueueMessage; duplicate: boolean }> {
    if (typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) {
      throw new AutomationError('VALIDATION_ERROR', 'Message body must be a JSON object', 400);
    }
    assertBodySize(input.body);
    const key = input.idempotencyKey?.trim() || null;
    if (key !== null && (key.length > 128 || !/^[A-Za-z0-9 _.:-]{1,128}$/.test(key))) {
      throw new AutomationError('VALIDATION_ERROR', 'idempotencyKey must be 1-128 chars', 400);
    }
    return this.store.publish({ queue, body: input.body, idempotencyKey: key });
  }

  async consume(queue: Queue, limit: number, leaseMs: number): Promise<QueueMessage[]> {
    const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 25);
    const lease = Math.min(Math.max(leaseMs, 1000), 3_600_000);
    return this.store.consume(queue.id, n, lease, this.now());
  }

  async ack(queue: Queue, messageId: string): Promise<QueueMessage> {
    const m = await this.scopedMessage(queue, messageId);
    const acked = await this.store.ack(m.id);
    if (!acked) throw new AutomationError('NOT_FOUND', 'Message not found', 404);
    return acked;
  }

  /** Delete terminal messages (acked/dead). Returns the removed count. */
  async purge(queue: Queue, statuses: QueueMessageStatus[]): Promise<{ purged: number }> {
    const allowed = statuses.filter(s => s === 'acked' || s === 'dead');
    if (allowed.length === 0) {
      throw new AutomationError('VALIDATION_ERROR', 'purge only accepts acked and dead statuses', 400);
    }
    return { purged: await this.store.purgeMessages(queue.id, allowed) };
  }

  async nack(queue: Queue, messageId: string, requeue: boolean): Promise<QueueMessage> {
    const m = await this.scopedMessage(queue, messageId);
    const out = await this.store.nack(m.id, requeue);
    if (!out) throw new AutomationError('NOT_FOUND', 'Message not found', 404);
    return out;
  }

  private async scopedMessage(queue: Queue, messageId: string): Promise<QueueMessage> {
    const all = await this.store.listMessages(queue.id, null, 1000);
    const found = all.find(m => m.id === messageId);
    if (!found) throw new AutomationError('NOT_FOUND', 'Message not found', 404);
    return found;
  }

  // ── Schedules ──

  async createSchedule(
    organizationId: string,
    projectId: string,
    input: { name: string; functionSlug: string; cron: string; payload?: Record<string, unknown> },
  ): Promise<Schedule> {
    assertName(input.name, 'Schedule');
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input.functionSlug)) {
      throw new AutomationError('VALIDATION_ERROR', 'functionSlug must be a valid function slug', 400);
    }
    parseCron(input.cron);
    const payload = input.payload ?? {};
    assertBodySize(payload);
    const existing = await this.store.listSchedules(projectId);
    if (existing.some(s => s.name === input.name)) {
      throw new AutomationError('CONFLICT', `Schedule "${input.name}" already exists`, 409);
    }
    return this.store.createSchedule({
      organizationId,
      projectId,
      name: input.name,
      functionSlug: input.functionSlug,
      cron: input.cron,
      payload,
      nextRunAt: nextRunFor(input.cron, this.now()),
    });
  }

  async updateSchedule(
    schedule: Schedule,
    patch: { name?: string; cron?: string; payload?: Record<string, unknown>; enabled?: boolean },
  ): Promise<Schedule> {
    const update: Parameters<AutomationStore['updateSchedule']>[1] = {};
    if (patch.name !== undefined) {
      assertName(patch.name, 'Schedule');
      update.name = patch.name;
    }
    if (patch.cron !== undefined) {
      parseCron(patch.cron);
      update.cron = patch.cron;
      update.nextRunAt = nextRunFor(patch.cron, this.now());
    }
    if (patch.payload !== undefined) {
      assertBodySize(patch.payload);
      update.payload = patch.payload;
    }
    if (patch.enabled !== undefined) {
      update.enabled = patch.enabled;
      if (patch.enabled && !schedule.nextRunAt) {
        update.nextRunAt = nextRunFor(schedule.cron, this.now());
      }
    }
    const out = await this.store.updateSchedule(schedule.id, update);
    if (!out) throw new AutomationError('NOT_FOUND', 'Schedule not found', 404);
    return out;
  }

  /** Fire due schedules via `invoke`; each result is recorded on the schedule. Returns fired count. */
  async fireDueSchedules(invoke: InvokeFn, limit = 25): Promise<{ fired: number; failed: number }> {
    const now = this.now();
    const due = await this.store.dueSchedules(now, limit);
    let fired = 0;
    let failed = 0;
    for (const s of due) {
      // Advance first so a crashing invoker cannot refire the same schedule.
      const next = nextRunFor(s.cron, new Date(now.getTime() + 1000));
      try {
        const r = await invoke(s.projectId, s.functionSlug, s.payload);
        await this.store.markScheduleRun(s.id, now.toISOString(), r.ok ? 'succeeded' : 'failed', next);
        if (r.ok) fired += 1;
        else failed += 1;
      } catch {
        await this.store.markScheduleRun(s.id, now.toISOString(), 'failed', next);
        failed += 1;
      }
    }
    return { fired, failed };
  }

  // ── Webhooks ──

  async createWebhook(
    organizationId: string,
    projectId: string,
    input: { name: string; url: string; eventTypes: string[]; maxAttempts?: number },
  ): Promise<{ webhook: ExposedWebhook; secret: string }> {
    assertName(input.name, 'Webhook');
    assertUrl(input.url);
    if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
      throw new AutomationError('VALIDATION_ERROR', 'eventTypes must list at least one event', 400);
    }
    const eventTypes = input.eventTypes.map(t => {
      if (!isWebhookEvent(t)) throw new AutomationError('VALIDATION_ERROR', `Unknown event type: ${t}`, 400);
      return t;
    });
    const maxAttempts = input.maxAttempts ?? 6;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new AutomationError('VALIDATION_ERROR', 'maxAttempts must be an integer 1-10', 400);
    }
    const existing = await this.store.listWebhooks(projectId);
    if (existing.some(w => w.name === input.name)) {
      throw new AutomationError('CONFLICT', `Webhook "${input.name}" already exists`, 409);
    }
    if (existing.some(w => w.url === input.url && w.eventTypes.some(t => input.eventTypes.includes(t)))) {
      throw new AutomationError('CONFLICT', 'An overlapping webhook subscription already targets this URL', 409);
    }
    const secret = createWebhookSecret();
    const saved = await this.store.createWebhook({
      organizationId,
      projectId,
      name: input.name,
      url: input.url,
      eventTypes,
      secretPrefix: secret.prefix,
      secretHash: secret.hash,
      maxAttempts,
    });
    return { webhook: exposeWebhook(saved), secret: secret.raw };
  }

  async updateWebhook(
    webhook: Webhook,
    patch: { name?: string; url?: string; eventTypes?: string[]; enabled?: boolean; maxAttempts?: number },
  ): Promise<ExposedWebhook> {
    const update: Parameters<AutomationStore['updateWebhook']>[1] = {};
    if (patch.name !== undefined) {
      assertName(patch.name, 'Webhook');
      update.name = patch.name;
    }
    if (patch.url !== undefined) {
      assertUrl(patch.url);
      update.url = patch.url;
    }
    if (patch.eventTypes !== undefined) {
      if (patch.eventTypes.length === 0) throw new AutomationError('VALIDATION_ERROR', 'eventTypes must list at least one event', 400);
      update.eventTypes = patch.eventTypes.map(t => {
        if (!isWebhookEvent(t)) throw new AutomationError('VALIDATION_ERROR', `Unknown event type: ${t}`, 400);
        return t;
      });
    }
    if (patch.enabled !== undefined) update.enabled = patch.enabled;
    if (patch.maxAttempts !== undefined) {
      if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1 || patch.maxAttempts > 10) {
        throw new AutomationError('VALIDATION_ERROR', 'maxAttempts must be an integer 1-10', 400);
      }
      update.maxAttempts = patch.maxAttempts;
    }
    const out = await this.store.updateWebhook(webhook.id, update);
    if (!out) throw new AutomationError('NOT_FOUND', 'Webhook not found', 404);
    return exposeWebhook(out);
  }

  /** Fan out one project event to every matching enabled subscription. Returns deliveries created. */
  async emit(event: ProjectEvent, projectWebhooks?: Webhook[]): Promise<Delivery[]> {
    const subs =
      projectWebhooks ?? (await this.store.listWebhooks(event.projectId)).filter(w => w.enabled);
    const matched = subs.filter(w => w.enabled && w.eventTypes.includes(event.type));
    const out: Delivery[] = [];
    for (const w of matched) {
      if (w.organizationId !== event.organizationId || w.projectId !== event.projectId) continue;
      out.push(
        await this.store.createDelivery({
          webhookId: w.id,
          organizationId: w.organizationId,
          projectId: w.projectId,
          eventType: event.type,
          payload: event.payload,
          nextAttemptAt: this.now().toISOString(),
        }),
      );
    }
    return out;
  }

  /** Attempt one delivery: signs (key = stored hash), sends, records. Schedules retry or marks failed. */
  async attemptDelivery(delivery: Delivery, webhook: Webhook, deliver: DeliverFn): Promise<Delivery> {
    const payloadBytes = JSON.stringify({
      id: delivery.id,
      event: delivery.eventType,
      projectId: delivery.projectId,
      createdAt: delivery.createdAt,
      data: delivery.payload,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CloudNivo-Event': delivery.eventType,
      'X-CloudNivo-Delivery': delivery.id,
      'X-CloudNivo-Signature': signPayload(webhook.secretHash, payloadBytes),
    };
    await this.store.updateDelivery(delivery.id, { status: 'sending' });
    let result: { ok: boolean; status: number | null; error: string | null; latencyMs: number };
    try {
      result = await deliver(webhook.url, payloadBytes, headers);
    } catch (err) {
      result = { ok: false, status: null, error: err instanceof Error ? err.message.slice(0, 200) : 'delivery failed', latencyMs: 0 };
    }
    const attempt: DeliveryAttempt = {
      at: this.now().toISOString(),
      status: result.status,
      ok: result.ok && (result.status === null || (result.status >= 200 && result.status < 300)),
      error: attemptOk(result) ? null : (result.error ?? `HTTP ${result.status ?? 'unknown'}`),
      latencyMs: result.latencyMs,
    };
    const attempts = [...delivery.attempts, attempt];
    if (attempt.ok) {
      const done = await this.store.updateDelivery(delivery.id, { status: 'succeeded', attempts, nextAttemptAt: null });
      if (!done) throw new AutomationError('NOT_FOUND', 'Delivery not found', 404);
      return done;
    }
    const wait = backoffMs(attempts.length - 1);
    const exhausted = wait === null || attempts.length >= webhook.maxAttempts;
    const failed = await this.store.updateDelivery(delivery.id, {
      status: exhausted ? 'failed' : 'pending',
      attempts,
      nextAttemptAt: exhausted ? null : new Date(this.now().getTime() + (wait as number)).toISOString(),
    });
    if (!failed) throw new AutomationError('NOT_FOUND', 'Delivery not found', 404);
    return failed;

    function attemptOk(r: { ok: boolean; status: number | null }): boolean {
      return r.ok && (r.status === null || (r.status >= 200 && r.status < 300));
    }
  }

  /** Retry loop for the worker: attempts every due delivery (bounded). */
  async retryDueDeliveries(
    deliver: (delivery: Delivery, webhook: Webhook) => Promise<Delivery>,
    limit = 25,
  ): Promise<{ retried: number; succeeded: number; failed: number }> {
    const due = await this.store.dueDeliveries(this.now(), limit);
    let succeeded = 0;
    let failed = 0;
    for (const d of due) {
      const webhook = await this.store.getWebhook(d.webhookId);
      if (!webhook || !webhook.enabled) {
        await this.store.updateDelivery(d.id, { status: 'failed', nextAttemptAt: null });
        failed += 1;
        continue;
      }
      try {
        const out = await deliver(d, webhook);
        if (out.status === 'succeeded') succeeded += 1;
        else if (out.status === 'failed') failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { retried: due.length, succeeded, failed };
  }

  /** Rotate a webhook secret: new raw value (shown once), hash-only storage. Old secret dies immediately. */
  async rotateSecret(webhook: Pick<Webhook, 'id' | 'name'>): Promise<{ webhook: ExposedWebhook; secret: string }> {
    const next = createWebhookSecret();
    const rotated = await this.store.rotateSecret(webhook.id, next.prefix, next.hash);
    if (!rotated) throw new AutomationError('NOT_FOUND', 'Webhook not found', 404);
    return { webhook: exposeWebhook(rotated), secret: next.raw };
  }

  /** Import-size guard shared by CSV ingestion (rows beyond this are rejected, not truncated). */
  static maxImportRows(): number {
    return MAX_IMPORT_PAYLOAD * 16;
  }
}
