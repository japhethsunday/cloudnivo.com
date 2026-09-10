import { EventEmitter } from 'node:events';

/**
 * Phase-1 realtime API — preserved for compatibility.
 *
 * Superseded by the Phase-6 engine (`gateway.ts`, `bus.ts`, …) whose channel
 * grammar is `project:<uuid>:<topic>`. This module keeps the original
 * `org:project:topic` convention and signatures intact. Deprecated for new
 * code; do not extend.
 *
 * @deprecated Use RealtimeGateway + EventBus instead.
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
  throw new Error('Use RedisEventBus for the Redis driver. Set REALTIME_DRIVER=memory.');
}
