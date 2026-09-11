import { describe, expect, it } from 'vitest';
import { nextRunFor, parseCron } from './cron.js';
import { MemoryAutomationStore } from './memory.js';
import { AutomationService } from './service.js';
import { backoffMs, createWebhookSecret, hashSecret, signPayload, verifySignature } from './signing.js';
import { AutomationError } from './types.js';

function service(): AutomationService {
  return new AutomationService(new MemoryAutomationStore(() => new Date('2026-01-05T00:00:00Z')));
}

describe('cron', () => {
  it('rejects non-five-field expressions', () => {
    expect(() => parseCron('* * *')).toThrow(AutomationError);
    expect(() => parseCron('61 * * * *')).toThrow(AutomationError);
    expect(() => parseCron('*/0 * * * *')).toThrow(AutomationError);
  });

  it('computes the next run strictly after now', () => {
    expect(nextRunFor('0 * * * *', new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05T01:00:00.000Z');
    expect(nextRunFor('*/15 * * * *', new Date('2026-01-05T00:07:00Z'))).toBe('2026-01-05T00:15:00.000Z');
    // 2026-01-05 is a Monday, so a Monday-only schedule fires the same day.
    expect(nextRunFor('30 9 * * 1', new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05T09:30:00.000Z');
    expect(nextRunFor('30 9 * * 2', new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-06T09:30:00.000Z');
  });
});

describe('signing', () => {
  it('round-trips signatures off the stored hash', () => {
    const { raw, hash } = createWebhookSecret();
    expect(raw.startsWith('whsec_')).toBe(true);
    expect(hashSecret(raw)).toBe(hash);
    const sig = signPayload(hash, '{"a":1}');
    expect(verifySignature(hash, '{"a":1}', sig)).toBe(true);
    expect(verifySignature(hash, '{"a":2}', sig)).toBe(false);
  });

  it('backs off then stops', () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(5)).toBe(86_400_000);
    expect(backoffMs(6)).toBeNull();
  });
});

describe('queues', () => {
  it('publishes idempotently and leases with expiry', async () => {
    const svc = service();
    const q = await svc.createQueue('org', 'proj', { name: 'jobs' });
    const first = await svc.publish(q, { body: { n: 1 }, idempotencyKey: 'k1' });
    const second = await svc.publish(q, { body: { n: 999 }, idempotencyKey: 'k1' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.message.body).toEqual({ n: 1 });

    const leased = await svc.consume(q, 10, 60_000);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.status).toBe('leased');
    await svc.ack(q, leased[0]?.id as string);
    const depth = await svc.storeRef.queueDepth(q.id);
    expect(depth).toEqual({ queued: 0, leased: 0, dead: 0 });
  });

  it('dead-letters after max deliveries', async () => {
    const svc = service();
    const q = await svc.createQueue('org', 'proj', { name: 'flaky', maxDeliveries: 2 });
    const { message } = await svc.publish(q, { body: {} });
    await svc.consume(q, 1, 60_000);
    await svc.nack(q, message.id, true);
    await svc.consume(q, 1, 60_000);
    const dead = await svc.nack(q, message.id, true);
    expect(dead.status).toBe('dead');
  });

  it('rejects oversized bodies and bad names', async () => {
    const svc = service();
    await expect(svc.createQueue('org', 'proj', { name: ' bad!' })).rejects.toThrow(AutomationError);
    const q = await svc.createQueue('org', 'proj', { name: 'ok' });
    await expect(svc.publish(q, { body: { s: 'x'.repeat(300_000) } })).rejects.toThrow(AutomationError);
  });
});

describe('schedules', () => {
  it('computes next run and fires due schedules once', async () => {
    let now = new Date('2026-01-05T00:00:00Z');
    const store = new MemoryAutomationStore(() => now);
    const svc = new AutomationService(store, () => now);
    const s = await svc.createSchedule('org', 'proj', {
      name: 'nightly',
      functionSlug: 'report',
      cron: '0 1 * * *',
      payload: { day: true },
    });
    expect(s.nextRunAt).toBe('2026-01-05T01:00:00.000Z');
    now = new Date('2026-01-05T01:00:01Z');
    const calls: string[] = [];
    const out = await svc.fireDueSchedules(async (_pid, slug) => {
      calls.push(slug);
      return { ok: true, error: null };
    });
    expect(out).toEqual({ fired: 1, failed: 0 });
    expect(calls).toEqual(['report']);
    // Advanced past the fired minute — must not refire.
    const again = await svc.fireDueSchedules(async () => ({ ok: true, error: null }));
    expect(again).toEqual({ fired: 0, failed: 0 });
  });
});

describe('webhooks', () => {
  it('fans out, signs, retries with backoff, then dead-letters', async () => {
    const svc = service();
    const { webhook, secret } = await svc.createWebhook('org', 'proj', {
      name: 'hook',
      url: 'https://example.com/hook',
      eventTypes: ['job.failed'],
    });
    expect(secret.startsWith('whsec_')).toBe(true);
    const deliveries = await svc.emit({ type: 'job.failed', organizationId: 'org', projectId: 'proj', payload: { job: '1' } });
    expect(deliveries).toHaveLength(1);
    // Non-matching events fan out to nobody.
    expect(await svc.emit({ type: 'job.completed', organizationId: 'org', projectId: 'proj', payload: {} })).toHaveLength(0);

    const failing = async (): Promise<{ ok: boolean; status: number | null; error: string | null; latencyMs: number }> => ({
      ok: false,
      status: 500,
      error: null,
      latencyMs: 3,
    });
    // Full record (secret hash) as the API layer loads it; the exposed shape never carries secrets.
    const full = (await svc.storeRef.getWebhook(webhook.id)) as NonNullable<Awaited<ReturnType<typeof svc.storeRef.getWebhook>>>;
    let d = await svc.attemptDelivery(deliveries[0] as NonNullable<typeof deliveries[number]>, full, failing);
    expect(d.status).toBe('pending');
    expect(d.attempts).toHaveLength(1);
    expect(d.nextAttemptAt).not.toBeNull();

    const succeeding = async (
      _url: string,
      body: string,
      headers: Record<string, string>,
    ): Promise<{ ok: boolean; status: number | null; error: string | null; latencyMs: number }> => {
      expect(headers['X-CloudNivo-Event']).toBe('job.failed');
      expect(headers['X-CloudNivo-Delivery']).toBe(d.id);
      expect(verifySignature(full.secretHash, body, headers['X-CloudNivo-Signature'] as string)).toBe(true);
      return { ok: true, status: 200, error: null, latencyMs: 1 };
    };
    d = await svc.attemptDelivery(d, full, succeeding);
    expect(d.status).toBe('succeeded');
  });

  it('blocks loopback URLs and rejects unknown events', async () => {
    const svc = service();
    await expect(
      svc.createWebhook('org', 'proj', { name: 'bad', url: 'http://localhost:9/x', eventTypes: ['job.failed'] }),
    ).rejects.toThrow(AutomationError);
    await expect(
      svc.createWebhook('org', 'proj', { name: 'bad', url: 'https://example.com/x', eventTypes: ['nope'] }),
    ).rejects.toThrow(AutomationError);
  });

  it('rotates secrets, killing the old one', async () => {
    const svc = service();
    const first = await svc.createWebhook('org', 'proj', {
      name: 'hook',
      url: 'https://example.com/hook',
      eventTypes: ['job.failed'],
    });
    const rotated = await svc.rotateSecret(first.webhook);
    expect(rotated.secret).not.toBe(first.secret);
    expect(rotated.webhook.secretPrefix).not.toBe(first.webhook.secretPrefix);
  });
});
