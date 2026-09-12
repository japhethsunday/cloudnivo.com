import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptDumpfile, encryptDumpfile, pruneBackups } from './backup-scheduler.js';

const KEY = 'test-backup-passphrase-long-enough';

describe('backup encryption', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips bytes and rejects wrong keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-enc-'));
    const plain = join(dir, 'dump.dump');
    const payload = Buffer.from('postgres-dump-bytes-'.repeat(5000));
    await writeFile(plain, payload);
    const enc = await encryptDumpfile(plain, KEY);
    const encBytes = await readFile(enc);
    expect(encBytes.length).toBeGreaterThan(payload.length);
    expect(encBytes.includes(payload.subarray(0, 32))).toBe(false);
    const out = join(dir, 'restored.dump');
    await decryptDumpfile(enc, KEY, out);
    expect(await readFile(out)).toEqual(payload);
    await expect(decryptDumpfile(enc, 'wrong-passphrase-long-enough', join(dir, 'x'))).rejects.toThrow();
  });

  it('refuses weak keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-enc-'));
    const plain = join(dir, 'dump.dump');
    await writeFile(plain, 'x');
    await expect(encryptDumpfile(plain, 'short')).rejects.toThrow();
  });
});

describe('backup retention', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function group(db: string, stamp: string, enc: boolean): Promise<void> {
    const base = `cn-backup-${db}-${stamp}.dump`;
    await writeFile(join(dir, enc ? `${base}.enc` : base), 'data');
    await writeFile(join(dir, `${base}.manifest.json`), '{}');
  }

  it('keeps the newest N groups and never touches foreign files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-prune-'));
    await group('cloudnivo', '2026-09-01T00-00-00-000Z', true);
    await group('cloudnivo', '2026-09-02T00-00-00-000Z', true);
    await group('cloudnivo', '2026-09-03T00-00-00-000Z', false);
    await group('otherdb', '2026-08-01T00-00-00-000Z', true);
    await writeFile(join(dir, 'notes.txt'), 'do not delete');
    const pruned = await pruneBackups(dir, 'cloudnivo', 2);
    expect(pruned).toHaveLength(2); // oldest group: .enc + manifest
    expect(pruned.some(n => n.includes('2026-09-01'))).toBe(true);
    // Newest groups + other db + foreign file survive.
    await expect(
      readFile(join(dir, 'cn-backup-cloudnivo-2026-09-03T00-00-00-000Z.dump')),
    ).resolves.toBeTruthy();
    await expect(readFile(join(dir, 'notes.txt'), 'utf8')).resolves.toBe('do not delete');
    const pruned2 = await pruneBackups(dir, 'cloudnivo', 2);
    expect(pruned2).toHaveLength(0);
  });
});
