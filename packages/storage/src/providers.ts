import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { StorageError } from './types.js';

/**
 * Provider boundary. Business logic (service.ts, routes) programs against
 * `StorageProvider`; `LocalStorageProvider` persists real bytes on disk,
 * `S3CompatibleProvider` speaks real S3 SigV4 over HTTP. Swapping vendors
 * later changes only the factory.
 */

export interface ObjectStat {
  size: number;
  etag: string;
  mtime: string;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface StorageProvider {
  readonly driver: string;
  /** Stream bytes in (never fully buffered); returns size + sha256 etag. */
  putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts: { maxBytes: number },
  ): Promise<{ size: number; etag: string }>;
  putBytes(
    key: string,
    body: Uint8Array,
    opts?: { maxBytes?: number },
  ): Promise<{ size: number; etag: string }>;
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  getBytes(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<ObjectStat>;
  list(
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ keys: ListedObject[]; total: number }>;
  copy(src: string, dest: string): Promise<void>;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~()-]{0,127}$/;

function assertProviderKey(key: string): string[] {
  const parts = key.replace(/\\/g, '/').split('/');
  if (parts.length < 3 || parts.length > 34) {
    throw new StorageError('INVALID_KEY', 'Bad storage key shape', 400);
  }
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || !SEGMENT_RE.test(p)) {
      throw new StorageError('INVALID_KEY', 'Bad storage key segment', 400);
    }
  }
  return parts;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Local filesystem provider (streaming, real persistence) ─────────────

