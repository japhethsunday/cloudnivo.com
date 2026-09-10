import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import {
  MemoryStorageMetadataStore,
  ObjectStorageService,
  createStorageProvider,
  dispositionFor,
  type StorageCaller,
  type StorageMetadataStore,
} from '@cloudnivo/storage';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import { resolveCaller, type DataCaller } from './data.js';
import { sendJson } from './projects.js';

/**
 * Customer storage plane: buckets + objects under
 * /api/v1/projects/:projectId/storage/...
 * (the `/storage/v1` namespace, mounted per project so isolation holds by
 * construction — same pattern as the Phase 4 `/auth/*` mount).
 *
 * Uploads stream from the socket to the provider (temp file for local,
 * bounded RAM for S3 assembly); the 1MB JSON cap in v1.ts never applies
 * because these routes read the raw stream themselves.
 */

export interface StorageDeps {
  svc: ObjectStorageService;
}

export function storageFor(ctx: ApiContext): ObjectStorageService {
  const existing = (ctx as unknown as { __storage?: ObjectStorageService }).__storage;
  if (existing) return existing;
  const driver = ctx.config.STORAGE_DRIVER;
  const provider =
    driver === 's3'
      ? createStorageProvider({
          driver: 's3',
          s3: {
            endpoint: ctx.config.STORAGE_S3_ENDPOINT,
            region: ctx.config.STORAGE_S3_REGION,
            bucket: ctx.config.STORAGE_S3_BUCKET,
            accessKeyId: ctx.config.STORAGE_S3_ACCESS_KEY_ID,
            secretAccessKey: ctx.config.STORAGE_S3_SECRET_ACCESS_KEY,
            forcePathStyle: ctx.config.STORAGE_S3_FORCE_PATH_STYLE,
          },
        })
      : createStorageProvider({ driver: 'local', localDir: ctx.config.STORAGE_LOCAL_DIR });
  const secret =
    ctx.config.STORAGE_SIGNING_SECRET.length >= 32
      ? ctx.config.STORAGE_SIGNING_SECRET
      : `${ctx.config.JWT_SECRET.slice(0, 32)}-storage`;
  const meta: StorageMetadataStore =
    (ctx as unknown as { __storageMeta?: StorageMetadataStore }).__storageMeta ??
    new MemoryStorageMetadataStore();
  const svc = new ObjectStorageService(
    provider,
    meta,
    {
      maxBuckets: ctx.config.STORAGE_MAX_BUCKETS,
      quotaBytes: ctx.config.STORAGE_PROJECT_QUOTA_MB * 1024 * 1024,
      defaultMaxFileBytes: ctx.config.STORAGE_MAX_FILE_MB * 1024 * 1024,
      maxSignedTtlSeconds: ctx.config.STORAGE_MAX_SIGNED_TTL_S,
      signingSecret: secret,
    },
    (event, fields) => {
      void ctx.registry
        .recordAudit(event, {
          projectId: typeof fields['projectId'] === 'string' ? fields['projectId'] : undefined,
          organizationId:
            typeof fields['organizationId'] === 'string' ? fields['organizationId'] : undefined,
          userId: typeof fields['userId'] === 'string' ? fields['userId'] : undefined,
        })
        .catch(err => ctx.logger.warn('audit failed', { error: String(err).slice(0, 120) }));
      ctx.logger.info('audit', { event, ...fields });
    },
  );
  (ctx as unknown as { __storage?: ObjectStorageService }).__storage = svc;
  return svc;
}

/** True when /projects/:id/storage... belongs to the storage plane. */
export function isStorageRoute(rest: string[], method: string): boolean {
  if (rest.length < 2 || !rest[0] || rest[1] !== 'storage') return false;
  void method;
  return true;
}

function toStorageCaller(caller: DataCaller): StorageCaller {
  if (caller.kind === 'session') {
    return {
      kind: 'session',
      userId: caller.userId,
      role: caller.role,
      projectId: caller.project.id,
      organizationId: caller.project.organizationId,
    };
  }
  if (caller.kind === 'key') {
    return {
      kind: 'key',
      // Namespace service identity so per-key budgets + audit stay precise.
      userId: `key:${caller.key.id}`,
      role: caller.key.role,
      projectId: caller.project.id,
      organizationId: caller.project.organizationId,
    };
  }
  return {
    kind: 'customer',
    userId: caller.userId,
    role: caller.role,
    projectId: caller.project.id,
    organizationId: caller.project.organizationId,
  };
}

