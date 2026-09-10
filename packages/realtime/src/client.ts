import type { DbChangeEvent, PresenceState, ServerMessage } from './types.js';

/**
 * Framework-independent realtime client (SDK sketch for Phase 8).
 * Runs on the browser `WebSocket` or Node 22+ global — no dependencies.
 * The dashboard console dogfoods exactly this client.
 */

export interface RealtimeClientOptions {
  url: string;
  token?: string;
  apikey?: string;
  maxReconnects?: number;
  baseDelayMs?: number;
}

type Handler = (msg: Extract<ServerMessage, { type: 'event' | 'broadcast' | 'presence' }>) => void;

function wsGlobal(): typeof WebSocket {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error('WebSocket is not available in this runtime');
  return WS;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly presenceHandlers = new Set<(state: PresenceState) => void>();
  private reconnects = 0;
  private closed = false;
  private msgId = 0;
  private readonly presence: PresenceState = {};

  constructor(private readonly opts: RealtimeClientOptions) {}

  private url(): string {
    const u = new URL(this.opts.url);
    if (this.opts.token) u.searchParams.set('token', this.opts.token);
    if (this.opts.apikey) u.searchParams.set('apikey', this.opts.apikey);
    return u.toString();
  }

  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const WS = wsGlobal();
      const socket = new WS(this.url());
      const timeout = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Unreachable.
        }
        reject(new Error('Connect timeout'));
      }, 10_000);
      socket.onopen = () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.reconnects = 0;
        this.attach(socket);
        // Re-subscribe after reconnects so streams resume automatically.
        for (const channel of this.handlers.keys()) {
          this.send({ type: 'subscribe', channel });
        }
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      };
    });
  }

  private attach(socket: WebSocket): void {
    socket.onmessage = ev => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'event' || msg.type === 'broadcast' || msg.type === 'presence') {
        if (msg.type === 'presence' && msg.channel) {
          this.presence[msg.channel] = [];
        }
        const set = this.handlers.get(msg.channel ?? '');
        if (set)
          for (const h of [...set])
            h(msg as Extract<ServerMessage, { type: 'event' | 'broadcast' | 'presence' }>);
        if (msg.type === 'presence' && msg.channel) {
          for (const h of [...this.presenceHandlers]) h({ ...this.presence });
        }
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed) void this.scheduleReconnect();
    };
  }

  private async scheduleReconnect(): Promise<void> {
    const max = this.opts.maxReconnects ?? 8;
    if (this.reconnects >= max) return;
    this.reconnects += 1;
    const delay = Math.min(30_000, (this.opts.baseDelayMs ?? 500) * 2 ** (this.reconnects - 1));
    await new Promise(r => setTimeout(r, delay));
    if (!this.closed) {
      try {
        await this.connect();
      } catch {
        // Next close event (or exhaustion) handles the rest.
      }
    }
  }

  private send(msg: Record<string, unknown>): string {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Not connected');
    const id = `m${(this.msgId += 1)}`;
    this.socket.send(JSON.stringify({ ...msg, id }));
    return id;
  }

  channel(name: string): {
    on(type: 'database_change' | 'broadcast' | 'presence', handler: Handler): () => void;
    subscribe(filter?: Record<string, string | number | boolean | null>): void;
    unsubscribe(): void;
    broadcast(event: string, data?: unknown): void;
    track(meta?: Record<string, unknown>): void;
    untrack(): void;
  } {
    const post = (msg: Record<string, unknown>): void => {
      this.send(msg);
    };
    const handlers = this.handlers;
    const dropChannel = (): void => {
      handlers.delete(name);
    };
    return {
      on(_type: 'database_change' | 'broadcast' | 'presence', handler: Handler): () => void {
        let set = handlers.get(name);
        if (!set) {
          set = new Set();
          handlers.set(name, set);
        }
        set.add(handler);
        return () => {
          set?.delete(handler);
        };
      },
      subscribe(filter?: Record<string, string | number | boolean | null>): void {
        post(
          filter === undefined
            ? { type: 'subscribe', channel: name }
            : { type: 'subscribe', channel: name, filter },
        );
      },
      unsubscribe(): void {
        post({ type: 'unsubscribe', channel: name });
        dropChannel();
      },
      broadcast(event: string, data?: unknown): void {
        post({ type: 'broadcast', channel: name, event, data });
      },
      track(meta?: Record<string, unknown>): void {
        post({ type: 'presence.set', channel: name, data: meta ?? {} });
      },
      untrack(): void {
        post({ type: 'presence.remove', channel: name });
      },
    };
  }

  onPresence(handler: (state: PresenceState) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => {
      this.presenceHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.socket?.close(1000, 'done');
    } catch {
      // Already gone.
    }
    this.socket = null;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }
}

export function createRealtimeClient(opts: RealtimeClientOptions): RealtimeClient {
  return new RealtimeClient(opts);
}

export type { DbChangeEvent };
