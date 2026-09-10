import type { EventBus } from './bus.js';
import type { RealtimeGateway } from './gateway.js';
import type { GatewaySocket } from './gateway.js';
import type { PresenceManager } from './presence.js';
import type { AuthContext } from './authz.js';
import type { ConnectionInfo, DbChangeEvent, PresenceState, SubscriptionFilter } from './types.js';

/**
 * Spec §1 architecture boundaries — transport, connection state, event
 * distribution, change capture, authorization, and presence stay behind these
 * interfaces so any layer swaps without touching the others.
 */

/** Raw WebSocket transport (server.ts adapts TCP sockets; tests use fakes). */
export type RealtimeTransport = GatewaySocket;

/** Owns connection state + routing + fan-out (gateway.ts). */
export interface RealtimeConnectionManager {
  register(ctx: AuthContext, socket: GatewaySocket): ConnectionInfo;
  handleText(socketId: string, text: string): Promise<void>;
  drop(socketId: string, reason: string): Promise<void>;
  sweep(): Promise<number>;
}

/** PostgreSQL change capture (packages/database realtime-cdc.ts). */
export interface DatabaseChangeListener {
  onChange(
    handler: (n: {
      table: string;
      schema: string;
      op: 'INSERT' | 'UPDATE' | 'DELETE';
      record: Record<string, unknown> | null;
      old_record: Record<string, unknown> | null;
    }) => void,
  ): () => void;
  close(): Promise<void>;
}

/**
 * Provider-independent realtime facade (spec §1 `RealtimeService`).
 *
 * Thin, dependency-free surface over the gateway/bus/presence trio: SDKs and
 * routes program to this, never to sockets or Redis directly. Memory drivers
 * serve local dev/tests; Redis drivers serve production multi-instance — the
 * call shapes are identical.
 */
export class RealtimeService {
  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly bus: EventBus,
    private readonly presence: PresenceManager,
  ) {}

  /** Open a server-side subscription for an already-registered socket. */
  async subscribe(socketId: string, channel: string, filter?: SubscriptionFilter): Promise<void> {
    await this.gateway.handleText(
      socketId,
      JSON.stringify({ type: 'subscribe', channel, ...(filter ? { filter } : {}) }),
    );
  }

  async unsubscribe(socketId: string, channel: string): Promise<void> {
    await this.gateway.handleText(socketId, JSON.stringify({ type: 'unsubscribe', channel }));
  }

  /** Application-level fan-out to every subscriber of `channel`. */
  async broadcast(channel: string, event: string, data: unknown): Promise<void> {
    await this.bus.publish({
      channel,
      kind: 'broadcast',
      event: { event, data, at: new Date().toISOString() },
    });
  }

  async trackPresence(
    channel: string,
    userId: string,
    entry: { status: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await this.presence.track(channel, userId, { user_id: userId, ...entry });
  }

  async removePresence(channel: string, userId: string): Promise<void> {
    await this.presence.remove(channel, userId);
  }

  async getPresence(channel: string): Promise<PresenceState> {
    return this.presence.state(channel);
  }

  /** CDC entrypoint: a captured row change fans out to table subscribers. */
  async publishDatabaseChange(projectId: string, event: DbChangeEvent): Promise<void> {
    await this.gateway.publishDatabaseChange(projectId, event);
  }

  getConnectionStatus(): { connections: number; driver: string } {
    return { connections: this.gateway.connectionCount(), driver: this.bus.driver };
  }
}
