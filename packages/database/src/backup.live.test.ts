import postgres from 'postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, verifyBackup } from './backup.js';

// End-to-end backup → verify against real PostgreSQL. Requires pg_dump /
// pg_restore in PATH plus LIVE_PG_URL=postgres://... (admin). Skipped
// otherwise — pure pieces are covered by backup.test.ts.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('backup + verify on live postgres', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('backs up, verifies clean, and detects drift', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-live-backup-'));
    const admin = postgres(LIVE_PG_URL, { max: 2 });
    const victim = `cn_bak_src_${Date.now() % 100000}`;
    const scratch = `cn_bak_scratch_${Date.now() % 100000}`;
    try {
      await admin.unsafe(`CREATE DATABASE "${victim}"`);
      await admin.unsafe(`CREATE DATABASE "${scratch}"`);
      const srcUrl = LIVE_PG_URL.replace(/\/[^/]*$/, `/${victim}`);
      const scratchUrl = LIVE_PG_URL.replace(/\/[^/]*$/, `/${scratch}`);
      const src = postgres(srcUrl, { max: 2 });
      try {
        await src.unsafe('CREATE TABLE notes (id serial primary key, v text)');
        await src.unsafe(`INSERT INTO notes (v) VALUES ('a'), ('b')`);
      } finally {
        await src.end({ timeout: 2 }).catch(() => undefined);
      }
      const { manifestPath, dumpPath, manifest } = await backupDatabase({
        connectionString: srcUrl,
        outDir: dir,
        appVersion: 'test',
      });
      expect(manifest.tables.map(t => t.name)).toContain('notes');
      const clean = await verifyBackup({ dumpPath, manifestPath, scratchUrl });
      expect(clean.ok).toBe(true);
      expect(clean.checkedTables).toBeGreaterThan(0);
      // Drift the scratch DB: verification must now fail honestly.
      const sc = postgres(scratchUrl, { max: 1 });
      try {
        await sc.unsafe(`INSERT INTO notes (v) VALUES ('drift')`);
      } finally {
        await sc.end({ timeout: 2 }).catch(() => undefined);
      }
      const dirty = await verifyBackup({ dumpPath, manifestPath, scratchUrl });
      expect(dirty.ok).toBe(false);
      expect(dirty.mismatches.join('|')).toContain('row count drift');
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${victim}"`).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
      await admin.end({ timeout: 2 }).catch(() => undefined);
    }
  }, 300_000);
});
