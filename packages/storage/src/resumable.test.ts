import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStorageMetadataStore } from './metadata.js';
import { createStorageProvider } from './providers.js';
import { ObjectStorageService } from './service.js';
import type { StorageCaller } from './types.js';

const PID = '11111111-1111-4111-8111-111111111111';

function caller(): StorageCaller {
  return { kind: 'session', userId: 'u1', role: 'owner', projectId: PID, organizationId: 'o1' };
}

async function service() {
  const dir = await mkdtemp(join(tmpdir(), 'cn-resumable-'));
  const svc = new ObjectStorageService(
    createStorageProvider({ driver: 'local', localDir: dir }),
    new MemoryStorageMetadataStore(),
    {
      maxBuckets: 10,
      quotaBytes: 100 * 1024 * 1024,
      defaultMaxFileBytes: 10 * 1024 * 1024,
      maxSignedTtlSeconds: 3600,
      signingSecret: 's'.repeat(40),
    },
    () => undefined,
  );
  await svc.createBucket(caller(), { name: 'files' });
  return { svc, dir };
}

function chunk(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(text);
  })();
}

describe('resumable uploads', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('assembles out-of-order parts and validates on complete', async () => {
    const s = await service();
    dir = s.dir;
    const created = await s.svc.createUploadSession(caller(), {
      bucket: 'files',
      path: 'big.txt',
      contentType: 'text/plain',
      totalBytes: 11,
    });
    expect(created.status).toBe('active');
    // Parts arrive out of order; retries are idempotent.
    await s.svc.uploadPart(caller(), created.id, 1, chunk('world'));
    await s.svc.uploadPart(caller(), created.id, 0, chunk('hello '));
    await s.svc.uploadPart(caller(), created.id, 1, chunk('world'));
    const status = await s.svc.getUploadSession(caller(), created.id);
    expect(status.parts).toEqual([0, 1]);
    const object = await s.svc.completeUploadSession(caller(), created.id);
    expect(object.size).toBe(11);
    const listed = await s.svc.analytics(caller());
    expect(listed.totals.files).toBe(1);
    expect(listed.totals.bytes).toBe(11);
    expect(listed.buckets[0]).toMatchObject({ name: 'files', files: 1, bytes: 11 });
  });

  it('refuses gaps, expiry, and foreign projects', async () => {
    const s = await service();
    dir = s.dir;
    const created = await s.svc.createUploadSession(caller(), { bucket: 'files', path: 'gap.txt' });
    await s.svc.uploadPart(caller(), created.id, 2, chunk('zzz'));
    await expect(s.svc.completeUploadSession(caller(), created.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    const stranger = { ...caller(), projectId: '22222222-2222-4222-8222-222222222222' };
    await expect(s.svc.getUploadSession(stranger, created.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await s.svc.abortUploadSession(caller(), created.id);
    await expect(s.svc.getUploadSession(caller(), created.id)).rejects.toMatchObject({
      code: 'UPLOAD_EXPIRED',
    });
    await expect(s.svc.uploadPart(caller(), created.id, 0, chunk('x'))).rejects.toMatchObject({
      code: 'UPLOAD_EXPIRED',
    });
  });

  it('rejects bad part indexes and oversized declarations', async () => {
    const s = await service();
    dir = s.dir;
    await expect(
      s.svc.createUploadSession(caller(), { bucket: 'nope', path: 'a.txt' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      s.svc.createUploadSession(caller(), {
        bucket: 'files',
        path: 'huge.bin',
        totalBytes: 1_000_000_000,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const created = await s.svc.createUploadSession(caller(), { bucket: 'files', path: 'ok.txt' });
    await expect(s.svc.uploadPart(caller(), created.id, 1000, chunk('x'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
