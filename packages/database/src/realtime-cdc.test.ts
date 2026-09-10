import { describe, expect, it } from 'vitest';
import { CHANGE_CHANNEL, changeFeedDdl, parseNotification } from './realtime-cdc.js';

describe('realtime CDC trigger DDL', () => {
  it('installs idempotent per-table triggers over LISTEN/NOTIFY (no polling)', () => {
    const stmts = changeFeedDdl('public', 'messages');
    expect(stmts).toHaveLength(3);
    const joined = stmts.join('\n');
    expect(joined).toContain(`pg_notify('${CHANGE_CHANNEL}'`);
    expect(joined).toContain('AFTER INSERT OR UPDATE OR DELETE');
    expect(joined).toContain('"public"."messages"');
    expect(joined).toContain('DROP TRIGGER IF EXISTS');
  });

  it('rejects unsafe identifiers instead of interpolating them', () => {
    for (const bad of ['messages; DROP TABLE x;--', 'a b', 'x"y', '']) {
      expect(() => changeFeedDdl('public', bad)).toThrow();
      expect(() => changeFeedDdl(bad, 'messages')).toThrow();
    }
  });
});

describe('NOTIFY payload parsing', () => {
  const base = { schema: 'public', table: 'messages' };

  it('accepts INSERT/UPDATE/DELETE shapes', () => {
    expect(
      parseNotification(
        JSON.stringify({ ...base, op: 'INSERT', record: { id: 1 }, old_record: null }),
      ),
    ).toMatchObject({ op: 'INSERT', table: 'messages' });
    expect(
      parseNotification(
        JSON.stringify({
          ...base,
          op: 'UPDATE',
          record: { id: 1, n: 2 },
          old_record: { id: 1, n: 1 },
        }),
      ),
    ).toMatchObject({ op: 'UPDATE' });
    expect(
      parseNotification(
        JSON.stringify({ ...base, op: 'DELETE', record: null, old_record: { id: 1 } }),
      ),
    ).toMatchObject({ op: 'DELETE' });
  });

  it('drops malformed payloads without throwing (never crashes the listener)', () => {
    expect(parseNotification('not-json{{{')).toBe(null);
    expect(parseNotification(JSON.stringify({ ...base, op: 'TRUNCATE' }))).toBe(null);
    expect(
      parseNotification(
        JSON.stringify({ ...base, op: 'INSERT', table: 'x;DROP', record: null, old_record: null }),
      ),
    ).toBe(null);
    expect(parseNotification(JSON.stringify({ op: 'INSERT' }))).toBe(null);
    expect(
      parseNotification(JSON.stringify({ ...base, op: 'INSERT', record: [1], old_record: null })),
    ).toBe(null);
  });
});
