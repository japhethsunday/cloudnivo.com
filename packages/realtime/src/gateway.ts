import {
  canBroadcast,
  canReceive,
  canSubscribe,
  canTrackPresence,
  canWatchTable,
  matchesFilter,
  tableOfTopic,
  type AuthContext,
} from './authz.js';
import {
  parseChannel,
  parseSubscriptionFilter,
  type ConnectionInfo,
  type DbChangeEvent,
  type RealtimeMetrics,
  type ServerMessage,
  type SubscriptionFilter,
} from './types.js';
import type { BusMessage, EventBus } from './bus.js';
import type { PresenceManager } from './presence.js';

/**
 * Transport-agnostic realtime gateway. Sockets are adapted in (server.ts for
 * real TCP, fakes in tests) — all auth, routing, fan-out, presence, limits,
 * and metrics live here, identical in every deployment shape.
 */

export interface GatewaySocket {
  id: string;
  remoteAddress: string | null;
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
  closed: boolean;
}

export interface RateLimitStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export interface GatewayOptions {
  maxConnsPerProject: number;
  maxSubsPerConn: number;
  maxPayloadBytes: number;
  maxMsgPerSecond: number;
  maxBroadcastsPerMinute: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export const DEFAULT_GATEWAY_OPTIONS: GatewayOptions = {
  maxConnsPerProject: 500,
  maxSubsPerConn: 50,
  maxPayloadBytes: 64 * 1024,
  maxMsgPerSecond: 20,
  maxBroadcastsPerMinute: 60,
  heartbeatIntervalMs: 25_000,
  heartbeatTimeoutMs: 60_000,
};

interface ConnState {
  socket: GatewaySocket;
  ctx: AuthContext;
  info: ConnectionInfo;
  subscriptions: Set<string>;
  /** Per-channel equality filters for `table:<name>` subscriptions. */
  filters: Map<string, SubscriptionFilter | null>;
  awaitingPong: boolean;
}

async function allow(
  store: RateLimitStore | null,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!store) return true;
  try {
    const count = await store.incr(key, windowSeconds);
    return count <= max;
  } catch {
    return true;
  }
}

