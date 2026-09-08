import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageService } from './index.js';

describe('storage', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloudnivo-storage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips objects', async () => {
    const svc = new LocalStorageService(dir);
    await svc.put('org-a/logo.txt', 'hello');
    expect(await svc.exists('org-a/logo.txt')).toBe(true);
    expect(new TextDecoder().decode(await svc.get('org-a/logo.txt'))).toBe('hello');
  });

  it('blocks path traversal', async () => {
    const svc = new LocalStorageService(dir);
    await expect(svc.put('../evil.txt', 'x')).rejects.toThrow(/traversal/);
  });
});
