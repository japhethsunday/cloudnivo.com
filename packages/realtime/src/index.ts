import { EventEmitter } from 'node:events';

/**
 * Realtime abstraction — WebSocket-ready, transport-agnostic.
 *
 * Phase 1 ships an in-memory pub/sub (single-process dev). Production will
 * swap in a Redis-backed implementation with the same interface; WebSocket
 * gateway (Phase 3) subscribes via `subscribe()` and enforces channel auth
 * via `canSubscribe()` — never trust client-supplied channel names.
 *
 * Channel convention: `<orgId>:<projectId>:<topic>` (e.g. `org_1:proj_9:db`).
 */

export interface RealtimeMessage {
  channel: string;
  event: string;
  data: unknown;
  at: string;
}

export type Unsubscribe = () => void;

export interface RealtimeService {
  readonly driver: string;
  publish(channel: string, event: string, data: unknown): Promise<void>;
  subscribe(channel: string, handler: (msg: RealtimeMessage) => void): Unsubscribe;
}

/** Server-side channel authorization: membership must match the channel org. */
export function canSubscribe(channel: string, membershipOrgIds: string[]): boolean {
  const orgId = channel.split(':')[0];
  if (!orgId) return false;
  return membershipOrgIds.includes(orgId);
}

export function assertChannel(channel: string): void {
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_.:-]+$/.test(channel)) {
    throw new Error('Invalid realtime channel (expected org:project:topic)');
  }
}

export class InMemoryRealtimeService implements RealtimeService {
  readonly driver = 'memory';
  private readonly bus = new EventEmitter();

  async publish(channel: string, event: string, data: unknown): Promise<void> {
    assertChannel(channel);
    this.bus.emit(channel, { channel, event, data, at: new Date().toISOString() });
  }

  subscribe(channel: string, handler: (msg: RealtimeMessage) => void): Unsubscribe {
    assertChannel(channel);
    this.bus.on(channel, handler);
    return () => {
      this.bus.off(channel, handler);
    };
  }
}

export function createRealtimeService(driver: 'memory' | 'redis' = 'memory'): RealtimeService {
  if (driver === 'memory') return new InMemoryRealtimeService();
  throw new Error('Redis realtime driver lands in Phase 3. Set REALTIME_DRIVER=memory.');
}