export class RealtimeGateway {
  private readonly conns = new Map<string, ConnState>();
  private readonly metrics: RealtimeMetrics = {
    connections: 0,
    subscriptions: 0,
    channels: 0,
    eventsPublished: 0,
    eventsDelivered: 0,
    eventsDropped: 0,
    broadcasts: 0,
    presenceEntries: 0,
    connectionErrors: 0,
    authFailures: 0,
    totalLatencyMs: 0,
    deliveredCount: 0,
  };
  private busDetach: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly presence: PresenceManager,
    private readonly opts: GatewayOptions = DEFAULT_GATEWAY_OPTIONS,
    private readonly rateLimit: RateLimitStore | null = null,
    private readonly hooks: {
      ensureTableFeed?: (projectId: string, table: string) => Promise<void>;
      tableColumns?: (projectId: string, table: string) => Promise<string[]>;
    } = {},
  ) {
    this.busDetach = this.bus.subscribe(msg => {
      void this.onBusMessage(msg).catch(() => undefined);
    });
  }

  connectionCount(): number {
    return this.conns.size;
  }

  snapshot(): Omit<RealtimeMetrics, 'channels'> & { channelCount: number; channels: string[] } {
    const channels = new Set<string>();
    for (const c of this.conns.values()) for (const ch of c.subscriptions) channels.add(ch);
    const { channels: _count, ...rest } = this.metrics;
    void _count;
    return { ...rest, channelCount: channels.size, channels: [...channels].sort() };
  }

  /** Register an already-authenticated socket (auth happens at upgrade). */
  register(ctx: AuthContext, socket: GatewaySocket): ConnectionInfo {
    const projectConns = [...this.conns.values()].filter(c => c.ctx.projectId === ctx.projectId);
    if (projectConns.length >= this.opts.maxConnsPerProject) {
      this.metrics.connectionErrors += 1;
      throw new Error('Project connection limit reached');
    }
    const now = new Date().toISOString();
    const info: ConnectionInfo = {
      id: socket.id,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      channels: [],
      connectedAt: now,
      lastHeartbeat: now,
      remoteAddress: socket.remoteAddress,
    };
    this.conns.set(socket.id, {
      socket,
      ctx,
      info,
      subscriptions: new Set(),
      filters: new Map(),
      awaitingPong: false,
    });
    this.metrics.connections += 1;
    return info;
  }

  async handleText(socketId: string, text: string): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn || conn.socket.closed) return;
    if (text.length > this.opts.maxPayloadBytes) {
      this.sendError(conn, undefined, 'PAYLOAD_TOO_LARGE', 'Message exceeds size limit');
      return;
    }
    if (!(await allow(this.rateLimit, `rt:msg:${socketId}`, this.opts.maxMsgPerSecond, 1))) {
      this.sendError(conn, undefined, 'RATE_LIMITED', 'Too many messages');
      return;
    }
    let msg: {
      id?: unknown;
      type?: unknown;
      channel?: unknown;
      event?: unknown;
      data?: unknown;
      filter?: unknown;
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.sendError(conn, undefined, 'MALFORMED_JSON', 'Body is not valid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this.sendError(conn, undefined, 'BAD_MESSAGE', 'Message needs a string type');
      return;
    }
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    try {
      switch (msg.type) {
        case 'ping':
          conn.info.lastHeartbeat = new Date().toISOString();
          conn.awaitingPong = false;
          this.send(conn, { id, type: 'pong' });
          break;
        case 'subscribe':
          await this.subscribe(conn, id, msg.channel, msg.filter);
          break;
        case 'unsubscribe':
          this.unsubscribe(conn, id, msg.channel);
          break;
        case 'broadcast':
          await this.broadcast(conn, id, msg.channel, msg.event, msg.data);
          break;
        case 'presence.set':
          await this.trackPresence(conn, id, msg.channel, msg.data);
          break;
        case 'presence.remove':
          await this.removePresence(conn, id, msg.channel);
          break;
        default:
          this.sendError(
            conn,
            id,
            'UNKNOWN_TYPE',
            `Unknown message type: ${msg.type.slice(0, 40)}`,
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      const code = (err as { code?: string }).code ?? 'REQUEST_FAILED';
      this.sendError(conn, id, code, message.slice(0, 200));
    }
  }

  private async subscribe(
    conn: ConnState,
    id: string | undefined,
    rawChannel: unknown,
    rawFilter?: unknown,
  ): Promise<void> {
    if (typeof rawChannel !== 'string') {
      this.sendError(conn, id, 'INVALID_CHANNEL', 'Channel must be a string');
      return;
    }
    let parsed;
    try {
      parsed = parseChannel(rawChannel);
    } catch {
      this.sendError(conn, id, 'INVALID_CHANNEL', 'Channel must look like project:<uuid>:<topic>');
      return;
    }
    if (!canSubscribe(conn.ctx, rawChannel) || parsed.projectId !== conn.ctx.projectId) {
      this.metrics.authFailures += 1;
      this.sendError(conn, id, 'FORBIDDEN', 'Not authorized for this channel');
      return;
    }
    if (conn.subscriptions.size >= this.opts.maxSubsPerConn) {
      this.sendError(conn, id, 'SUBSCRIPTION_LIMIT', 'Too many subscriptions');
      return;
    }
    const table = tableOfTopic(parsed.topic);
    let filter: SubscriptionFilter | null = null;
    if (rawFilter !== undefined && rawFilter !== null) {
      if (!table) {
        this.sendError(conn, id, 'INVALID_FILTER', 'Filters apply to table subscriptions only');
        return;
      }
      try {
        filter = parseSubscriptionFilter(rawFilter);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Bad filter';
        this.sendError(conn, id, 'INVALID_FILTER', message.slice(0, 120));
        return;
      }
    }
    if (table && !(await this.ensureTable(conn, table))) {
      this.sendError(conn, id, 'TABLE_UNAVAILABLE', 'Table feed unavailable');
      return;
    }
    conn.subscriptions.add(rawChannel);
    conn.filters.set(rawChannel, filter);
    conn.info.channels = [...conn.subscriptions];
    this.metrics.subscriptions += 1;
    this.send(conn, { id, type: 'subscribed', channel: rawChannel });
  }

  private async ensureTable(conn: ConnState, table: string): Promise<boolean> {
    if (!this.hooks.ensureTableFeed) return true;
    try {
      await this.hooks.ensureTableFeed(conn.ctx.projectId, table);
      return true;
    } catch {
      return false;
    }
  }

  private unsubscribe(conn: ConnState, id: string | undefined, rawChannel: unknown): void {
    if (typeof rawChannel !== 'string') {
      this.sendError(conn, id, 'INVALID_CHANNEL', 'Channel must be a string');
      return;
    }
    if (conn.subscriptions.delete(rawChannel)) this.metrics.subscriptions -= 1;
    conn.filters.delete(rawChannel);
    conn.info.channels = [...conn.subscriptions];
    // Leaving a channel also drops presence there (explicit re-track to return).
    if (conn.ctx.userId !== null) {
      void this.presence.remove(rawChannel, conn.ctx.userId).catch(() => undefined);
    }
    this.send(conn, { id, type: 'unsubscribed', channel: rawChannel });
  }

  private async broadcast(
    conn: ConnState,
    id: string | undefined,
    rawChannel: unknown,
    event: unknown,
    data: unknown,
  ): Promise<void> {
    if (
      typeof rawChannel !== 'string' ||
      typeof event !== 'string' ||
      event.length === 0 ||
      event.length > 80
    ) {
      this.sendError(conn, id, 'INVALID_BROADCAST', 'Broadcast needs channel + event name');
      return;
    }
    if (!canBroadcast(conn.ctx, rawChannel)) {
      this.metrics.authFailures += 1;
      this.sendError(conn, id, 'FORBIDDEN', 'Not allowed to broadcast here');
      return;
    }
    const size = JSON.stringify(data ?? null).length;
    if (size > this.opts.maxPayloadBytes) {
      this.sendError(conn, id, 'PAYLOAD_TOO_LARGE', 'Broadcast payload too large');
      return;
    }
    if (
      !(await allow(
        this.rateLimit,
        `rt:bcast:${conn.ctx.userId ?? conn.socket.id}`,
        this.opts.maxBroadcastsPerMinute,
        60,
      ))
    ) {
      this.sendError(conn, id, 'RATE_LIMITED', 'Broadcast rate exceeded');
      return;
    }
    this.metrics.broadcasts += 1;
    this.metrics.eventsPublished += 1;
    await this.bus.publish({
      channel: rawChannel,
      kind: 'broadcast',
      event: { event, data: data ?? null, at: new Date().toISOString(), from: conn.socket.id },
    });
    this.send(conn, { id, type: 'broadcast', channel: rawChannel, event });
  }

  private async trackPresence(
    conn: ConnState,
    id: string | undefined,
    rawChannel: unknown,
    data: unknown,
  ): Promise<void> {
    if (typeof rawChannel !== 'string' || !canTrackPresence(conn.ctx, rawChannel)) {
      this.sendError(conn, id, 'FORBIDDEN', 'Presence not allowed here');
      return;
    }
    if (conn.ctx.userId === null) {
      this.sendError(conn, id, 'FORBIDDEN', 'Presence requires an identity');
      return;
    }
    const meta =
      data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    if (JSON.stringify(meta).length > 4096) {
      this.sendError(conn, id, 'PAYLOAD_TOO_LARGE', 'Presence metadata too large');
      return;
    }
    const status =
      typeof (meta as { status?: unknown }).status === 'string'
        ? String((meta as { status: unknown }).status).slice(0, 40)
        : 'online';
    await this.presence.track(rawChannel, conn.ctx.userId, {
      user_id: conn.ctx.userId,
      status,
      metadata: meta,
    });
    this.metrics.presenceEntries += 1;
    // Tracking implies listening: join the channel so leave/cleanup and
    // presence events flow without a separate subscribe.
    if (!conn.subscriptions.has(rawChannel)) {
      conn.subscriptions.add(rawChannel);
      conn.filters.set(rawChannel, null);
      conn.info.channels = [...conn.subscriptions];
      this.metrics.subscriptions += 1;
    }
    await this.bus.publish({
      channel: rawChannel,
      kind: 'presence',
      event: { event: 'join', data: { user_id: conn.ctx.userId }, at: new Date().toISOString() },
    });
    this.send(conn, { id, type: 'presence', channel: rawChannel, event: 'tracked' });
  }

  private async removePresence(
    conn: ConnState,
    id: string | undefined,
    rawChannel: unknown,
  ): Promise<void> {
    if (typeof rawChannel !== 'string' || conn.ctx.userId === null) {
      this.sendError(conn, id, 'INVALID_CHANNEL', 'Channel must be a string');
      return;
    }
    await this.presence.remove(rawChannel, conn.ctx.userId);
    await this.bus.publish({
      channel: rawChannel,
      kind: 'presence',
      event: { event: 'leave', data: { user_id: conn.ctx.userId }, at: new Date().toISOString() },
    });
    this.send(conn, { id, type: 'presence', channel: rawChannel, event: 'removed' });
  }

  /** Publish a database change into the fan-out (CDC listener calls this). */
  async publishDatabaseChange(projectId: string, event: DbChangeEvent): Promise<void> {
    const channel = `project:${projectId}:table:${event.table}`;
    this.metrics.eventsPublished += 1;
    await this.bus.publish({ channel, kind: 'db-change', event });
  }

  private async onBusMessage(msg: BusMessage): Promise<void> {
    if (msg.kind === 'presence') {
      // Presence state lives in the manager; the bus only wakes subscribers.
      for (const conn of this.conns.values()) {
        if (!conn.subscriptions.has(msg.channel)) continue;
        if (!canSubscribe(conn.ctx, msg.channel)) continue;
        this.deliver(conn, { type: 'presence', channel: msg.channel, ...(msg.event as object) });
      }
      return;
    }
    for (const conn of this.conns.values()) {
      if (!conn.subscriptions.has(msg.channel)) continue;
      if (!canSubscribe(conn.ctx, msg.channel)) continue;
      if (msg.kind === 'db-change') {
        const evt = msg.event as DbChangeEvent;
        const row = evt.type === 'DELETE' ? evt.old_record : evt.record;
        const filter = conn.filters.get(msg.channel);
        if (!matchesFilter(row, filter ?? null)) {
          this.metrics.eventsDropped += 1;
          continue;
        }
        let columns: string[] | null = null;
        if (this.hooks.tableColumns) {
          try {
            columns = await this.hooks.tableColumns(conn.ctx.projectId, evt.table);
          } catch {
            columns = null;
          }
        }
        const knownColumns = columns ?? (row ? Object.keys(row) : []);
        if (!canReceive(conn.ctx, knownColumns, row)) {
          this.metrics.eventsDropped += 1;
          continue;
        }
        this.deliver(conn, { type: 'event', channel: msg.channel, event: evt.type, data: evt });
      } else {
        const payload = msg.event as { event: string; data: unknown; from?: string };
        if (payload.from === conn.socket.id) continue;
        this.deliver(conn, {
          type: 'broadcast',
          channel: msg.channel,
          event: payload.event,
          data: payload.data,
        });
      }
    }
  }

  private deliver(conn: ConnState, msg: ServerMessage): void {
    const started = Date.now();
    try {
      this.send(conn, msg);
      this.metrics.eventsDelivered += 1;
      this.metrics.totalLatencyMs += Date.now() - started;
      this.metrics.deliveredCount += 1;
    } catch {
      this.metrics.eventsDropped += 1;
      void this.drop(conn.socket.id, 'send failed').catch(() => undefined);
    }
  }

  private send(conn: ConnState, msg: ServerMessage): void {
    conn.socket.sendText(JSON.stringify(msg));
  }

  private sendError(conn: ConnState, id: string | undefined, code: string, message: string): void {
    this.send(conn, { id, type: 'error', error: { code, message } });
  }

  /**
   * Heartbeat sweep: pong-overdue AND credential-expired connections are
   * closed + cleaned up. Expiry enforcement means a revoked/expired session
   * (short-lived JWT, rotated key) loses realtime access without waiting for
   * a client goodbye — re-authenticate, then reconnect.
   */
  async sweep(): Promise<number> {
    const now = Date.now();
    let closed = 0;
    for (const conn of [...this.conns.values()]) {
      const exp = conn.ctx.expiresAt ? Date.parse(conn.ctx.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp <= now) {
        await this.drop(conn.socket.id, 'credential expired').catch(() => undefined);
        closed += 1;
        continue;
      }
      const silentMs = now - Date.parse(conn.info.lastHeartbeat);
      if (silentMs > this.opts.heartbeatTimeoutMs) {
        await this.drop(conn.socket.id, 'heartbeat timeout').catch(() => undefined);
        closed += 1;
      }
    }
    return closed;
  }

  async drop(socketId: string, _reason: string): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn) return;
    this.conns.delete(socketId);
    this.metrics.subscriptions -= conn.subscriptions.size;
    if (conn.ctx.userId !== null) {
      for (const channel of conn.subscriptions) {
        await this.presence.remove(channel, conn.ctx.userId).catch(() => undefined);
      }
    }
    try {
      conn.socket.close(1000, 'done');
    } catch {
      // Already gone.
    }
  }

  channelsFor(projectId: string): { channel: string; subscribers: number }[] {
    const counts = new Map<string, number>();
    for (const conn of this.conns.values()) {
      if (conn.ctx.projectId !== projectId) continue;
      for (const ch of conn.subscriptions) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([channel, subscribers]) => ({ channel, subscribers }))
      .sort((a, b) => (a.channel < b.channel ? -1 : 1));
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.conns.keys()]) {
      await this.drop(id, 'shutdown').catch(() => undefined);
    }
    this.busDetach?.();
    this.busDetach = null;
    await this.bus.close().catch(() => undefined);
  }
}

export { canWatchTable };
