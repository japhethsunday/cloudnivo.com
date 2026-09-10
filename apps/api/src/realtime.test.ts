import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'r'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function tokenFor(sub: string): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: JWT_SECRET });
}

async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return json['data'] as T;
}

/** Independent raw-socket WS client (hand-rolled framing, not the repo codec). */
class RawWs {
  private handshakeBuf = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private waiters: ((msg: Record<string, unknown>) => void)[] = [];
  readonly received: Record<string, unknown>[] = [];
  handshakeStatus = '';

  constructor(private readonly socket: Socket) {}

  static async connect(base: string, projectId: string, query: string): Promise<RawWs> {
    const url = new URL(base);
    const port = Number(url.port);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const key = randomBytes(16).toString('base64');
    socket.write(
      `GET /api/v1/projects/${projectId}/realtime/ws${query} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const client = new RawWs(socket);
    const status = await client.readHandshake();
    client.handshakeStatus = status;
    if (!status.includes('101')) {
      socket.destroy();
      return client;
    }
    socket.on('data', chunk => client.feed(chunk as Buffer));
    return client;
  }

  private readHandshake(): Promise<string> {
    return new Promise(resolve => {
      const onData = (chunk: Buffer): void => {
        this.handshakeBuf = Buffer.concat([this.handshakeBuf, chunk]);
        const idx = this.handshakeBuf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          const head = this.handshakeBuf.subarray(0, idx).toString('latin1');
          const rest = this.handshakeBuf.subarray(idx + 4);
          this.socket.off('data', onData);
          if (rest.length > 0 && head.startsWith('HTTP/1.1 101')) {
            // Feed any bytes already past the handshake.
            this.feed(rest);
          }
          resolve(head.split('\r\n')[0] ?? '');
        }
      };
      this.socket.on('data', onData);
    });
  }

  private feed(chunk: Buffer): void {
    this.tail = Buffer.concat([this.tail, chunk]);
    for (;;) {
      if (this.tail.length < 2) return;
      const b1 = this.tail[1] as number;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.tail.length < 4) return;
        len = this.tail.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.tail.length < 10) return;
        len = Number(this.tail.readBigUInt64BE(2));
        off = 10;
      }
      const op = (this.tail[0] as number) & 0x0f;
      if (this.tail.length < off + len) return;
      const payload = this.tail.subarray(off, off + len);
      this.tail = this.tail.subarray(off + len);
      if (op === 0x8) {
        this.socket.destroy();
        return;
      }
      if (op === 0x9) {
        this.sendRaw(0xa, payload);
        continue;
      }
      if (op !== 0x1) continue;
      try {
        const msg = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
        this.received.push(msg);
        const w = this.waiters.shift();
        if (w) w(msg);
      } catch {
        // Ignore malformed server output in tests (asserted structurally elsewhere).
      }
    }
  }

  private sendRaw(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let head: Buffer;
    if (payload.length < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1)
      masked[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  send(obj: unknown): void {
    this.sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
      this.waiters.push(msg => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async nextMatching(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const existing = this.received.find(pred);
      if (existing) return existing;
      if (Date.now() > deadline) throw new Error('ws matching message timeout');
      await this.next(Math.max(100, deadline - Date.now())).catch(() => undefined);
    }
  }

  close(): void {
    this.sendRaw(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.destroy();
  }
}

describe('phase 6 realtime over real sockets', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let projectA = '';
  let projectB = '';
  const sockets: RawWs[] = [];

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const mkOrg = async (tok: string, slug: string): Promise<string> => {
      const r = await req(base, 'POST', '/api/v1/organizations', {
        token: tok,
        body: { name: slug, slug },
      });
      return data<{ organization: { id: string } }>(r.json).organization.id;
    };
    const orgA = await mkOrg(tokenA, 'rtorga');
    const orgB = await mkOrg(tokenB, 'rtorgb');
    const mkProject = async (tok: string, org: string, slug: string): Promise<string> => {
      const p = await req(base, 'POST', '/api/v1/projects', {
        token: tok,
        body: { name: slug, slug, organizationId: org },
      });
      const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const j = await req(base, 'GET', `/api/v1/projects/${project.id}/jobs/${jobId}`, {
          token: tok,
        });
        const st = data<{ job: { status: string } }>(j.json).job.status;
        if (st === 'completed') break;
        if (st === 'failed' || Date.now() > deadline) throw new Error('provisioning failed');
        await new Promise(r => setTimeout(r, 50));
      }
      return project.id;
    };
    projectA = await mkProject(tokenA, orgA, 'rtshop');
    projectB = await mkProject(tokenB, orgB, 'rtother');
  });

  afterAll(async () => {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // Already gone.
      }
    }
    await close();
  });

  it('rejects bad handshakes (401/404) without a socket upgrade', async () => {
    const bad = await RawWs.connect(base, projectA, '?token=junk');
    expect(bad.handshakeStatus).toContain('401');
    const missing = await RawWs.connect(
      base,
      '00000000-0000-4000-8000-000000000000',
      `?token=${tokenA}`,
    );
    expect(missing.handshakeStatus).toContain('404');
  });

  it('rejects expired sessions at upgrade (401)', async () => {
    const { signSession: sign } = await import('@cloudnivo/auth');
    const short = await sign(
      { sub: USER_A, email: `${USER_A}@example.com` },
      { jwtSecret: JWT_SECRET, expiresInSeconds: 1 },
    );
    await new Promise(r => setTimeout(r, 1200));
    const stale = await RawWs.connect(base, projectA, `?token=${short}`);
    expect(stale.handshakeStatus).toContain('401');
  });

  it('rejects oversized payloads safely without dropping the connection', async () => {
    const a = await RawWs.connect(base, projectA, `?token=${tokenA}`);
    sockets.push(a);
    expect(a.handshakeStatus).toContain('101');
    const ch = `project:${projectA}:chat`;
    a.send({
      id: 'big1',
      type: 'presence.set',
      channel: ch,
      data: { status: 'online', pad: 'y'.repeat(5000) },
    });
    expect(await a.nextMatching(m => m['id'] === 'big1')).toMatchObject({
      type: 'error',
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    // Connection survives abuse: heartbeats still answer.
    a.send({ id: 'after-big', type: 'ping' });
    expect(await a.nextMatching(m => m['id'] === 'after-big')).toMatchObject({ type: 'pong' });
  });

  it('subscribes, broadcasts A→B, and tracks presence for real', async () => {
    const ch = `project:${projectA}:chat`;
    const a = await RawWs.connect(base, projectA, `?token=${tokenA}`);
    const b = await RawWs.connect(base, projectA, `?token=${tokenA}`);
    sockets.push(a, b);
    expect(a.handshakeStatus).toContain('101');
    a.send({ id: 's1', type: 'subscribe', channel: ch });
    expect(await a.nextMatching(m => m['id'] === 's1')).toMatchObject({ type: 'subscribed' });
    b.send({ id: 's2', type: 'subscribe', channel: ch });
    expect(await b.nextMatching(m => m['id'] === 's2')).toMatchObject({ type: 'subscribed' });

    b.send({ id: 't1', type: 'presence.set', channel: ch, data: { status: 'online' } });
    expect(await b.nextMatching(m => m['id'] === 't1')).toMatchObject({ type: 'presence' });
    const seenByA = await a.nextMatching(m => m['type'] === 'presence');
    expect(seenByA['channel']).toBe(ch);

    a.send({ id: 'b1', type: 'broadcast', channel: ch, event: 'msg', data: { hi: 1 } });
    const got = await b.nextMatching(m => m['type'] === 'broadcast');
    expect(got).toMatchObject({ event: 'msg', channel: ch });
    expect(got['data']).toEqual({ hi: 1 });

    // Presence visible through the HTTP surface too.
    const pres = await req(base, 'GET', `/api/v1/projects/${projectA}/realtime/presence`, {
      token: tokenA,
    });
    expect(pres.status).toBe(200);
  });

  it('denies cross-project channels and enforces heartbeat liveness', async () => {
    const a = await RawWs.connect(base, projectA, `?token=${tokenA}`);
    sockets.push(a);
    a.send({ id: 'x1', type: 'subscribe', channel: `project:${projectB}:chat` });
    expect(await a.nextMatching(m => m['id'] === 'x1')).toMatchObject({
      type: 'error',
      error: { code: 'FORBIDDEN' },
    });
    a.send({ id: 'p1', type: 'ping' });
    expect(await a.nextMatching(m => m['id'] === 'p1')).toMatchObject({ type: 'pong' });
    const stats = await req(base, 'GET', `/api/v1/projects/${projectA}/realtime/stats`, {
      token: tokenA,
    });
    expect(stats.status).toBe(200);
    expect(data<{ stats: { connections: number } }>(stats.json).stats.connections).toBeGreaterThan(
      0,
    );
    const channels = await req(base, 'GET', `/api/v1/projects/${projectA}/realtime/channels`, {
      token: tokenA,
    });
    expect(channels.status).toBe(200);
  });

  it('rate-limits upgrade floods (429)', async () => {
    let limited = false;
    for (let i = 0; i < 16; i += 1) {
      const s = await RawWs.connect(base, projectA, '?token=wrong');
      if (s.handshakeStatus.includes('429')) {
        limited = true;
        break;
      }
      expect(s.handshakeStatus).toContain('401');
    }
    expect(limited).toBe(true);
  }, 30_000);
});
