import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { decodeFrames, encodeFrame, acceptKey, WsProtocolError } from './protocol.js';
import { type GatewaySocket, type RealtimeGateway } from './gateway.js';
import type { AuthContext } from './authz.js';

/**
 * Raw-socket WebSocket server. Mounts on any `node:http` server via the
 * `upgrade` event (in-process with the API) or standalone on REALTIME_PORT
 * (independent Railway service — same factory, same behavior).
 *
 * Lifecycle: upgrade auth → register → frames → heartbeat sweep → cleanup.
 * Malformed handshakes/frames are rejected with HTTP errors or close codes,
 * never crashes. Shutdown drains with a bounded timeout.
 */

export interface WsServerOptions {
  maxPayloadBytes: number;
  heartbeatIntervalMs: number;
  pathPrefix: string;
}

export const DEFAULT_WS_OPTIONS: WsServerOptions = {
  maxPayloadBytes: 64 * 1024,
  heartbeatIntervalMs: 25_000,
  pathPrefix: '/api/v1/projects/',
};

/** Resolve caller identity for an upgrade request (tokens never logged). */
export type UpgradeAuth = (req: IncomingMessage, projectId: string) => Promise<AuthContext>;

class TcpSocket implements GatewaySocket {
  readonly id = randomUUID();
  private dead = false;
  private tail = Buffer.alloc(0);
  private fragments: { opcode: 'text' | 'binary'; parts: Buffer[]; bytes: number } | null = null;

  constructor(
    readonly socket: Socket,
    readonly remoteAddress: string | null,
    private readonly onText: (socketId: string, text: string) => Promise<void>,
    private readonly onProtocolError: (socketId: string, err: unknown) => void,
    private readonly maxPayloadBytes: number,
  ) {
    socket.on('data', chunk => {
      void this.feed(chunk as Buffer).catch(err => this.onProtocolError(this.id, err));
    });
  }

  get closed(): boolean {
    return this.dead || this.socket.destroyed;
  }

  sendText(text: string): void {
    if (this.closed) throw new WsProtocolError('Socket closed');
    this.socket.write(encodeFrame('text', text));
  }

  ping(): void {
    if (!this.closed) this.socket.write(encodeFrame('ping', ''));
  }

  close(code = 1000, reason = ''): void {
    if (this.dead) return;
    this.dead = true;
    try {
      const body = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(reason, 'utf8')]);
      this.socket.write(encodeFrame('close', body));
    } catch {
      // Best effort.
    }
    this.socket.destroy();
  }

  markDead(): void {
    this.dead = true;
  }

  private async feed(chunk: Buffer): Promise<void> {
    if (this.dead) return;
    const data = Buffer.concat([this.tail, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(data, this.maxPayloadBytes);
    } catch (err) {
      this.onProtocolError(this.id, err);
      return;
    }
    this.tail = Buffer.from(decoded.rest);
    for (const frame of decoded.frames) {
      if (frame.opcode === 'close') {
        this.markDead();
        this.socket.destroy();
        return;
      }
      if (frame.opcode === 'ping') {
        this.socket.write(encodeFrame('pong', frame.payload));
        continue;
      }
      if (frame.opcode === 'pong') continue;
      if (frame.opcode === 'binary') continue;
      // Text: reassemble fragments (bounded by maxPayloadBytes at decode).
      if (!frame.fin) {
        if (frame.opcode === 'text') {
          if (this.fragments) throw new WsProtocolError('Interleaved fragments');
          this.fragments = { opcode: 'text', parts: [frame.payload], bytes: frame.payload.length };
        } else if (frame.opcode === 'continuation' && this.fragments) {
          this.fragments.parts.push(frame.payload);
          this.fragments.bytes += frame.payload.length;
          if (this.fragments.bytes > this.maxPayloadBytes) throw new WsProtocolError('Message exceeds limit');
        } else {
          throw new WsProtocolError('Stray continuation frame');
        }
        continue;
      }
      let text: string;
      if (this.fragments) {
        if (frame.opcode !== 'continuation') throw new WsProtocolError('Expected continuation');
        this.fragments.parts.push(frame.payload);
        text = Buffer.concat(this.fragments.parts).toString('utf8');
        this.fragments = null;
      } else {
        if (frame.opcode !== 'text') continue;
        text = frame.payload.toString('utf8');
      }
      await this.onText(this.id, text);
    }
  }
}

export class RealtimeServer {
  private readonly sockets = new Map<string, TcpSocket>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly auth: UpgradeAuth,
    private readonly opts: WsServerOptions = DEFAULT_WS_OPTIONS,
  ) {}

  /** Attach to an existing HTTP server's upgrade flow. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket as Socket, head).catch(() => {
        try {
          (socket as Socket).destroy();
        } catch {
          // Already gone.
        }
      });
    });
    this.sweepTimer = setInterval(() => {
      void this.gateway.sweep().catch(() => undefined);
    }, this.opts.heartbeatIntervalMs);
    this.sweepTimer.unref?.();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(this.opts.pathPrefix) || !url.pathname.endsWith('/realtime/ws')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const projectId = url.pathname.slice(this.opts.pathPrefix.length, -'/realtime/ws'.length);
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const connectionTokens = String(req.headers['connection'] ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase());
    if (typeof req.headers['upgrade'] !== 'string' || !connectionTokens.includes('upgrade')) {
      socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length < 16) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let ctx: AuthContext;
    try {
      ctx = await this.auth(req, projectId);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      const code =
        typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : 401;
      const reason = code === 404 ? 'Not Found' : code === 429 ? 'Too Many Requests' : 'Unauthorized';
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (ctx.projectId !== projectId) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const tcp = new TcpSocket(
      socket,
      req.socket.remoteAddress ?? null,
      async (id, text) => this.gateway.handleText(id, text),
      async (id, err) => {
        try {
          tcp.sendText(JSON.stringify({ type: 'error', error: { code: 'PROTOCOL_ERROR', message: err instanceof Error ? err.message.slice(0, 120) : 'Bad frame' } }));
        } catch {
          // Unwritable.
        }
        await this.gateway.drop(id, 'protocol error').catch(() => undefined);
        this.sockets.delete(id);
      },
      this.opts.maxPayloadBytes,
    );
    // Any buffered post-handshake bytes belong to the first frames.
    if (head.length > 0) socket.unshift(head);
    this.sockets.set(tcp.id, tcp);
    try {
      this.gateway.register(ctx, tcp);
    } catch {
      tcp.close(1013, 'try again later');
      this.sockets.delete(tcp.id);
      return;
    }
    socket.on('close', () => {
      this.sockets.delete(tcp.id);
      void this.gateway.drop(tcp.id, 'tcp close').catch(() => undefined);
    });
    socket.on('error', () => {
      this.sockets.delete(tcp.id);
      void this.gateway.drop(tcp.id, 'tcp error').catch(() => undefined);
    });
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await Promise.race([
      this.gateway.shutdown(),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    for (const tcp of this.sockets.values()) {
      try {
        tcp.close(1001, 'going away');
      } catch {
        // Already gone.
      }
    }
    this.sockets.clear();
  }
}
