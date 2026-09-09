import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageMetadataStore } from './metadata.js';
import { LocalStorageProvider, S3CompatibleProvider, s3Sign, type FetchLike } from './providers.js';
import { ObjectStorageService } from './service.js';
import type { StorageCaller } from './types.js';

const PID = '11111111-1111-4111-8111-111111111111';

function admin(): StorageCaller {
  return {
    kind: 'session',
    userId: 'u-admin',
    role: 'admin',
    projectId: PID,
    organizationId: 'o1',
  };
}

function serviceFor(dir: string, over: Partial<Parameters<typeof makeService>[0]> = {}) {
  return makeService({ dir, ...over });
}

function makeService(opts: {
  dir: string;
  quotaBytes?: number;
  defaultMaxFileBytes?: number;
  maxBuckets?: number;
}) {
  const provider = new LocalStorageProvider(opts.dir);
  const meta = new MemoryStorageMetadataStore();
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const svc = new ObjectStorageService(
    provider,
    meta,
    {
      maxBuckets: opts.maxBuckets ?? 20,
      quotaBytes: opts.quotaBytes ?? 10_000_000,
      defaultMaxFileBytes: opts.defaultMaxFileBytes ?? 5_000_000,
      maxSignedTtlSeconds: 3600,
      signingSecret: 's'.repeat(48),
    },
    (event, fields) => events.push({ event, fields }),
  );
  return { svc, meta, provider, events };
}

function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    const half = Math.ceil(bytes.length / 2);
    yield bytes.slice(0, half);
    yield bytes.slice(half);
  })();
}

describe('local provider (real filesystem)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams bytes in and back with etag', async () => {
    const p = new LocalStorageProvider(dir);
    const body = new TextEncoder().encode('hello-storage-world');
    const put = await p.putStream('p_x/b_y/a.bin', streamOf(body), { maxBytes: 1000 });
    expect(put.size).toBe(body.length);
    expect(put.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.exists('p_x/b_y/a.bin')).toBe(true);
    expect(await p.getBytes('p_x/b_y/a.bin')).toEqual(body);
    await p.delete('p_x/b_y/a.bin');
    expect(await p.exists('p_x/b_y/a.bin')).toBe(false);
  });

  it('aborts oversized streams without persisting', async () => {
    const p = new LocalStorageProvider(dir);
    await expect(
      p.putStream('p_x/b_y/big.bin', streamOf(new Uint8Array(100)), { maxBytes: 10 }),
    ).rejects.toThrow(/exceeds/);
    expect(await p.exists('p_x/b_y/big.bin')).toBe(false);
  });

  it('copies + lists with prefix', async () => {
    const p = new LocalStorageProvider(dir);
    await p.putBytes('p_x/b_y/a/1.txt', new TextEncoder().encode('1'));
    await p.putBytes('p_x/b_y/a/2.txt', new TextEncoder().encode('22'));
    await p.copy('p_x/b_y/a/1.txt', 'p_x/b_y/b/1.txt');
    const listed = await p.list('p_x/b_y', 10, 0);
    expect(listed.total).toBe(3);
    expect(listed.keys.map(k => k.key)).toEqual([
      'p_x/b_y/a/1.txt',
      'p_x/b_y/a/2.txt',
      'p_x/b_y/b/1.txt',
    ]);
  });
});

