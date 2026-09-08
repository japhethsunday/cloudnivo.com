/**
 * CacheService abstraction (Redis-ready, memory-default).
 *
 * Local dev uses `MemoryCache` (zero infra). Production constructs
 * `RedisCache` with `REDIS_URL` — same interface, including the token-bucket
 * rate limiter used by api-core. No caller imports `ioredis` directly.
 */

import type { Redis as RedisClient } from 'ioredis';

export interface CacheService {
  readonly driver: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic increment with expiry — backs rate limiting. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<boolean>;
}

export class MemoryCache implements CacheService {
  readonly driver = 'memory';
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  async set(key: string, value: string, ttlSeconds = 300): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const current = Number(this.read(key) ?? '0') + 1;
    this.store.set(key, { value: String(current), expiresAt: Date.now() + ttlSeconds * 1000 });
    return current;
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

export class RedisCache implements CacheService {
  readonly driver = 'redis';
  private client: RedisClient | null = null;
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  private async redis(): Promise<RedisClient> {
    if (!this.client) {
      const { Redis } = await import('ioredis');
      this.client = new Redis(this.url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: true,
      });
    }
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return (await this.redis()).get(key);
  }
  async set(key: string, value: string, ttlSeconds = 300): Promise<void> {
    const r = await this.redis();
    if (ttlSeconds > 0) await r.set(key, value, 'EX', ttlSeconds);
    else await r.set(key, value);
  }
  async del(key: string): Promise<void> {
    await (await this.redis()).del(key);
  }
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const r = await this.redis();
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, ttlSeconds);
    return count;
  }
  async ping(): Promise<boolean> {
    try {
      return (await (await this.redis()).ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

export function createCacheService(redisUrl?: string): CacheService {
  if (redisUrl && redisUrl.length > 0 && process.env.CACHE_DRIVER !== 'memory') {
    // In local dev REDIS_URL points at Docker Redis when available; the memory
    // driver remains the default so tests never require a live server.
    if (process.env.NODE_ENV === 'test') return new MemoryCache();
    return new RedisCache(redisUrl);
  }
  return new MemoryCache();
}
