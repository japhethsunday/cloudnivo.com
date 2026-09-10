import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from './bus.js';
import { DEFAULT_GATEWAY_OPTIONS, RealtimeGateway, type GatewaySocket } from './gateway.js';
import { MemoryPresenceManager } from './presence.js';
import type { AuthContext } from './authz.js';
import type { DbChangeEvent } from './types.js';

const PID = '11111111-1111-4111-8111-111111111111';

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'u1', role: 'member', projectId: PID, organizationId: 'o1', ...over };
}

function fakeSocket(id: string): GatewaySocket & { sent: string[]; closedBy: string | null } {
  const sock: GatewaySocket & { sent: string[]; closedBy: string | null } = {
    id,
    remoteAddress: '127.0.0.1',
    sent: [],
    closedBy: null,
    closed: false,
    sendText(text: string): void {
      if (sock.closed) throw new Error('closed');
      sock.sent.push(text);
    },
    close(): void {
      sock.closed = true;
      sock.closedBy = 'server';
    },
  };
  return sock;
}

function lastOf(sock: { sent: string[] }): Record<string, unknown> {
  return JSON.parse(sock.sent[sock.sent.length - 1] as string) as Record<string, unknown>;
}

function make() {
  const bus = new MemoryEventBus();
  const presence = new MemoryPresenceManager();
  const gw = new RealtimeGateway(bus, presence);
  return { bus, presence, gw };
}