describe('buckets + quotas through the service', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cn-svc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates/updates/deletes buckets with limits', async () => {
    const { svc } = serviceFor(dir, { maxBuckets: 1 });
    const b = await svc.createBucket(admin(), { name: 'docs' });
    expect(b.visibility).toBe('private');
    await expect(svc.createBucket(admin(), { name: 'docs' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(svc.createBucket(admin(), { name: 'more' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    const updated = await svc.updateBucket(admin(), 'docs', { visibility: 'public' });
    expect(updated.visibility).toBe('public');
    await svc.deleteBucket(admin(), 'docs');
    expect(await svc.listBuckets(admin())).toHaveLength(0);
  });

  it('refuses to delete non-empty buckets', async () => {
    const { svc } = serviceFor(dir);
    await svc.createBucket(admin(), { name: 'docs' });
    const body = new TextEncoder().encode('x');
    await svc.upload({
      caller: admin(),
      bucket: 'docs',
      path: 'a.txt',
      contentType: 'text/plain',
      source: streamOf(body),
      sample: body,
    });
    await expect(svc.deleteBucket(admin(), 'docs')).rejects.toMatchObject({
      code: 'BUCKET_NOT_EMPTY',
    });
  });

  it('enforces quotas and tracks usage', async () => {
    const { svc } = serviceFor(dir, { quotaBytes: 100 });
    await svc.createBucket(admin(), { name: 'docs' });
    const big = new Uint8Array(80);
    await svc.upload({
      caller: admin(),
      bucket: 'docs',
      path: 'a.bin',
      contentType: null,
      source: streamOf(big),
      sample: big.slice(0, 8),
    });
    const usage = await svc.usage(admin());
    expect(usage.bytes).toBe(80);
    expect(usage.files).toBe(1);
    expect(usage.quotaBytes).toBe(100);
    const more = new Uint8Array(30);
    await expect(
      svc.upload({
        caller: admin(),
        bucket: 'docs',
        path: 'b.bin',
        contentType: null,
        source: streamOf(more),
        sample: more.slice(0, 8),
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('mime allowlists + spoof rejection at upload', async () => {
    const { svc } = serviceFor(dir);
    await svc.createBucket(admin(), { name: 'imgs', allowedMimeTypes: ['image/'] });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await svc.upload({
      caller: admin(),
      bucket: 'imgs',
      path: 'a.png',
      contentType: 'image/png',
      source: streamOf(png),
      sample: png,
    });
    expect(up.mimeType).toBe('image/png');
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await expect(
      svc.upload({
        caller: admin(),
        bucket: 'imgs',
        path: 'b.pdf',
        contentType: 'application/pdf',
        source: streamOf(pdf),
        sample: pdf,
      }),
    ).rejects.toMatchObject({ code: 'MIME_NOT_ALLOWED' });
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    await expect(
      svc.upload({
        caller: admin(),
        bucket: 'imgs',
        path: 'evil.png',
        contentType: 'image/png',
        source: streamOf(exe),
        sample: exe,
      }),
    ).rejects.toMatchObject({ code: 'MIME_REJECTED' });
  });
});

describe('S3 provider (real SigV4, stubbed transport)', () => {
  const cfg = {
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    forcePathStyle: true,
  };

  it('signs deterministically and binds every input', () => {
    const req = {
      method: 'GET',
      host: 's3.example.com',
      path: '/test-bucket/a.txt',
      query: '',
      headers: { host: 's3.example.com', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      payloadHash: 'UNSIGNED-PAYLOAD',
    };
    const a = s3Sign(cfg, req, new Date('2026-01-01T00:00:00Z'));
    const b = s3Sign(cfg, req, new Date('2026-01-01T00:00:00Z'));
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/s3\/aws4_request/,
    );
    const other = s3Sign(
      { ...cfg, secretAccessKey: 'different-secret-key-here-0123456789' },
      req,
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(other.authorization).not.toBe(a.authorization);
    const later = s3Sign(cfg, req, new Date('2026-01-02T00:00:00Z'));
    expect(later.authorization).not.toBe(a.authorization);
    expect(later.amzDate).toBe('20260102T000000Z');
  });

  it('forms correct REST requests (method/host/auth)', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const stub: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      return {
        status: 200,
        headers: { get: (n: string) => (n === 'etag' ? '"abc"' : null) },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        text: async () => '',
      };
    };
    const s3 = new S3CompatibleProvider(cfg, stub);
    await s3.putBytes('p_x/b_y/a.txt', new Uint8Array([1, 2, 3]), { contentType: 'text/plain' });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('https://s3.example.com/test-bucket/p_x/b_y/a.txt');
    expect(calls[0]?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    await s3.getBytes('p_x/b_y/a.txt');
    expect(calls[1]?.method).toBe('GET');
  });

  it('surfaces backend outages as 503, missing as 404', async () => {
    const down: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(
      new S3CompatibleProvider(cfg, down).getBytes('p_x/b_y/a.txt'),
    ).rejects.toMatchObject({
      code: 'S3_UNREACHABLE',
    });
    const gone: FetchLike = async () => ({
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array().buffer,
      text: async () => '',
    });
    await expect(
      new S3CompatibleProvider(cfg, gone).getBytes('p_x/b_y/a.txt'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