export class LocalStorageProvider implements StorageProvider {
  readonly driver = 'local';
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    return join(this.baseDir, ...assertProviderKey(key));
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts: { maxBytes: number },
  ): Promise<{ size: number; etag: string }> {
    const dest = this.resolve(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(
      tmpdir(),
      `cn-upload-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    );
    const hash = createHash('sha256');
    let size = 0;
    const guard = new Transform({
      transform(chunk: Uint8Array, _enc, cb) {
        size += chunk.byteLength;
        if (size > opts.maxBytes) {
          cb(new StorageError('FILE_TOO_LARGE', `File exceeds ${opts.maxBytes} bytes`, 413));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(source), guard, createWriteStream(tmp));
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    await rename(tmp, dest);
    return { size, etag: hash.digest('hex') };
  }

  async putBytes(
    key: string,
    body: Uint8Array,
    opts?: { maxBytes?: number },
  ): Promise<{ size: number; etag: string }> {
    if (opts?.maxBytes !== undefined && body.byteLength > opts.maxBytes) {
      throw new StorageError('FILE_TOO_LARGE', `File exceeds ${opts.maxBytes} bytes`, 413);
    }
    return this.putStream(
      key,
      (async function* () {
        yield body;
      })(),
      { maxBytes: opts?.maxBytes ?? body.byteLength },
    );
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const path = this.resolve(key);
    try {
      await stat(path);
    } catch {
      throw new StorageError('NOT_FOUND', 'Object not found', 404);
    }
    return createReadStream(path);
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const stream = (await this.getStream(key)) as AsyncIterable<Uint8Array>;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    // Plain Uint8Array (never Buffer) — safe for JSON transport upstream.
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const st = await stat(this.resolve(key));
      return st.isFile();
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<ObjectStat> {
    try {
      const st = await stat(this.resolve(key));
      if (!st.isFile()) throw new StorageError('NOT_FOUND', 'Object not found', 404);
      return {
        size: st.size,
        etag: `mtime-${Math.floor(st.mtimeMs)}`,
        mtime: st.mtime.toISOString(),
      };
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('NOT_FOUND', 'Object not found', 404);
    }
  }

  async list(
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ keys: ListedObject[]; total: number }> {
    const { readdir } = await import('node:fs/promises');
    const segments = prefix.split('/').filter(Boolean);
    for (const s of segments) {
      if (s === '.' || s === '..' || !SEGMENT_RE.test(s)) {
        throw new StorageError('INVALID_KEY', 'Bad list prefix', 400);
      }
    }
    const root = segments.length > 0 ? join(this.baseDir, ...segments) : this.baseDir;
    const found: ListedObject[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const relChild = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), relChild);
        else if (e.isFile()) {
          const st = await stat(join(dir, e.name));
          found.push({
            key: `${prefix}${prefix.endsWith('/') || prefix === '' ? '' : '/'}${relChild}`,
            size: st.size,
          });
        }
      }
    };
    await walk(root, '');
    found.sort((a, b) => (a.key < b.key ? -1 : 1));
    return { keys: found.slice(offset, offset + limit), total: found.length };
  }

  async copy(src: string, dest: string): Promise<void> {
    const from = this.resolve(src);
    const to = this.resolve(dest);
    await mkdir(dirname(to), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    try {
      await copyFile(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('NOT_FOUND', 'Object not found', 404);
      }
      throw err;
    }
  }
}

// ── S3-compatible provider (SigV4, fetch-injected) ───────────────────────

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: unknown },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }>;
}

function amzDates(now = new Date()): { short: string; long: string } {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  const short = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const long = `${short}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return { short, long };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function s3Sign(
  cfg: Pick<S3Config, 'accessKeyId' | 'secretAccessKey' | 'region'>,
  req: {
    method: string;
    host: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    payloadHash: string;
  },
  now = new Date(),
): { authorization: string; amzDate: string } {
  const { short, long } = amzDates(now);
  const signedNames = Object.keys(req.headers)
    .map(h => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedNames
    .map(n => `${n}:${String(req.headers[n] ?? '').trim()}\n`)
    .join('');
  const canonical = [
    req.method,
    req.path,
    req.query,
    canonicalHeaders,
    signedNames.join(';'),
    req.payloadHash,
  ].join('\n');
  const scope = `${short}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    long,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, short);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
    amzDate: long,
  };
}

export function s3Presign(
  cfg: S3Config,
  method: 'GET' | 'PUT',
  key: string,
  expiresInSeconds: number,
  now = new Date(),
): string {
  const { short, long } = amzDates(now);
  const host = new URL(cfg.endpoint).host;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = cfg.forcePathStyle ? `/${cfg.bucket}/${encodedKey}` : `/${encodedKey}`;
  const scope = `${short}/${cfg.region}/s3/aws4_request`;
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': long,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonical = [
    method,
    path,
    params.toString().replace(/\+/g, '%20'),
    `host:${cfg.forcePathStyle ? host : `${cfg.bucket}.${host}`}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    long,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, short), cfg.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  params.set('X-Amz-Signature', signature);
  const origin = cfg.forcePathStyle
    ? `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}`
    : `https://${cfg.bucket}.${host}`;
  return `${origin}/${encodedKey}?${params.toString()}`;
}

export class S3CompatibleProvider implements StorageProvider {
  readonly driver = 's3';
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly cfg: S3Config,
    fetchFn?: FetchLike,
  ) {
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new StorageError('S3_CONFIG', 'Incomplete S3 configuration', 500);
    }
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  private host(): string {
    const h = new URL(this.cfg.endpoint).host;
    return this.cfg.forcePathStyle ? h : `${this.cfg.bucket}.${h}`;
  }

  private url(key: string, query = ''): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    const base = this.cfg.forcePathStyle
      ? `${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${encoded}`
      : `https://${this.host()}/${encoded}`;
    return query ? `${base}?${query}` : base;
  }

  private signed(
    method: string,
    key: string,
    query: string,
    body: Uint8Array | null,
    contentType?: string,
  ): { url: string; headers: Record<string, string> } {
    const payloadHash = body
      ? sha256Hex(body)
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const headers: Record<string, string> = {
      host: this.host(),
      'x-amz-content-sha256': payloadHash,
    };
    if (contentType) headers['content-type'] = contentType;
    const path = new URL(this.url(key, query)).pathname;
    const { authorization, amzDate } = s3Sign(this.cfg, {
      method,
      host: this.host(),
      path,
      query,
      headers,
      payloadHash,
    });
    headers['x-amz-date'] = amzDate;
    headers['authorization'] = authorization;
    return { url: this.url(key, query), headers };
  }

  private async request(
    method: string,
    key: string,
    body: Uint8Array | null,
    contentType?: string,
    query = '',
  ): Promise<{ status: number; headers: { get(n: string): string | null }; bytes: Uint8Array }> {
    assertProviderKey(key);
    return this.rawRequest(method, key, query, body, contentType);
  }

  private async rawRequest(
    method: string,
    key: string,
    query: string,
    body: Uint8Array | null,
    contentType?: string,
  ): Promise<{ status: number; headers: { get(n: string): string | null }; bytes: Uint8Array }> {
    const { url, headers } = this.signed(method, key, query, body, contentType);
    let res;
    try {
      res = await this.fetchFn(url, { method, headers, body: body ?? undefined });
    } catch (err) {
      throw new StorageError(
        'S3_UNREACHABLE',
        `Storage backend unreachable: ${(err as Error).message.slice(0, 120)}`,
        503,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, bytes: buf };
  }

  private checkStatus(op: string, status: number, body: Uint8Array, okStatuses: number[]): void {
    if (okStatuses.includes(status)) return;
    if (status === 404) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    const msg = Buffer.from(body)
      .toString('utf8', 0, 200)
      .replace(/<[^>]*>/g, ' ')
      .trim();
    throw new StorageError(
      'S3_ERROR',
      `${op} failed (HTTP ${status})${msg ? `: ${msg.slice(0, 120)}` : ''}`,
      502,
    );
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts: { maxBytes: number },
  ): Promise<{ size: number; etag: string }> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      size += chunk.byteLength;
      if (size > opts.maxBytes)
        throw new StorageError('FILE_TOO_LARGE', `File exceeds ${opts.maxBytes} bytes`, 413);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    return this.putBytes(key, body, { maxBytes: opts.maxBytes });
  }

  async putBytes(
    key: string,
    body: Uint8Array,
    opts?: { maxBytes?: number; contentType?: string },
  ): Promise<{ size: number; etag: string }> {
    if (opts?.maxBytes !== undefined && body.byteLength > opts.maxBytes) {
      throw new StorageError('FILE_TOO_LARGE', `File exceeds ${opts.maxBytes} bytes`, 413);
    }
    const r = await this.request('PUT', key, body, opts?.contentType);
    this.checkStatus('Upload', r.status, r.bytes, [200]);
    return {
      size: body.byteLength,
      etag: r.headers.get('etag')?.replace(/"/g, '') ?? sha256Hex(body),
    };
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const bytes = await this.getBytes(key);
    return Readable.from([bytes]);
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const r = await this.request('GET', key, null);
    this.checkStatus('Download', r.status, r.bytes, [200, 206]);
    return r.bytes;
  }

  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', key, null);
    this.checkStatus('Delete', r.status, r.bytes, [200, 204]);
  }

  async exists(key: string): Promise<boolean> {
    const r = await this.request('HEAD', key, null);
    if (r.status === 404) return false;
    this.checkStatus('Stat', r.status, r.bytes, [200]);
    return true;
  }

  async stat(key: string): Promise<ObjectStat> {
    const r = await this.request('HEAD', key, null);
    this.checkStatus('Stat', r.status, r.bytes, [200]);
    return {
      size: Number(r.headers.get('content-length') ?? 0),
      etag: r.headers.get('etag')?.replace(/"/g, '') ?? '',
      mtime: r.headers.get('last-modified') ?? new Date(0).toISOString(),
    };
  }

  async list(
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ keys: ListedObject[]; total: number }> {
    const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    let all: ListedObject[] = [];
    let token = '';
    for (let pages = 0; pages < 20; pages += 1) {
      const q = token
        ? `${params.toString()}&continuation-token=${encodeURIComponent(token)}`
        : params.toString();
      const r = await this.rawRequest('GET', '', q, null);
      this.checkStatus('List', r.status, r.bytes, [200]);
      const xml = Buffer.from(r.bytes).toString('utf8');
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>\s*<Size>(\d+)<\/Size>/g)) {
        all.push({ key: decodeURIComponent(m[1] as string), size: Number(m[2]) });
      }
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated || !next) break;
      token = next;
    }
    all = all.filter(k => k.key !== prefix);
    return { keys: all.slice(offset, offset + limit), total: all.length };
  }

  async copy(src: string, dest: string): Promise<void> {
    assertProviderKey(src);
    assertProviderKey(dest);
    const from = `/${this.cfg.bucket}/${src.split('/').map(encodeURIComponent).join('/')}`;
    const { url, headers } = this.signed('PUT', dest, '', null);
    headers['x-amz-copy-source'] = from;
    const res = await this.fetchFn(url, { method: 'PUT', headers });
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.checkStatus('Copy', res.status, bytes, [200]);
  }

  presignDownload(key: string, expiresInSeconds: number): string {
    assertProviderKey(key);
    return s3Presign(this.cfg, 'GET', key, expiresInSeconds);
  }

  presignUpload(key: string, expiresInSeconds: number): string {
    assertProviderKey(key);
    return s3Presign(this.cfg, 'PUT', key, expiresInSeconds);
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const r = await this.request('POST', key, null, contentType, 'uploads=');
    this.checkStatus('Multipart init', r.status, r.bytes, [200]);
    const id = /<UploadId>([^<]+)<\/UploadId>/.exec(Buffer.from(r.bytes).toString('utf8'))?.[1];
    if (!id) throw new StorageError('S3_ERROR', 'Multipart init returned no upload id', 502);
    return id;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { etag: string; partNumber: number }[],
  ): Promise<void> {
    const xml = `<CompleteMultipartUpload>${parts.map(p => `<Part><ETag>${p.etag}</ETag><PartNumber>${p.partNumber}</PartNumber></Part>`).join('')}</CompleteMultipartUpload>`;
    const body = new TextEncoder().encode(xml);
    const r = await this.request(
      'POST',
      key,
      body,
      'application/xml',
      `uploadId=${encodeURIComponent(uploadId)}`,
    );
    this.checkStatus('Multipart complete', r.status, r.bytes, [200]);
  }
}

export function createStorageProvider(opts: {
  driver: 'local' | 's3';
  localDir?: string;
  s3?: S3Config;
}): StorageProvider {
  if (opts.driver === 'local') return new LocalStorageProvider(opts.localDir ?? './.data/storage');
  if (!opts.s3) throw new StorageError('S3_CONFIG', 'S3 configuration required', 500);
  return new S3CompatibleProvider(opts.s3);
}