describe('gateway subscriptions', () => {
  it('subscribes, rejects foreign projects, enforces sub caps', async () => {
    const { gw } = make();
    const a = fakeSocket('a');
    gw.register(auth(), a);
    await gw.handleText(
      'a',
      JSON.stringify({ id: '1', type: 'subscribe', channel: `project:${PID}:chat` }),
    );
    expect(lastOf(a)).toMatchObject({ id: '1', type: 'subscribed' });
    await gw.handleText(
      'a',
      JSON.stringify({
        id: '2',
        type: 'subscribe',
        channel: 'project:22222222-2222-4222-8222-222222222222:chat',
      }),
    );
    expect(lastOf(a)).toMatchObject({ id: '2', type: 'error', error: { code: 'FORBIDDEN' } });
    await gw.handleText('a', 'not-json{{{');
    expect(lastOf(a)).toMatchObject({ type: 'error', error: { code: 'MALFORMED_JSON' } });
    await gw.handleText(
      'a',
      JSON.stringify({ id: '3', type: 'unsubscribe', channel: `project:${PID}:chat` }),
    );
    expect(lastOf(a)).toMatchObject({ id: '3', type: 'unsubscribed' });
    expect(gw.snapshot().subscriptions).toBe(0);
  });

  it('fans broadcasts out to subscribers, never back to the sender', async () => {
    const { gw } = make();
    const a = fakeSocket('a');
    const b = fakeSocket('b');
    gw.register(auth({ userId: 'ua' }), a);
    gw.register(auth({ userId: 'ub' }), b);
    const ch = `project:${PID}:chat`;
    await gw.handleText('a', JSON.stringify({ type: 'subscribe', channel: ch }));
    await gw.handleText('b', JSON.stringify({ type: 'subscribe', channel: ch }));
    a.sent.length = 0;
    b.sent.length = 0;
    await gw.handleText(
      'a',
      JSON.stringify({ id: '9', type: 'broadcast', channel: ch, event: 'msg', data: { hi: 1 } }),
    );
    // Sender gets only its ack (which carries the request id); the event itself is excluded.
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0] as string)).toMatchObject({ id: '9', type: 'broadcast' });
    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(b.sent[0] as string)).toMatchObject({ type: 'broadcast', event: 'msg' });
    expect(gw.snapshot().broadcasts).toBe(1);
  });

  it('blocks viewer broadcasts and oversized payloads', async () => {
    const { gw } = make();
    const v = fakeSocket('v');
    gw.register(auth({ userId: 'vv', role: 'viewer' }), v);
    const ch = `project:${PID}:chat`;
    await gw.handleText(
      'v',
      JSON.stringify({ id: '1', type: 'broadcast', channel: ch, event: 'x' }),
    );
    expect(lastOf(v)).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } });
  });

  it('rate-limits message floods per connection', async () => {
    const bus = new MemoryEventBus();
    const counts = new Map<string, number>();
    const store = {
      incr: async (key: string): Promise<number> => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      },
    };
    const gw = new RealtimeGateway(
      bus,
      new MemoryPresenceManager(),
      { ...DEFAULT_GATEWAY_OPTIONS, maxMsgPerSecond: 2 },
      store,
    );
    const a = fakeSocket('a');
    gw.register(auth(), a);
    await gw.handleText('a', JSON.stringify({ type: 'ping' }));
    await gw.handleText('a', JSON.stringify({ type: 'ping' }));
    await gw.handleText('a', JSON.stringify({ type: 'ping' }));
    expect(a.sent.filter(s => s.includes('RATE_LIMITED')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('gateway presence', () => {
  it('tracks joins, serves state, removes on leave + disconnect', async () => {
    const { gw, presence } = make();
    const a = fakeSocket('a');
    gw.register(auth({ userId: 'u1' }), a);
    const ch = `project:${PID}:chat`;
    await gw.handleText(
      'a',
      JSON.stringify({ id: '1', type: 'presence.set', channel: ch, data: { status: 'online' } }),
    );
    expect(lastOf(a)).toMatchObject({ type: 'presence', event: 'tracked' });
    expect(await presence.state(ch)).toEqual({
      [ch]: [expect.objectContaining({ user_id: 'u1', status: 'online' })],
    });
    await gw.handleText('a', JSON.stringify({ id: '2', type: 'presence.remove', channel: ch }));
    expect(await presence.state(ch)).toEqual({});
    await gw.handleText('a', JSON.stringify({ id: '3', type: 'presence.set', channel: ch }));
    await gw.drop('a', 'test');
    expect(await presence.state(ch)).toEqual({});
    expect(gw.connectionCount()).toBe(0);
  });
});

describe('gateway heartbeats + limits', () => {
  it('pongs pings and sweeps stale connections', async () => {
    const bus = new MemoryEventBus();
    const gw = new RealtimeGateway(bus, new MemoryPresenceManager(), {
      ...DEFAULT_GATEWAY_OPTIONS,
      heartbeatTimeoutMs: 50,
    });
    const a = fakeSocket('a');
    gw.register(auth(), a);
    await gw.handleText('a', JSON.stringify({ id: 'p', type: 'ping' }));
    expect(lastOf(a)).toMatchObject({ id: 'p', type: 'pong' });
    await new Promise(r => setTimeout(r, 80));
    expect(await gw.sweep()).toBe(1);
    expect(gw.connectionCount()).toBe(0);
  });

  it('caps connections per project', () => {
    const bus = new MemoryEventBus();
    const gw = new RealtimeGateway(bus, new MemoryPresenceManager(), {
      ...DEFAULT_GATEWAY_OPTIONS,
      maxConnsPerProject: 1,
    });
    gw.register(auth(), fakeSocket('a'));
    expect(() => gw.register(auth(), fakeSocket('b'))).toThrow(/limit/);
  });
});

describe('database change fan-out', () => {
  const evt = (userId: string | null): DbChangeEvent => ({
    type: 'INSERT',
    project_id: PID,
    table: 'notes',
    schema: 'public',
    record: userId ? { id: 1, user_id: userId } : { id: 1 },
    old_record: null,
    timestamp: new Date().toISOString(),
  });

  it('delivers only rows the subscriber may see', async () => {
    const { gw } = make();
    const owner = fakeSocket('o');
    const stranger = fakeSocket('s');
    const admin = fakeSocket('a');
    gw.register(auth({ userId: 'u1', role: 'authenticated' }), owner);
    gw.register(auth({ userId: 'u2', role: 'authenticated' }), stranger);
    gw.register(auth({ userId: 'root', role: 'admin' }), admin);
    const ch = `project:${PID}:table:notes`;
    for (const [id, sock] of [
      ['o', owner],
      ['s', stranger],
      ['a', admin],
    ] as const) {
      await gw.handleText(id, JSON.stringify({ type: 'subscribe', channel: ch }));
      sock.sent.length = 0;
    }
    await gw.publishDatabaseChange(PID, evt('u1'));
    expect(owner.sent.filter(s => s.includes('"event"'))).toHaveLength(1);
    expect(stranger.sent).toHaveLength(0);
    expect(admin.sent.filter(s => s.includes('"event"'))).toHaveLength(1);
    expect(gw.snapshot().eventsDropped).toBe(1);
  });

  it('hides other owners rows as 404-equivalent silence on direct fetch', async () => {
    const { gw } = make();
    const s = fakeSocket('s');
    gw.register(auth({ userId: 'u2', role: 'authenticated' }), s);
    await gw.handleText(
      s.id,
      JSON.stringify({ type: 'subscribe', channel: `project:${PID}:table:notes` }),
    );
    s.sent.length = 0;
    await gw.publishDatabaseChange(PID, {
      ...evt('u1'),
      type: 'DELETE',
      record: null,
      old_record: { id: 1, user_id: 'u1' },
    });
    expect(s.sent).toHaveLength(0);
  });
});

describe('presence manager', () => {
  it('clears channels explicitly', async () => {
    const p = new MemoryPresenceManager();
    await p.track('c', 'u', { user_id: 'u', status: 'online', metadata: {} });
    await p.clearChannel('c');
    expect(await p.state('c')).toEqual({});
  });
});

describe('gateway metrics', () => {
  it('exposes a secret-free snapshot', () => {
    const { gw } = make();
    const snap = gw.snapshot();
    expect(snap.connections).toBe(0);
    expect(JSON.stringify(snap)).not.toContain('token');
  });
});

describe('subscription filters', () => {
  const ch = `project:${PID}:table:notes`;

  it('delivers only rows matching the equality filter', async () => {
    const { gw } = make();
    const a = fakeSocket('a');
    gw.register(auth({ userId: 'root', role: 'admin' }), a);
    await gw.handleText(
      'a',
      JSON.stringify({ type: 'subscribe', channel: ch, filter: { user_id: 'u1' } }),
    );
    expect(lastOf(a)).toMatchObject({ type: 'subscribed' });
    a.sent.length = 0;
    await gw.publishDatabaseChange(PID, {
      type: 'INSERT',
      project_id: PID,
      table: 'notes',
      schema: 'public',
      record: { id: 1, user_id: 'u2' },
      old_record: null,
      timestamp: new Date().toISOString(),
    });
    expect(a.sent).toHaveLength(0);
    await gw.publishDatabaseChange(PID, {
      type: 'INSERT',
      project_id: PID,
      table: 'notes',
      schema: 'public',
      record: { id: 2, user_id: 'u1' },
      old_record: null,
      timestamp: new Date().toISOString(),
    });
    expect(a.sent.filter(s => s.includes('"event"'))).toHaveLength(1);
  });

  it('rejects unsafe filters without touching SQL', async () => {
    const { gw } = make();
    const a = fakeSocket('a');
    gw.register(auth(), a);
    await gw.handleText(
      'a',
      JSON.stringify({ type: 'subscribe', channel: ch, filter: { 'x;DROP': 1 } }),
    );
    expect(lastOf(a)).toMatchObject({ type: 'error', error: { code: 'INVALID_FILTER' } });
    await gw.handleText(
      'a',
      JSON.stringify({ type: 'subscribe', channel: `project:${PID}:chat`, filter: { a: 1 } }),
    );
    expect(lastOf(a)).toMatchObject({ type: 'error', error: { code: 'INVALID_FILTER' } });
  });

  it('fans UPDATE out with old + new records, DELETE with old only', async () => {
    const { gw } = make();
    const a = fakeSocket('a');
    gw.register(auth({ userId: 'root', role: 'admin' }), a);
    await gw.handleText('a', JSON.stringify({ type: 'subscribe', channel: ch }));
    a.sent.length = 0;
    await gw.publishDatabaseChange(PID, {
      type: 'UPDATE',
      project_id: PID,
      table: 'notes',
      schema: 'public',
      record: { id: 1, n: 2 },
      old_record: { id: 1, n: 1 },
      timestamp: new Date().toISOString(),
    });
    await gw.publishDatabaseChange(PID, {
      type: 'DELETE',
      project_id: PID,
      table: 'notes',
      schema: 'public',
      record: null,
      old_record: { id: 1, n: 2 },
      timestamp: new Date().toISOString(),
    });
    const events = a.sent.map(s => JSON.parse(s) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect((events[0]?.['data'] as Record<string, unknown>)['type']).toBe('UPDATE');
    expect((events[1]?.['data'] as Record<string, unknown>)['type']).toBe('DELETE');
  });
});

describe('credential expiry', () => {
  it('sweep drops connections past credential expiry', async () => {
    const { gw } = make();
    const stale = fakeSocket('stale');
    gw.register(auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }), stale);
    const fresh = fakeSocket('fresh');
    gw.register(auth({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), fresh);
    expect(await gw.sweep()).toBe(1);
    expect(gw.connectionCount()).toBe(1);
  });
});