async function storageLimit(
  ctx: ApiContext,
  scope: string,
  action: string,
): Promise<ApiError | null> {
  const r = await checkRateLimit(ctx.rateLimitStore, `${action}:${scope}`, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.STORAGE_RATE_MAX,
    keyPrefix: 'storage',
  });
  return r.allowed ? null : new ApiError('RATE_LIMITED', 'Storage rate limit exceeded', 429);
}

function callerScope(caller: StorageCaller, ip: string): string {
  if (caller.kind === 'key') return `key`;
  return caller.userId ?? `ip:${ip}`;
}

/** Stream the raw request body with a hard byte cap (413 past it). */
async function readRaw(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; sample: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let sample = new Uint8Array(0);
  for await (const chunk of req) {
    const buf = chunk as Uint8Array;
    size += buf.byteLength;
    if (size > maxBytes) {
      // Drain to avoid socket hangups, then fail.
      req.resume();
      throw new ApiError('PAYLOAD_TOO_LARGE', `Body exceeds ${maxBytes} bytes`, 413);
    }
    if (sample.byteLength < 32) {
      const need = 32 - sample.byteLength;
      const take = buf.slice(0, need);
      const next = new Uint8Array(sample.byteLength + take.byteLength);
      next.set(sample, 0);
      next.set(take, sample.byteLength);
      sample = next;
    }
    chunks.push(buf);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { bytes: out, sample: sample.slice(0, 32) };
}

function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string>,
): void {
  res.writeHead(status, { ...headers, 'Content-Length': String(bytes.byteLength) });
  res.end(bytes);
}

const CreateBucketBody = z.object({
  name: z.string().min(3).max(63),
  visibility: z.enum(['public', 'private']).optional(),
  fileSizeLimit: z.number().int().min(1024).nullable().optional(),
  allowedMimeTypes: z.array(z.string().max(80)).max(20).optional(),
  ownerIsolation: z.boolean().optional(),
});

const UpdateBucketBody = z.object({
  visibility: z.enum(['public', 'private']).optional(),
  fileSizeLimit: z.number().int().min(1024).nullable().optional(),
  allowedMimeTypes: z.array(z.string().max(80)).max(20).optional(),
  ownerIsolation: z.boolean().optional(),
});

const DestBody = z.object({ dest: z.string().min(1).max(1024) });
const SignBody = z.object({
  path: z.string().min(1).max(1024),
  op: z.enum(['download', 'upload']).optional(),
  expiresIn: z.number().int().min(60).max(604_800).optional(),
});

function decodePath(segments: string[]): string {
  return segments
    .map(s => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'Bad path encoding', 400);
      }
    })
    .join('/');
}

