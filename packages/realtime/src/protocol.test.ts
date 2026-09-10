import { describe, expect, it } from 'vitest';
import {
  acceptKey,
  decodeFrames,
  encodeFrame,
  encodeMaskedFrame,
  WsProtocolError,
} from './protocol.js';
import {
  canBroadcast,
  canReceive,
  canSubscribe,
  canTrackPresence,
  canWatchTable,
  matchesFilter,
  tableOfTopic,
} from './authz.js';
import { parseChannel, parseSubscriptionFilter } from './types.js';
import type { AuthContext } from './authz.js';

const PID = '11111111-1111-4111-8111-111111111111';

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return { userId: 'u1', role: 'member', projectId: PID, organizationId: 'o1', ...over };
}

describe('websocket codec', () => {
  it('matches the RFC 6455 handshake vector', () => {
    // RFC 6455 §1.3 worked example — real interop proof, no network needed.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips server text frames incl. extended lengths', () => {
    for (const text of ['hi', 'x'.repeat(200), 'y'.repeat(70_000)]) {
      const bytes = encodeFrame('text', text);
      const { frames, rest } = decodeFrames(bytes, 1_000_000);
      expect(rest.length).toBe(0);
      expect(frames).toHaveLength(1);
      expect(frames[0]?.payload.toString('utf8')).toBe(text);
    }
  });

  it('decodes masked client frames and ping/pong/close', () => {
    const masked = encodeMaskedFrame('text', '{"type":"ping"}');
    const { frames } = decodeFrames(masked, 1024);
    expect(frames[0]?.opcode).toBe('text');
    expect(frames[0]?.payload.toString('utf8')).toBe('{"type":"ping"}');
    const ping = encodeFrame('ping', '');
    const decoded = decodeFrames(ping, 1024);
    expect(decoded.frames[0]?.opcode).toBe('ping');
  });

  it('rejects oversized payloads, bad opcodes, fragmented controls', () => {
    expect(() =>
      decodeFrames(encodeFrame('text', 'toolongtoolong', true).subarray(0, 20), 4),
    ).toThrow(WsProtocolError);
    expect(() => decodeFrames(Buffer.from([0x83, 0x01, 0x41]), 1024)).toThrow(WsProtocolError);
    // FIN=0 ping (fragmented control) must die.
    expect(() => decodeFrames(Buffer.from([0x09, 0x01, 0x41]), 1024)).toThrow(WsProtocolError);
    // Incomplete frame waits for more bytes instead of throwing.
    const half = encodeMaskedFrame('text', 'hello').subarray(0, 4);
    const { frames, rest } = decodeFrames(half, 1024);
    expect(frames).toHaveLength(0);
    expect(rest.length).toBe(4);
  });
});

describe('channels', () => {
  it('parses project-bound channels, rejects the rest', () => {
    expect(parseChannel(`project:${PID}:chat`).projectId).toBe(PID);
    expect(parseChannel(`project:${PID}:table:users`).topic).toBe('table:users');
    for (const bad of ['chat', `project:${PID}`, 'project:not-a-uuid:chat', 'other:x:y']) {
      expect(() => parseChannel(bad)).toThrow();
    }
    expect(tableOfTopic('table:users')).toBe('users');
    expect(tableOfTopic('chat')).toBe(null);
    expect(tableOfTopic('table:users;DROP')).toBe(null);
  });
});

describe('authorization matrix', () => {
  const ch = `project:${PID}:chat`;
  const other = `project:22222222-2222-4222-8222-222222222222:chat`;

  it('binds subscriptions to the credential project', () => {
    expect(canSubscribe(ctx(), ch)).toBe(true);
    expect(canSubscribe(ctx(), other)).toBe(false);
    expect(canSubscribe(ctx(), 'nope')).toBe(false);
  });

  it('silences viewers/anonymous/public broadcasters', () => {
    expect(canBroadcast(ctx(), ch)).toBe(true);
    expect(canBroadcast(ctx({ role: 'viewer' }), ch)).toBe(false);
    expect(canBroadcast(ctx({ role: 'anonymous' }), ch)).toBe(false);
    expect(canBroadcast(ctx({ role: 'public', userId: null }), ch)).toBe(false);
    expect(canBroadcast(ctx(), other)).toBe(false);
    expect(canTrackPresence(ctx(), ch)).toBe(true);
    expect(canTrackPresence(ctx({ role: 'anonymous' }), ch)).toBe(false);
  });

  it('owner-scopes customer event delivery (engine RLS twin)', () => {
    const cols = ['id', 'user_id'];
    const cust = ctx({ role: 'authenticated', userId: 'u9' });
    expect(canReceive(cust, cols, { id: 1, user_id: 'u9' })).toBe(true);
    expect(canReceive(cust, cols, { id: 1, user_id: 'u1' })).toBe(false);
    expect(canReceive(cust, cols, null)).toBe(false);
    expect(canReceive(cust, ['id'], { id: 1 })).toBe(true);
    expect(canReceive(ctx({ role: 'admin' }), cols, { user_id: 'zzz' })).toBe(true);
    expect(canReceive(ctx({ role: 'service' }), cols, { user_id: 'zzz' })).toBe(true);
    expect(canReceive(ctx({ role: 'member' }), cols, { user_id: 'zzz' })).toBe(true);
  });

  it('gates table watches', () => {
    expect(canWatchTable('users', null)).toBe(true);
    expect(canWatchTable('users', ['users'])).toBe(true);
    expect(canWatchTable('secrets', ['users'])).toBe(false);
  });

  it('matches safe equality filters in JS, never SQL', () => {
    expect(matchesFilter({ user_id: 'u1' }, { user_id: 'u1' })).toBe(true);
    expect(matchesFilter({ user_id: 'u2' }, { user_id: 'u1' })).toBe(false);
    expect(matchesFilter({ id: 1 }, null)).toBe(true);
    expect(matchesFilter(null, { user_id: 'u1' })).toBe(false);
    expect(parseSubscriptionFilter({ user_id: 'u1', n: 2 })?.['n']).toBe(2);
    expect(() => parseSubscriptionFilter({ 'x;DROP': 1 })).toThrow();
    expect(() => parseSubscriptionFilter([1])).toThrow();
  });
});
