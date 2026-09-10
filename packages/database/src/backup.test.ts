import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  backupDatabase,
  buildManifest,
  collectTableStats,
  compareInventory,
  readManifest,
  redactCommand,
  verifyBackup,
} from './backup.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cn-backup-'));
  dirs.push(dir);
  return dir;
}

function manifestFixture() {
  return buildManifest({
    database: 'cloudnivo',
    host: 'localhost',
    appVersion: '0.1.0',
    tables: [
      { schema: 'public', name: 'users', rows: 3 },
      { schema: 'public', name: 'projects', rows: 1 },
    ],
    dumpFile: 'cn-backup-cloudnivo-x.dump',
    dumpSha256: 'a'.repeat(64),
    dumpBytes: 1234,
  });
}

describe('backup manifest', () => {
  it('builds checksummed manifests with no secrets', () => {
    const m = manifestFixture();
    expect(m.totalRows).toBe(4);
    expect(m.version).toBe(1);
    expect(JSON.stringify(m)).not.toContain('password');
    expect(JSON.stringify(m)).not.toContain('postgres://');
  });

  it('rejects tampering-shaped input', () => {
    expect(() =>
      buildManifest({
        database: 'db; DROP TABLE x',
        host: 'h',
        appVersion: '1',
        tables: [],
        dumpFile: 'f',
        dumpSha256: 'a'.repeat(64),
        dumpBytes: 1,
      }),
    ).toThrow(BackupError);
    expect(() =>
      buildManifest({
        database: 'db',
        host: 'h',
        appVersion: '1',
        tables: [{ schema: 'public', name: 'evil";--', rows: 1 }],
        dumpFile: 'f',
        dumpSha256: 'a'.repeat(64),
        dumpBytes: 1,
      }),
    ).toThrow(BackupError);
    expect(() =>
      buildManifest({
        database: 'db',
        host: 'h',
        appVersion: '1',
        tables: [],
        dumpFile: 'f',
        dumpSha256: 'not-a-hash',
        dumpBytes: 1,
      }),
    ).toThrow(BackupError);
  });

  it('round-trips through disk and rejects corrupt files', async () => {
    const dir = await tempDir();
    const m = manifestFixture();
    const path = join(dir, 'm.json');
    await writeFile(path, JSON.stringify(m));
    const back = await readManifest(path);
    // Re-read re-validates (fresh id); content must be identical.
    expect({ ...back, id: m.id, createdAt: m.createdAt }).toEqual(m);
    await writeFile(join(dir, 'bad.json'), '{nope');
    await expect(readManifest(join(dir, 'bad.json'))).rejects.toThrow(BackupError);
    await writeFile(join(dir, 'evil.json'), JSON.stringify({ ...m, database: 'x"; DROP' }));
    await expect(readManifest(join(dir, 'evil.json'))).rejects.toThrow(BackupError);
  });
});

describe('inventory comparison', () => {
  it('passes identical inventories, reports drift precisely', () => {
    const m = manifestFixture();
    expect(
      compareInventory(m, [
        { schema: 'public', name: 'users', rows: 3 },
        { schema: 'public', name: 'projects', rows: 1 },
      ]).ok,
    ).toBe(true);
    const drift = compareInventory(m, [
      { schema: 'public', name: 'users', rows: 5 },
      { schema: 'public', name: 'extra', rows: 1 },
    ]);
    expect(drift.ok).toBe(false);
    expect(drift.mismatches.join('|')).toContain('row count drift on public.users');
    expect(drift.mismatches.join('|')).toContain('missing table public.projects');
    expect(drift.mismatches.join('|')).toContain('unexpected table public.extra');
  });
});

describe('table stats collection', () => {
  it('lists base tables and counts rows, skipping unsafe names', async () => {
    const calls: string[] = [];
    const stats = await collectTableStats(async text => {
      calls.push(text);
      if (text.includes('information_schema')) {
        return [
          { schema: 'public', name: 'users' },
          { schema: 'public', name: 'weird";--' },
          { schema: 'pg_toast', name: 't' },
        ];
      }
      return [{ n: 7 }];
    });
    expect(stats).toEqual([
      { schema: 'public', name: 'users', rows: 7 },
      { schema: 'pg_toast', name: 't', rows: 7 },
    ]);
    expect(calls.every(c => !c.includes('weird'))).toBe(true);
  });
});

describe('binary + safety paths (no server needed)', () => {
  it('fails honestly when pg_dump is missing', async () => {
    const dir = await tempDir();
    await expect(
      backupDatabase({
        connectionString: 'postgres://u:p@localhost:5432/db',
        outDir: dir,
        pgDumpBin: 'cn-no-such-binary-xyz',
      }),
    ).rejects.toThrow('not installed');
  });

  it('refuses to verify into the source database', async () => {
    const dir = await tempDir();
    const m = manifestFixture();
    await writeFile(join(dir, 'm.json'), JSON.stringify(m));
    await writeFile(join(dir, 'd.dump'), 'fake-bytes');
    await expect(
      verifyBackup({
        dumpPath: join(dir, 'd.dump'),
        manifestPath: join(dir, 'm.json'),
        scratchUrl: 'postgres://u:p@localhost:5432/cloudnivo',
      }),
    ).rejects.toThrow('Refusing to restore into the source database');
  });

  it('redacts credentials from error text', () => {
    expect(redactCommand('connect postgres://admin:s3cret@host/db failed')).not.toContain('s3cret');
    expect(redactCommand('PGPASSWORD=hunter2 pg_dump')).not.toContain('hunter2');
  });
});