export async function handleStorageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  config: AppConfig,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
  query: URLSearchParams,
  readJson: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, , ...segs] = rest;
  if (!projectId) return false;
  const start = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  const finish = (status: number, body: unknown, fields: Record<string, unknown> = {}): true => {
    logger.info('storage.request', {
      project: projectId,
      route: segs.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
      ...fields,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const mapped = err instanceof ApiError ? err : err;
    const { status, body } = toPublicError(mapped, requestId);
    return finish(status, body);
  };

  try {
    const svc = storageFor(ctx);
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);

    // Signed-token redemption: the token IS the credential (no headers needed).
    if (segs[0] === 's' && segs[1] && segs.length === 2) {
      const limited = await storageLimit(ctx, `ip:${ip}`, 'sign-redeem');
      if (limited) {
        const { status, body } = toPublicError(limited, requestId);
        return finish(status, body);
      }
      if (req.method === 'GET') {
        const { bucket, path } = svc.verifySigned(projectId, segs[1], 'download');
        const { stream, object, etag } = await svc.downloadSigned(
          projectId,
          project.organizationId,
          bucket,
          path,
        );
        void etag;
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.byteLength;
        }
        sendBytes(res, 200, out, {
          ...baseHeaders,
          'Content-Type': object.mimeType,
          'Content-Disposition': dispositionFor(object.mimeType, object.filename),
          ETag: `"${object.etag}"`,
        });
        return true;
      }
      if (req.method === 'PUT') {
        const { bucket, path } = svc.verifySigned(projectId, segs[1], 'upload');
        const maxBytes = config.STORAGE_MAX_FILE_MB * 1024 * 1024;
        const { bytes, sample } = await readRaw(req, maxBytes);
        const record = await svc.putSigned(projectId, project.organizationId, bucket, path, {
          contentType: req.headers['content-type'] ?? null,
          source: (async function* () {
            yield bytes;
          })(),
          sample,
        });
        return finish(201, ok({ object: record }, requestId));
      }
      return finish(405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
      });
    }

    // Everything else needs a caller (anonymous allowed for public downloads).
    let caller: StorageCaller;
    try {
      const resolved = await resolveCaller(ctx, req, projectId);
      caller = toStorageCaller(resolved);
      if (resolved.kind === 'key') await ctx.keys.touch(resolved.key.id);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'UNAUTHORIZED' &&
        req.method === 'GET' &&
        segs[0] === 'buckets'
      ) {
        caller = {
          kind: 'anonymous',
          userId: null,
          role: 'anonymous',
          projectId,
          organizationId: project.organizationId,
        };
      } else {
        throw err;
      }
    }
    const limited = await storageLimit(ctx, callerScope(caller, ip), `${req.method}`);
    if (limited) {
      const { status, body } = toPublicError(limited, requestId);
      return finish(status, body, { caller: caller.kind });
    }

    // ── Usage ──
    if (segs[0] === 'usage' && segs.length === 1 && req.method === 'GET') {
      if (caller.kind === 'anonymous')
        throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
      return finish(200, ok(await svc.usage(caller), requestId), { caller: caller.kind });
    }

    // ── Buckets ──
    if (segs[0] === 'buckets' && segs.length === 1) {
      if (req.method === 'GET') {
        if (caller.kind === 'anonymous')
          throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
        return finish(200, ok({ buckets: await svc.listBuckets(caller) }, requestId), {
          caller: caller.kind,
        });
      }
      if (req.method === 'POST') {
        const parsed = parseBody(CreateBucketBody, await readJson());
        const bucket = await svc.createBucket(caller, {
          name: parsed.name,
          visibility: parsed.visibility,
          fileSizeLimit: parsed.fileSizeLimit ?? undefined,
          allowedMimeTypes: parsed.allowedMimeTypes,
          ownerIsolation: parsed.ownerIsolation,
        });
        return finish(201, ok({ bucket }, requestId), { caller: caller.kind });
      }
      return finish(405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
      });
    }

    if (segs[0] === 'buckets' && segs[1] && segs.length === 2) {
      const bucketName = decodeURIComponent(segs[1]);
      if (req.method === 'GET') {
        if (caller.kind === 'anonymous')
          throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
        return finish(200, ok({ bucket: await svc.getBucket(caller, bucketName) }, requestId), {
          caller: caller.kind,
        });
      }
      if (req.method === 'PATCH') {
        const parsed = parseBody(UpdateBucketBody, await readJson());
        return finish(
          200,
          ok({ bucket: await svc.updateBucket(caller, bucketName, parsed) }, requestId),
          { caller: caller.kind },
        );
      }
      if (req.method === 'DELETE') {
        await svc.deleteBucket(caller, bucketName);
        return finish(200, ok({ deleted: true }, requestId), { caller: caller.kind });
      }
      return finish(405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
      });
    }

    // ── Object listing ──
    if (
      segs[0] === 'buckets' &&
      segs[1] &&
      segs[2] === 'objects' &&
      segs.length === 3 &&
      req.method === 'GET'
    ) {
      if (caller.kind === 'anonymous')
        throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
      const bucketName = decodeURIComponent(segs[1]);
      const prefix = query.get('prefix') ?? '';
      const limit = query.get('limit') ? Number(query.get('limit')) : 50;
      const offset = query.get('offset') ? Number(query.get('offset')) : 0;
      const { objects, total } = await svc.list(caller, bucketName, prefix, limit, offset);
      return finish(200, ok({ objects, total, limit, offset }, requestId), { caller: caller.kind });
    }

    // ── Sign URLs ──
    if (
      segs[0] === 'buckets' &&
      segs[1] &&
      segs[2] === 'sign' &&
      segs.length === 3 &&
      req.method === 'POST'
    ) {
      if (caller.kind === 'anonymous')
        throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
      const parsed = parseBody(SignBody, await readJson());
      const out = await svc.sign(
        caller,
        decodeURIComponent(segs[1]),
        parsed.path,
        parsed.op ?? 'download',
        parsed.expiresIn ?? 3600,
      );
      const base = `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/projects/${projectId}/storage/s/${out.token}`;
      return finish(201, ok({ url: base, expiresAt: out.expiresAt }, requestId), {
        caller: caller.kind,
      });
    }
    if (
      segs[0] === 'buckets' &&
      segs[1] &&
      segs[2] === 'upload-sign' &&
      segs.length === 3 &&
      req.method === 'POST'
    ) {
      if (caller.kind === 'anonymous')
        throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
      const parsed = parseBody(SignBody, await readJson());
      const out = await svc.sign(
        caller,
        decodeURIComponent(segs[1]),
        parsed.path,
        'upload',
        parsed.expiresIn ?? 3600,
      );
      const base = `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/projects/${projectId}/storage/s/${out.token}`;
      return finish(201, ok({ url: base, expiresAt: out.expiresAt, method: 'PUT' }, requestId), {
        caller: caller.kind,
      });
    }

    // ── Objects: /buckets/:b/objects/<path...>[/metadata|/move|/copy] ──
    if (segs[0] === 'buckets' && segs[1] && segs[2] === 'objects' && segs.length >= 4) {
      const bucketName = decodeURIComponent(segs[1]);
      const tail = segs.slice(3);
      const last = tail[tail.length - 1] as string;
      if ((last === 'metadata' || last === 'move' || last === 'copy') && tail.length >= 2) {
        const objectPath = decodePath(tail.slice(0, -1));
        if (caller.kind === 'anonymous')
          throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
        if (last === 'metadata' && req.method === 'GET') {
          return finish(
            200,
            ok({ object: await svc.metadata(caller, bucketName, objectPath) }, requestId),
            {
              caller: caller.kind,
            },
          );
        }
        if ((last === 'move' || last === 'copy') && req.method === 'POST') {
          const parsed = parseBody(DestBody, await readJson());
          const object =
            last === 'move'
              ? await svc.move(caller, bucketName, objectPath, parsed.dest)
              : await svc.copy(caller, bucketName, objectPath, parsed.dest);
          return finish(200, ok({ object }, requestId), { caller: caller.kind });
        }
        return finish(405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
        });
      }
      const objectPath = decodePath(tail);
      if (req.method === 'GET') {
        const { stream, object } = await svc.download(caller, bucketName, objectPath);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.byteLength;
        }
        sendBytes(res, 200, out, {
          ...baseHeaders,
          'Content-Type': object.mimeType,
          'Content-Disposition': dispositionFor(object.mimeType, object.filename),
          ETag: `"${object.etag}"`,
        });
        logger.info('storage.request', {
          project: projectId,
          route: 'object-download',
          status: 200,
          latencyMs: Date.now() - start,
          bytes: out.byteLength,
        });
        return true;
      }
      if (req.method === 'PUT') {
        if (caller.kind === 'anonymous')
          throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
        const maxBytes = config.STORAGE_MAX_FILE_MB * 1024 * 1024;
        const { bytes, sample } = await readRaw(req, maxBytes);
        const upsert = query.get('upsert') === 'true';
        const record = await svc.upload({
          caller,
          bucket: bucketName,
          path: objectPath,
          contentType: req.headers['content-type'] ?? null,
          source: (async function* () {
            yield bytes;
          })(),
          sample,
          upsert,
        });
        return finish(201, ok({ object: record }, requestId), { caller: caller.kind });
      }
      if (req.method === 'DELETE') {
        if (caller.kind === 'anonymous')
          throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
        await svc.remove(caller, bucketName, objectPath);
        return finish(200, ok({ deleted: true }, requestId), { caller: caller.kind });
      }
      return finish(405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
      });
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
