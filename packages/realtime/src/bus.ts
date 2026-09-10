import { randomUUID } from 'node:crypto';
import type { Redis as RedisClient } from 'ioredis';
import type { DbChangeEvent } from './types.js';

/**
 * Cross-instance event bus. `MemoryEventBus` is single-process dev/test.
 * `RedisEventBus` publishes every local event to Redis pub/sub AND delivers
 * remote events locally — so an event received by server A reaches
 * subscribers on server B. Redis outages degrade to local-only delivery
 * (counted, logged) rather than killing realtime; reconnect uses bounded
 * backoff, never endless tight loops.
 */

export interface BusMessage {
  channel: string;
  kind: 'db-change' | 'broadcast' | 'presence';
  event: DbChangeEvent | { event: string; data: unknown; at: string } | unknown;
  /** Originating instance id — receivers skip their own echoes (no dupes). */
  origin?: string;
}

export type BusHandler = (msg: BusMessage) => void;

export interface EventBus {
  readonly driver: string;
  publish(msg: BusMessage): Promise<void>;
  subscribe(handler: BusHandler): () => void;
  close(): Promise<void>;
}

export class MemoryEventBus implements EventBus {
  readonly driver = 'memory';
  private readonly handlers = new Set<BusHandler>();

  async publish(msg: BusMessage): Promise<void> {
    for (const h of [...this.handlers]) {
      try {
        h(msg);
      } catch {
        // One bad subscriber must not break fan-out.
      }
    }
  }

  subscribe(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

export interface RedisBusOptions {
  url: string;
  channel?: string;
  onError?: (err: unknown) => void;
}

export class RedisEventBus implements EventBus {
  readonly driver = 'redis';
  private pub: RedisClient | null = null;
  private sub: RedisClient | null = null;
  private readonly handlers = new Set<BusHandler>();
  private closed = false;
  private readonly topic: string;
  private degraded = false;
  private readonly id = randomUUID();

  constructor(private readonly opts: RedisBusOptions) {
    this.topic = opts.channel ?? 'cloudnivo:realtime';
  }

  private async clients(): Promise<{ pub: RedisClient; sub: RedisClient }> {
    if (!this.pub || !this.sub) {
      const { Redis } = await import('ioredis');
      const base = {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: true,
        retryStrategy: (times: number): number | null => {
          if (this.closed || times > 8) return null;
          return Math.min(30_000, 500 * 2 ** times);
        },
      };
      this.pub = new Redis(this.opts.url, base);
      this.sub = new Redis(this.opts.url, base);
      this.sub.on('message', (_chan: string, raw: string) => {
        try {
          const msg = JSON.parse(raw) as BusMessage;
          if (msg && typeof msg.channel === 'string' && msg.origin !== this.id) {
            for (const h of [...this.handlers]) {
              try {
                h(msg);
              } catch {
                // Isolate subscriber faults.
              }
            }
          }
        } catch {
          // Malformed bus payloads are dropped, never crash the loop.
        }
      });
      this.sub.on('error', err => this.opts.onError?.(err));
      this.pub.on('error', err => this.opts.onError?.(err));
      await this.sub.subscribe(this.topic);
    }
    return { pub: this.pub, sub: this.sub };
  }

  /** True while Redis is unreachable (local-only delivery mode). */
  isDegraded(): boolean {
    return this.degraded;
  }

  async publish(msg: BusMessage): Promise<void> {
    const stamped = { ...msg, origin: this.id };
    // Local subscribers always get it, even when Redis is down.
    for (const h of [...this.handlers]) {
      try {
        h(stamped);
      } catch {
        // Isolate subscriber faults.
      }
    }
    // Remote instances via Redis; failures degrade gracefully.
    try {
      const { pub } = await this.clients();
      await pub.publish(this.topic, JSON.stringify(stamped));
      this.degraded = false;
    } catch (err) {
      this.degraded = true;
      this.opts.onError?.(err);
    }
  }

  subscribe(handler: BusHandler): () => void {
    this.handlers.add(handler);
    void this.clients().catch(err => {
      this.degraded = true;
      this.opts.onError?.(err);
    });
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    await this.sub?.quit().catch(() => undefined);
    await this.pub?.quit().catch(() => undefined);
    this.sub = null;
    this.pub = null;
  }
}

/** Remote-origin marker so instances never re-publish received events. */
export function isBusMessage(value: unknown): value is BusMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m['channel'] === 'string' && typeof m['kind'] === 'string';
}
