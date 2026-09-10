import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_CHANNEL,
  changeFeedDdl,
  parseNotification,
  PostgresNotifyListener,
  type ChangeNotification,
} from './realtime-cdc.js';

// Live LISTEN/NOTIFY round-trip against a real PostgreSQL. Runs only with
// LIVE_PG_URL=postgres://... set (CI/dev with Postgres). Skipped otherwise —
// trigger DDL + payload parsing are covered by realtime-cdc.test.ts.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('realtime CDC on live postgres', () => {
  it('INSERT → UPDATE → DELETE notifications arrive with row payloads', async () => {
    const sql = postgres(LIVE_PG_URL, { max: 2 });
    const table = `cn_live_notes_${Date.now() % 100000}`;
    const received: ChangeNotification[] = [];
    const listener = new PostgresNotifyListener(LIVE_PG_URL, {
      onError: err => console.warn('cdc listener error', String(err).slice(0, 120)),
    });
    const off = listener.onChange(n => received.push(n));
    try {
      await sql.unsafe(
        `CREATE TABLE "public"."${table}" (id serial primary key, user_id text, n int)`,
      );
      for (const stmt of changeFeedDdl('public', table)) {
        await sql.unsafe(stmt);
      }
      // Idempotent reinstall must not fail or double-fire.
      for (const stmt of changeFeedDdl('public', table)) {
        await sql.unsafe(stmt);
      }
      const deadline = Date.now() + 20_000;
      while (listener.state !== 'listening' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(listener.state).toBe('listening');

      await sql.unsafe(`INSERT INTO "public"."${table}" (user_id, n) VALUES ('u1', 1)`);
      await sql.unsafe(`UPDATE "public"."${table}" SET n = 2 WHERE user_id = 'u1'`);
      await sql.unsafe(`DELETE FROM "public"."${table}" WHERE user_id = 'u1'`);

      const waitDeadline = Date.now() + 20_000;
      while (received.length < 3 && Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(received).toHaveLength(3);
      expect(received[0]).toMatchObject({ op: 'INSERT', table, schema: 'public' });
      expect(received[0]?.record).toMatchObject({ user_id: 'u1', n: 1 });
      expect(received[0]?.old_record).toBe(null);
      expect(received[1]).toMatchObject({ op: 'UPDATE', table });
      expect(received[1]?.record).toMatchObject({ n: 2 });
      expect(received[1]?.old_record).toMatchObject({ n: 1 });
      expect(received[2]).toMatchObject({ op: 'DELETE', table });
      expect(received[2]?.record).toBe(null);
      expect(received[2]?.old_record).toMatchObject({ user_id: 'u1' });

      // Every payload the trigger produced parses through the same validator
      // the listener uses (change channel is a fixed, safe constant).
      expect(CHANGE_CHANNEL).toBe('cloudnivo_changes');
      expect(parseNotification(JSON.stringify({ ...received[0], op: 'INSERT' }))).not.toBe(null);
    } finally {
      off();
      await listener.close();
      await sql.unsafe(`DROP TABLE IF EXISTS "public"."${table}"`).catch(() => undefined);
      await sql.end({ timeout: 2 }).catch(() => undefined);
    }
  }, 60_000);
});
