import type { Redis as RedisClient } from 'ioredis';
import type { PresenceEntry, PresenceState } from './types.js';

/**
 * Presence tracking. Memory adapter = single instance. Redis adapter stores
 * one hash per channel (`HSET channel userId payload`, TTL refreshed on
 * heartbeat) so presence unions across instances; disconnects delete the
 * field immediately and TTLs garbage-collect the rest. No permanent records.
 */

export interface PresenceManager {
  readonly driver: string;
  track(channel: string, userId: string, entry: Omit<PresenceEntry, 'updated_at'>): Promise<void>;
  remove(channel: string, userId: string): Promise<void>;
  state(channel: string): Promise<PresenceState>;
  clearChannel(channel: string): Promise<void>;
}

export class MemoryPresenceManager implements PresenceManager {
  readonly driver = 'memory';
  private readonly channels = new Map<string, Map<string, PresenceEntry>>();

  async track(channel: string, userId: string, entry: Omit<PresenceEntry, 'updated_at'>): Promise<void> {
    let room = this.channels.get(channel);
    if (!room) {
      room = new Map();
      this.channels.set(channel, room);
    }
    room.set(userId, { ...entry, user_id: userId, updated_at: new Date().toISOString() });
  }

  async remove(channel: string, userId: string): Promise<void> {
    const room = this.channels.get(channel);
    if (!room) return;
    room.delete(userId);
    if (room.size === 0) this.channels.delete(channel);
  }

  async state(channel: string): Promise<PresenceState> {
    const room = this.channels.get(channel);
    if (!room || room.size === 0) return {};
    return { [channel]: [...room.values()] };
  }

  async clearChannel(channel: string): Promise<void> {
    this.channels.delete(channel);
  }
}

export class RedisPresenceManager implements PresenceManager {
  readonly driver = 'redis';
  private client: RedisClient | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlSeconds = 90,
  ) {}

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

  private key(channel: string): string {
    return `cn:presence:${channel}`;
  }

  async track(channel: string, userId: string, entry: Omit<PresenceEntry, 'updated_at'>): Promise<void> {
    const r = await this.redis();
    const full: PresenceEntry = { ...entry, user_id: userId, updated_at: new Date().toISOString() };
    const pipeline = r.pipeline();
    pipeline.hset(this.key(channel), userId, JSON.stringify(full));
    pipeline.expire(this.key(channel), this.ttlSeconds);
    await pipeline.exec();
  }

  async remove(channel: string, userId: string): Promise<void> {
    await (await this.redis()).hdel(this.key(channel), userId);
  }

  async state(channel: string): Promise<PresenceState> {
    const raw = await (await this.redis()).hgetall(this.key(channel));
    const entries: PresenceEntry[] = [];
    for (const value of Object.values(raw)) {
      try {
        entries.push(JSON.parse(value) as PresenceEntry);
      } catch {
        // Skip corrupt fields, keep serving the rest.
      }
    }
    if (entries.length === 0) return {};
    return { [channel]: entries };
  }

  async clearChannel(channel: string): Promise<void> {
    await (await this.redis()).del(this.key(channel));
  }
}
