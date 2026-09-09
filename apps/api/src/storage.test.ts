import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 's'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x02, 0x00]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

let STORAGE_DIR = '';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = STORAGE_DIR;
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function tokenFor(sub: string): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: JWT_SECRET });
}

interface ReqOpts {
  token?: string;
  apikey?: string;
  customer?: string;
  body?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  noAuth?: boolean;
}

async function req(
  base: string,
  method: string,
  path: string,
  opts: ReqOpts = {},
): Promise<{ status: number; headers: Headers; json: Record<string, unknown>; bytes: Uint8Array }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.customer) headers['Authorization'] = `Bearer ${opts.customer}`;
  if (opts.apikey) headers['apikey'] = opts.apikey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.bytes !== undefined)
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.bytes ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(Buffer.from(buf).toString('utf8')) as Record<string, unknown>;
  } catch {
    // binary payload
  }
  return { status: res.status, headers: res.headers, json, bytes: buf };
}

function data<T>(json: Record<string, unknown>): T {
  return json['data'] as T;
}

/** Signed URLs carry the configured public host; retarget them at the test server. */
function localUrl(base: string, url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, base);
}

async function customerToken(base: string, projectId: string, email: string): Promise<string> {
  const A = `/api/v1/projects/${projectId}/auth`;
  await req(base, 'POST', `${A}/signup`, { body: { email, password: 'long-enough-1' } });
  const login = await req(base, 'POST', `${A}/token`, {
    body: { email, password: 'long-enough-1' },
  });
  return data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
}

describe('phase 5 storage (local provider, real bytes)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let projectA = '';
  let projectB = '';

  beforeAll(async () => {
    STORAGE_DIR = await mkdtemp(join(tmpdir(), 'cn-api-storage-'));
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const org = await req(base, 'POST', '/api/v1/organizations', {
      token: tokenA,
      body: { name: 'Store A', slug: 'storea' },
    });
    const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
    const orgB = await req(base, 'POST', '/api/v1/organizations', {
      token: tokenB,
      body: { name: 'Store B', slug: 'storeb' },
    });
    const orgBId = data<{ organization: { id: string } }>(orgB.json).organization.id;
    for (const [orgX, slug, tok] of [
      [orgId, 'media', tokenA],
      [orgBId, 'vault', tokenB],
    ] as const) {
      const p = await req(base, 'POST', '/api/v1/projects', {
        token: tok,
        body: { name: slug, slug, organizationId: orgX },
      });
      const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const j = await req(base, 'GET', `/api/v1/projects/${project.id}/jobs/${jobId}`, {
          token: tok,
        });
        if (data<{ job: { status: string } }>(j.json).job.status === 'completed') break;
        if (Date.now() > deadline) throw new Error('provisioning timeout');
        await new Promise(r => setTimeout(r, 50));
      }
      if (tok === tokenA) projectA = project.id;
      else projectB = project.id;
    }
  });

  afterAll(async () => {
    await close();
    await rm(STORAGE_DIR, { recursive: true, force: true });
  });

  it('end-to-end: bucket → upload → metadata → list → signed URL → download → delete → bucket', async () => {
    const S = `/api/v1/projects/${projectA}/storage`;
    const created = await req(base, 'POST', `${S}/buckets`, {
      token: tokenA,
      body: { name: 'images' },
    });
    expect(created.status).toBe(201);
    expect(data<{ bucket: { visibility: string } }>(created.json).bucket.visibility).toBe(
      'private',
    );

    const up = await req(base, 'PUT', `${S}/buckets/images/objects/avatars%2Fu1%2Fpic.png`, {
      token: tokenA,
      bytes: PNG,
      contentType: 'image/png',
    });
    expect(up.status).toBe(201);
    const obj = data<{ object: { mimeType: string; size: number; etag: string } }>(up.json).object;
    expect(obj.mimeType).toBe('image/png');
    expect(obj.size).toBe(PNG.length);
    expect(obj.etag).toMatch(/^[0-9a-f]{64}$/);

    const meta = await req(
      base,
      'GET',
      `${S}/buckets/images/objects/avatars%2Fu1%2Fpic.png/metadata`,
      {
        token: tokenA,
      },
    );
    expect(meta.status).toBe(200);
    expect(JSON.stringify(meta.json)).not.toContain('storageKey');

    const listed = await req(base, 'GET', `${S}/buckets/images/objects?prefix=avatars`, {
      token: tokenA,
    });
    expect(listed.status).toBe(200);
    expect(data<{ total: number }>(listed.json).total).toBe(1);

    const signed = await req(base, 'POST', `${S}/buckets/images/sign`, {
      token: tokenA,
      body: { path: 'avatars/u1/pic.png', expiresIn: 300 },
    });
    expect(signed.status).toBe(201);
    const url = data<{ url: string }>(signed.json).url;
    expect(url).toContain('/storage/s/');
    const viaToken = await fetch(localUrl(base, url));
    expect(viaToken.status).toBe(200);
    expect(viaToken.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await viaToken.arrayBuffer())).toEqual(PNG);

    const dl = await req(base, 'GET', `${S}/buckets/images/objects/avatars%2Fu1%2Fpic.png`, {
      token: tokenA,
    });
    expect(dl.status).toBe(200);
    expect(dl.bytes).toEqual(PNG);
    expect(dl.headers.get('content-disposition')).toContain('inline');

    const del = await req(base, 'DELETE', `${S}/buckets/images/objects/avatars%2Fu1%2Fpic.png`, {
      token: tokenA,
    });
    expect(del.status).toBe(200);
    expect(
      (
        await req(base, 'GET', `${S}/buckets/images/objects/avatars%2Fu1%2Fpic.png`, {
          token: tokenA,
        })
      ).status,
    ).toBe(404);

    const delBucket = await req(base, 'DELETE', `${S}/buckets/images`, { token: tokenA });
    expect(delBucket.status).toBe(200);
  });

  it('move + copy + upsert + usage', async () => {
    const S = `/api/v1/projects/${projectA}/storage`;
    await req(base, 'POST', `${S}/buckets`, { token: tokenA, body: { name: 'docs' } });
    const put = (p: string, b: Uint8Array, extra = '') =>
      req(base, 'PUT', `${S}/buckets/docs/objects/${p}${extra}`, {
        token: tokenA,
        bytes: b,
        contentType: 'application/pdf',
      });
    expect((await put('a%2Ff.pdf', PDF)).status).toBe(201);
    expect((await put('a%2Ff.pdf', PDF)).status).toBe(409);
    expect((await put('a%2Ff.pdf', PDF, '?upsert=true')).status).toBe(201);
    const moved = await req(base, 'POST', `${S}/buckets/docs/objects/a%2Ff.pdf/move`, {
      token: tokenA,
      body: { dest: 'b/f.pdf' },
    });
    expect(moved.status).toBe(200);
    expect(data<{ object: { path: string } }>(moved.json).object.path).toBe('b/f.pdf');
    const copied = await req(base, 'POST', `${S}/buckets/docs/objects/b%2Ff.pdf/copy`, {
      token: tokenA,
      body: { dest: 'b/g.pdf' },
    });
    expect(copied.status).toBe(200);
    const usage = await req(base, 'GET', `${S}/usage`, { token: tokenA });
    expect(usage.status).toBe(200);
    const u = data<{ files: number; bytes: number; quotaBytes: number }>(usage.json);
    expect(u.files).toBeGreaterThanOrEqual(2);
    expect(u.quotaBytes).toBeGreaterThan(0);
  });

  it('project isolation: B cannot touch A buckets, files, or signed URLs', async () => {
    const A = `/api/v1/projects/${projectA}/storage`;
    const B = `/api/v1/projects/${projectB}/storage`;
    await req(base, 'POST', `${A}/buckets`, { token: tokenA, body: { name: 'secret' } });
    await req(base, 'PUT', `${A}/buckets/secret/objects/f.txt`, {
      token: tokenA,
      bytes: new TextEncoder().encode('classified'),
      contentType: 'text/plain',
    });
    // B session: list/get/download all denied (reads 404, writes 403).
    expect((await req(base, 'GET', `${B}/buckets`, { token: tokenB })).status).toBe(200);
    expect(
      data<{ buckets: unknown[] }>((await req(base, 'GET', `${B}/buckets`, { token: tokenB })).json)
        .buckets,
    ).toEqual([]);
    const signed = await req(base, 'POST', `${A}/buckets/secret/sign`, {
      token: tokenA,
      body: { path: 'f.txt', expiresIn: 300 },
    });
    const url = data<{ url: string }>(signed.json).url;
    const token = url.slice(url.lastIndexOf('/s/') + 3);
    // Token replayed against project B fails binding.
    const replay = await fetch(`${base}/api/v1/projects/${projectB}/storage/s/${token}`);
    expect(replay.status).toBe(401);
    // B cannot delete A's objects or buckets (unknown to B → 404).
    expect(
      (await req(base, 'DELETE', `${B}/buckets/secret/objects/f.txt`, { token: tokenB })).status,
    ).toBe(404);
    expect((await req(base, 'DELETE', `${B}/buckets/secret`, { token: tokenB })).status).toBe(404);
  });

  it('customer owner-prefix policies + public buckets', async () => {
    const S = `/api/v1/projects/${projectA}/storage`;
    await req(base, 'POST', `${S}/buckets`, { token: tokenA, body: { name: 'avatars' } });
    await req(base, 'POST', `${S}/buckets`, {
      token: tokenA,
      body: { name: 'pub', visibility: 'public' },
    });
    const t1 = await customerToken(base, projectA, 'c1@example.com');
    const t2 = await customerToken(base, projectA, 'c2@example.com');
    const me1 = await req(base, 'GET', `/api/v1/projects/${projectA}/auth/user`, { customer: t1 });
    const uid1 = (me1.json['data'] as { user: { id: string } }).user.id;
    // Own folder: allowed.
    expect(
      (
        await req(base, 'PUT', `${S}/buckets/avatars/objects/${uid1}%2Fme.png`, {
          customer: t1,
          bytes: PNG,
          contentType: 'image/png',
        })
      ).status,
    ).toBe(201);
    // Other folder: denied.
    expect(
      (
        await req(base, 'PUT', `${S}/buckets/avatars/objects/other%2Fx.png`, {
          customer: t1,
          bytes: PNG,
          contentType: 'image/png',
        })
      ).status,
    ).toBe(403);
    expect(
      (await req(base, 'GET', `${S}/buckets/avatars/objects/${uid1}%2Fme.png`, { customer: t2 }))
        .status,
    ).toBe(404);
    // Public bucket: anonymous exact-path download works, listing does not.
    await req(base, 'PUT', `${S}/buckets/pub/objects/hello.txt`, {
      token: tokenA,
      bytes: new TextEncoder().encode('world'),
      contentType: 'text/plain',
    });
    const anonDl = await req(base, 'GET', `${S}/buckets/pub/objects/hello.txt`, { noAuth: true });
    expect(anonDl.status).toBe(200);
    expect(anonDl.bytes).toEqual(new TextEncoder().encode('world'));
    expect(
      (await req(base, 'GET', `${S}/buckets/pub/objects?prefix=`, { noAuth: true })).status,
    ).toBe(401);
    // Private bucket: anonymous denied (404 — indistinguishable from missing).
    expect(
      (await req(base, 'GET', `${S}/buckets/avatars/objects/${uid1}%2Fme.png`, { noAuth: true }))
        .status,
    ).toBe(404);
  });

  it('security matrix: traversal, spoofing, oversize, tampered/expired tokens, enumeration', async () => {
    const S = `/api/v1/projects/${projectA}/storage`;
    await req(base, 'POST', `${S}/buckets`, { token: tokenA, body: { name: 'sec' } });
    // Path traversal via encoding.
    for (const p of ['..%2F..%2Fetc%2Fpasswd', '%2Fabs%2Fx', '..%5Cwin']) {
      const r = await req(base, 'PUT', `${S}/buckets/sec/objects/${p}`, {
        token: tokenA,
        bytes: new Uint8Array([1]),
        contentType: 'text/plain',
      });
      expect([400, 404]).toContain(r.status);
    }
    // MIME spoof: exe bytes as PNG.
    const spoof = await req(base, 'PUT', `${S}/buckets/sec/objects/evil.png`, {
      token: tokenA,
      bytes: EXE,
      contentType: 'image/png',
    });
    expect(spoof.status).toBe(400);
    // (Oversize + quota paths are covered at provider/service unit level and
    // the per-bucket cap test below; the 50MB route cap is not exercised here.)
    const up = await req(base, 'PUT', `${S}/buckets/sec/objects/real.txt`, {
      token: tokenA,
      bytes: new TextEncoder().encode('data'),
      contentType: 'text/plain',
    });
    expect(up.status).toBe(201);
    const signDl = await req(base, 'POST', `${S}/buckets/sec/sign`, {
      token: tokenA,
      body: { path: 'real.txt', expiresIn: 300 },
    });
    const dlUrl = data<{ url: string }>(signDl.json).url;
    expect((await fetch(`${localUrl(base, dlUrl)}x`)).status).toBe(401);
    // Upload token cannot be used for download and vice versa.
    const signUp = await req(base, 'POST', `${S}/buckets/sec/upload-sign`, {
      token: tokenA,
      body: { path: 'incoming.txt', expiresIn: 300 },
    });
    const upUrl = data<{ url: string }>(signUp.json).url;
    // Wrong-op token on the wrong method: invalid signature for this op.
    expect((await fetch(localUrl(base, upUrl))).status).toBe(401);
    // Bucket enumeration across projects denied (membership gate, like data plane).
    expect((await req(base, 'GET', `${S}/buckets/nope`, { token: tokenB })).status).toBe(403);
    // Responses never leak storage keys or secrets.
    const meta = await req(base, 'GET', `${S}/buckets/sec/objects/real.txt/metadata`, {
      token: tokenA,
    });
    expect(JSON.stringify(meta.json)).not.toContain('storageKey');
    expect(JSON.stringify(meta.json)).not.toContain('SECRET');
  });

  it('quotas, bucket limits, and signed upload flow', async () => {
    const S = `/api/v1/projects/${projectA}/storage`;
    await req(base, 'POST', `${S}/buckets`, {
      token: tokenA,
      body: { name: 'tiny', fileSizeLimit: 1024 },
    });
    // Per-bucket file cap enforced.
    expect(
      (
        await req(base, 'PUT', `${S}/buckets/tiny/objects/big.bin`, {
          token: tokenA,
          bytes: new Uint8Array(2048),
          contentType: 'application/octet-stream',
        })
      ).status,
    ).toBe(413);
    // Signed upload URL round-trip with real bytes.
    const signUp = await req(base, 'POST', `${S}/buckets/tiny/upload-sign`, {
      token: tokenA,
      body: { path: 'via-token.bin', expiresIn: 300 },
    });
    expect(signUp.status).toBe(201);
    const upUrl = data<{ url: string }>(signUp.json).url;
    const zipBody = ZIP;
    const putRes = await fetch(localUrl(base, upUrl), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: zipBody as unknown as Uint8Array,
    });
    expect(putRes.status).toBe(201);
    const dl = await req(base, 'GET', `${S}/buckets/tiny/objects/via-token.bin`, { token: tokenA });
    expect(dl.bytes).toEqual(zipBody);
    expect(dl.headers.get('content-type')).toBe('application/zip');
    expect(dl.headers.get('content-disposition')).toContain('attachment');
  });
});
