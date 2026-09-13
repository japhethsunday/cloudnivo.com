import { authorize } from './policies.js';
import { signToken, verifyToken } from './signed-urls.js';
import { resolveMime } from './mime.js';
import { assertBucketName, assertObjectPath, fileNameOf, storageKeyFor } from './validation.js';
import type { StorageMetadataStore, UploadSession } from './metadata.js';
import type { StorageProvider } from './providers.js';
import {
  StorageError,
  exposeObject,
  type Bucket,
  type ExposedObject,
  type StorageCaller,
  type StorageEvent,
  type StorageOp,
} from './types.js';

/**
 * Object storage orchestrator: buckets + objects + quotas + signed URLs.
 * Binds a provider (bytes) to a metadata store (records) with policy checks
 * on every operation. No route touches a provider directly.
 */

export interface StorageServiceOptions {
  maxBuckets: number;
  quotaBytes: number;
  defaultMaxFileBytes: number;
  maxSignedTtlSeconds: number;
  signingSecret: string;
}

export interface UploadInput {
  caller: StorageCaller;
  bucket: string;
  path: string;
  contentType: string | null;
  source: AsyncIterable<Uint8Array>;
  sample: Uint8Array;
  upsert?: boolean;
}

export class ObjectStorageService {
  constructor(
    private readonly provider: StorageProvider,
    private readonly meta: StorageMetadataStore,
    private readonly opts: StorageServiceOptions,
    private readonly audit: (event: StorageEvent, fields: Record<string, unknown>) => void,
  ) {
    if (opts.signingSecret.length < 32) {
      throw new StorageError('WEAK_SECRET', 'Storage signing secret too short', 500);
    }
  }

  private check(bucket: Bucket, caller: StorageCaller, op: StorageOp, path: string | null): void {
    if (caller.projectId !== bucket.projectId) {
      throw new StorageError('TENANT_FORBIDDEN', 'Bucket belongs to another project', 403);
    }
    const verdict = authorize(bucket, caller, op, path);
    if (!verdict.allowed) {
      // Reads fail as 404 (no existence oracle); writes fail as 403.
      const read = op === 'object:download' || op === 'object:list';
      throw new StorageError(
        read ? 'NOT_FOUND' : 'FORBIDDEN',
        verdict.reason ?? 'Denied',
        read ? 404 : 403,
      );
    }
  }

  private async bucketFor(
    projectId: string,
    organizationId: string,
    name: string,
  ): Promise<Bucket> {
    const bucket = await this.meta.getBucket(projectId, assertBucketName(name));
    if (!bucket || bucket.organizationId !== organizationId) {
      // No org oracle: unknown and foreign buckets look identical.
      throw new StorageError('NOT_FOUND', 'Bucket not found', 404);
    }
    return bucket;
  }

  async createBucket(
    caller: StorageCaller,
    input: {
      name: string;
      visibility?: 'public' | 'private';
      fileSizeLimit?: number | null;
      allowedMimeTypes?: string[];
      ownerIsolation?: boolean;
    },
  ): Promise<Bucket> {
    if (caller.kind !== 'session' || (caller.role !== 'owner' && caller.role !== 'admin')) {
      // Mirror data-plane key rules: only platform admins/owners manage buckets.
      if (caller.kind === 'session') {
        throw new StorageError('FORBIDDEN', 'Bucket management requires admin', 403);
      }
      throw new StorageError('FORBIDDEN', 'API keys cannot manage buckets', 403);
    }
    const name = assertBucketName(input.name);
    if (await this.meta.getBucket(caller.projectId, name)) {
      throw new StorageError('CONFLICT', 'Bucket already exists', 409);
    }
    if ((await this.meta.countBuckets(caller.projectId)) >= this.opts.maxBuckets) {
      throw new StorageError('LIMIT_EXCEEDED', 'Maximum number of buckets reached', 403);
    }
    if (input.fileSizeLimit !== undefined && input.fileSizeLimit !== null) {
      if (
        !Number.isInteger(input.fileSizeLimit) ||
        input.fileSizeLimit < 1024 ||
        input.fileSizeLimit > this.opts.defaultMaxFileBytes * 10
      ) {
        throw new StorageError('INVALID_LIMIT', 'Bad per-bucket file size limit', 400);
      }
    }
    const allowed = (input.allowedMimeTypes ?? []).slice(0, 20);
    for (const m of allowed) {
      if (!/^[a-z0-9.+-]+\/([a-z0-9.*+-]+)?$/.test(m)) {
        throw new StorageError('INVALID_MIME', `Bad MIME filter: ${m.slice(0, 60)}`, 400);
      }
    }
    try {
      const bucket = await this.meta.createBucket({
        organizationId: caller.organizationId,
        projectId: caller.projectId,
        name,
        visibility: input.visibility ?? 'private',
        fileSizeLimit: input.fileSizeLimit ?? null,
        allowedMimeTypes: allowed,
        ownerIsolation: input.ownerIsolation ?? true,
      });
      this.audit('bucket.created', { projectId: caller.projectId, bucket: name });
      return bucket;
    } catch (err) {
      if ((err as { code?: string }).code === 'BUCKET_EXISTS') {
        throw new StorageError('CONFLICT', 'Bucket already exists', 409);
      }
      throw err;
    }
  }

  async listBuckets(caller: StorageCaller): Promise<Bucket[]> {
    return this.meta.listBuckets(caller.projectId);
  }

  async getBucket(caller: StorageCaller, name: string): Promise<Bucket> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, name);
    this.check(bucket, caller, 'bucket:read', null);
    return bucket;
  }

  async updateBucket(
    caller: StorageCaller,
    name: string,
    patch: {
      visibility?: 'public' | 'private';
      fileSizeLimit?: number | null;
      allowedMimeTypes?: string[];
      ownerIsolation?: boolean;
    },
  ): Promise<Bucket> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, name);
    this.check(bucket, caller, 'bucket:update', null);
    if (patch.fileSizeLimit !== undefined && patch.fileSizeLimit !== null) {
      if (!Number.isInteger(patch.fileSizeLimit) || patch.fileSizeLimit < 1024) {
        throw new StorageError('INVALID_LIMIT', 'Bad per-bucket file size limit', 400);
      }
    }
    if (patch.allowedMimeTypes !== undefined) {
      if (patch.allowedMimeTypes.length > 20) {
        throw new StorageError('INVALID_MIME', 'Too many MIME filters', 400);
      }
      for (const m of patch.allowedMimeTypes) {
        if (!/^[a-z0-9.+-]+\/([a-z0-9.*+-]+)?$/.test(m)) {
          throw new StorageError('INVALID_MIME', `Bad MIME filter: ${m.slice(0, 60)}`, 400);
        }
      }
    }
    const updated = await this.meta.updateBucket(caller.projectId, name, patch);
    if (!updated) throw new StorageError('NOT_FOUND', 'Bucket not found', 404);
    this.audit('bucket.updated', { projectId: caller.projectId, bucket: name });
    return updated;
  }

  async deleteBucket(caller: StorageCaller, name: string): Promise<void> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, name);
    this.check(bucket, caller, 'bucket:delete', null);
    if ((await this.meta.countObjectsInBucket(caller.projectId, name)) > 0) {
      throw new StorageError('BUCKET_NOT_EMPTY', 'Bucket is not empty', 409);
    }
    await this.meta.deleteBucket(caller.projectId, name);
    this.audit('bucket.deleted', { projectId: caller.projectId, bucket: name });
  }

  private quotaBytes(): number {
    return this.opts.quotaBytes;
  }

  async upload(input: UploadInput): Promise<ExposedObject> {
    const bucket = await this.bucketFor(
      input.caller.projectId,
      input.caller.organizationId,
      input.bucket,
    );
    const path = assertObjectPath(input.path);
    this.check(bucket, input.caller, 'object:upload', path);
    const maxBytes = Math.min(
      bucket.fileSizeLimit ?? this.opts.defaultMaxFileBytes,
      this.opts.defaultMaxFileBytes,
    );
    const filename = fileNameOf(path);
    let mime: string;
    try {
      const resolved = resolveMime(input.contentType, filename, input.sample);
      mime = resolved.mime;
    } catch (err) {
      throw new StorageError('MIME_REJECTED', (err as Error).message, 400);
    }
    if (
      bucket.allowedMimeTypes.length > 0 &&
      !bucket.allowedMimeTypes.some(p => mime.startsWith(p))
    ) {
      throw new StorageError('MIME_NOT_ALLOWED', `MIME ${mime} not allowed in this bucket`, 400);
    }
    const existing = await this.meta.getObject(input.caller.projectId, bucket.name, path);
    if (existing && !input.upsert) {
      throw new StorageError('CONFLICT', 'Object exists (use upsert to overwrite)', 409);
    }
    const usage = await this.meta.usage(input.caller.projectId);
    if (usage.bytes >= this.quotaBytes()) {
      throw new StorageError('QUOTA_EXCEEDED', 'Project storage quota exceeded', 403);
    }
    const key = storageKeyFor(input.caller.projectId, bucket.name, path);
    const { size, etag } = await this.provider.putStream(key, input.source, { maxBytes });
    if (usage.bytes + size > this.quotaBytes()) {
      await this.provider.delete(key).catch(() => undefined);
      throw new StorageError('QUOTA_EXCEEDED', 'Project storage quota exceeded', 403);
    }
    const record = await this.meta.putObject({
      organizationId: input.caller.organizationId,
      projectId: input.caller.projectId,
      bucketId: bucket.id,
      bucket: bucket.name,
      path,
      filename,
      mimeType: mime,
      size,
      etag,
      storageKey: key,
      metadata: {},
    });
    if (existing) {
      await this.meta.adjustUsage(input.caller.projectId, 0, size - existing.size);
    } else {
      await this.meta.recordUpload(input.caller.projectId, size);
    }
    this.audit(existing ? 'file.updated' : 'file.uploaded', {
      projectId: input.caller.projectId,
      bucket: bucket.name,
      path,
      size,
    });
    return exposeObject(record);
  }

  /**
   * Token-bound upload: the capability token already authorized this exact
   * (project, bucket, path). Bucket rules, MIME checks, and quotas still
   * apply — only the caller-policy step is satisfied by the token itself.
   */
  async putSigned(
    projectId: string,
    organizationId: string,
    bucketName: string,
    rawPath: string,
    input: {
      contentType: string | null;
      source: AsyncIterable<Uint8Array>;
      sample: Uint8Array;
      upsert?: boolean;
    },
  ): Promise<ExposedObject> {
    const bucket = await this.bucketFor(projectId, organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    const maxBytes = Math.min(
      bucket.fileSizeLimit ?? this.opts.defaultMaxFileBytes,
      this.opts.defaultMaxFileBytes,
    );
    const filename = fileNameOf(path);
    let mime: string;
    try {
      mime = resolveMime(input.contentType, filename, input.sample).mime;
    } catch (err) {
      throw new StorageError('MIME_REJECTED', (err as Error).message, 400);
    }
    if (
      bucket.allowedMimeTypes.length > 0 &&
      !bucket.allowedMimeTypes.some(p => mime.startsWith(p))
    ) {
      throw new StorageError('MIME_NOT_ALLOWED', `MIME ${mime} not allowed in this bucket`, 400);
    }
    const existing = await this.meta.getObject(projectId, bucket.name, path);
    if (existing && !input.upsert) {
      throw new StorageError('CONFLICT', 'Object exists (use upsert to overwrite)', 409);
    }
    const usage = await this.meta.usage(projectId);
    if (usage.bytes >= this.opts.quotaBytes) {
      throw new StorageError('QUOTA_EXCEEDED', 'Project storage quota exceeded', 403);
    }
    const key = storageKeyFor(projectId, bucket.name, path);
    const { size, etag } = await this.provider.putStream(key, input.source, { maxBytes });
    if (usage.bytes + size > this.opts.quotaBytes) {
      await this.provider.delete(key).catch(() => undefined);
      throw new StorageError('QUOTA_EXCEEDED', 'Project storage quota exceeded', 403);
    }
    const record = await this.meta.putObject({
      organizationId,
      projectId,
      bucketId: bucket.id,
      bucket: bucket.name,
      path,
      filename,
      mimeType: mime,
      size,
      etag,
      storageKey: key,
      metadata: {},
    });
    if (existing) {
      await this.meta.adjustUsage(projectId, 0, size - existing.size);
    } else {
      await this.meta.recordUpload(projectId, size);
    }
    this.audit(existing ? 'file.updated' : 'file.uploaded', {
      projectId,
      bucket: bucket.name,
      path,
      size,
    });
    return exposeObject(record);
  }

  /**
   * Token-bound download: the HMAC already authenticated this exact
   * (project, bucket, path). No caller policy applies — but the binding is
   * re-checked here so a token can never escape its scope.
   */
  async downloadSigned(
    projectId: string,
    organizationId: string,
    bucketName: string,
    rawPath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; object: ExposedObject; etag: string }> {
    const bucket = await this.bucketFor(projectId, organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    const record = await this.meta.getObject(projectId, bucket.name, path);
    if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    const stream = await this.provider.getStream(record.storageKey).catch(() => {
      throw new StorageError('NOT_FOUND', 'Object not found', 404);
    });
    await this.meta.recordDownload(projectId);
    return { stream, object: exposeObject(record), etag: record.etag };
  }

  async download(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; object: ExposedObject; etag: string }> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    this.check(bucket, caller, 'object:download', path);
    const record = await this.meta.getObject(caller.projectId, bucket.name, path);
    if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    const stream = await this.provider.getStream(record.storageKey).catch(() => {
      throw new StorageError('NOT_FOUND', 'Object not found', 404);
    });
    await this.meta.recordDownload(caller.projectId);
    return { stream, object: exposeObject(record), etag: record.etag };
  }

  async metadata(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
  ): Promise<ExposedObject> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    this.check(bucket, caller, 'object:download', path);
    const record = await this.meta.getObject(caller.projectId, bucket.name, path);
    if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    return exposeObject(record);
  }

  /**
   * Per-bucket analytics from live metadata (bytes/files per bucket).
   * Counts derive from stored records, so numbers match billing gauges.
   */
  async analytics(caller: StorageCaller): Promise<{
    buckets: { name: string; visibility: string; files: number; bytes: number }[];
    totals: { files: number; bytes: number; quotaBytes: number };
  }> {
    const buckets = await this.meta.listBuckets(caller.projectId);
    const rows = await Promise.all(
      buckets.map(async b => {
        const listed = await this.meta.listObjects(caller.projectId, b.name, '', 5000, 0);
        const bytes = listed.objects.reduce((n, o) => n + o.size, 0);
        return {
          name: b.name,
          visibility: b.visibility,
          files: listed.total,
          bytes,
          truncated: listed.total > listed.objects.length,
        };
      }),
    );
    const totals = rows.reduce(
      (acc, r) => ({ files: acc.files + r.files, bytes: acc.bytes + r.bytes }),
      { files: 0, bytes: 0 },
    );
    return {
      buckets: rows.map(({ truncated: _t, ...rest }) => {
        void _t;
        return rest;
      }),
      totals: { ...totals, quotaBytes: this.opts.quotaBytes },
    };
  }

  // ── Resumable (multipart) uploads ────────────────────────────
  //
  // Large files upload as numbered parts (any order, idempotent retry per
  // index) and assemble server-side on complete. Parts live under a
  // namespaced temp prefix; only complete() can promote bytes to a real
  // object, and it re-runs every upload validation (MIME, quota, upsert).

  private uploadPartKey(projectId: string, bucket: string, uploadId: string, index: number): string {
    // Internal part keys bypass user-path validation on purpose (uuid-scoped
    // temp namespace, always cleaned on complete/abort). Segments stay
    // filesystem/S3-safe: alphanumerics, dashes, dots only.
    const safeBucket = bucket.replace(/[^A-Za-z0-9-]/g, '-');
    const safeId = uploadId.replace(/[^A-Za-z0-9-]/g, '');
    return `p_${projectId}/b_${safeBucket}/upload-${safeId}/${index}.part`;
  }

  async createUploadSession(
    caller: StorageCaller,
    input: { bucket: string; path: string; contentType?: string | null; totalBytes?: number | null; upsert?: boolean },
  ): Promise<UploadSession> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, input.bucket);
    const path = assertObjectPath(input.path);
    this.check(bucket, caller, 'object:upload', path);
    if (input.totalBytes !== undefined && input.totalBytes !== null) {
      if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0) {
        throw new StorageError('VALIDATION_ERROR', 'totalBytes must be a positive integer', 400);
      }
      const maxBytes = Math.min(
        bucket.fileSizeLimit ?? this.opts.defaultMaxFileBytes,
        this.opts.defaultMaxFileBytes,
      );
      if (input.totalBytes > maxBytes) {
        throw new StorageError('FILE_TOO_LARGE', `File exceeds ${maxBytes} bytes`, 413);
      }
    }
    const existing = await this.meta.getObject(caller.projectId, bucket.name, path);
    if (existing && !input.upsert) {
      throw new StorageError('CONFLICT', 'Object exists (use upsert to overwrite)', 409);
    }
    return this.meta.createUploadSession({
      organizationId: caller.organizationId,
      projectId: caller.projectId,
      bucket: bucket.name,
      path,
      contentType: input.contentType ?? null,
      totalBytes: input.totalBytes ?? null,
      upsert: input.upsert ?? false,
    });
  }

  async getUploadSession(caller: StorageCaller, uploadId: string): Promise<UploadSession> {
    const session = await this.meta.getUploadSession(caller.projectId, uploadId);
    if (!session || session.organizationId !== caller.organizationId) {
      throw new StorageError('NOT_FOUND', 'Upload session not found', 404);
    }
    if (session.status !== 'active' || Date.parse(session.expiresAt) <= Date.now()) {
      throw new StorageError('UPLOAD_EXPIRED', 'Upload session expired — start a new one', 410);
    }
    return session;
  }

  async uploadPart(
    caller: StorageCaller,
    uploadId: string,
    index: number,
    source: AsyncIterable<Uint8Array>,
  ): Promise<{ index: number; receivedBytes: number; parts: number[] }> {
    if (!Number.isInteger(index) || index < 0 || index > 999) {
      throw new StorageError('VALIDATION_ERROR', 'Part index must be 0-999', 400);
    }
    const session = await this.getUploadSession(caller, uploadId);
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, session.bucket);
    this.check(bucket, caller, 'object:upload', session.path);
    const partKey = this.uploadPartKey(caller.projectId, bucket.name, uploadId, index);
    const maxBytes = Math.min(
      bucket.fileSizeLimit ?? this.opts.defaultMaxFileBytes,
      this.opts.defaultMaxFileBytes,
    );
    const { size } = await this.provider.putStream(partKey, source, { maxBytes });
    const updated = await this.meta.recordUploadPart(caller.projectId, uploadId, index, size);
    if (!updated) throw new StorageError('UPLOAD_EXPIRED', 'Upload session expired', 410);
    this.audit('file.part.uploaded', { projectId: caller.projectId, bucket: bucket.name, path: session.path, size });
    return { index, receivedBytes: updated.receivedBytes, parts: updated.parts };
  }

  async completeUploadSession(caller: StorageCaller, uploadId: string): Promise<ExposedObject> {
    const session = await this.getUploadSession(caller, uploadId);
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, session.bucket);
    this.check(bucket, caller, 'object:upload', session.path);
    if (session.parts.length === 0) {
      throw new StorageError('VALIDATION_ERROR', 'No parts uploaded yet', 400);
    }
    const max = Math.max(...session.parts);
    for (let i = 0; i <= max; i += 1) {
      if (!session.parts.includes(i)) {
        throw new StorageError('VALIDATION_ERROR', `Missing part ${i} — upload it before completing`, 400);
      }
    }
    // Assemble in order, then run the standard upload path validations.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i <= max; i += 1) {
      const bytes = await this.provider
        .getBytes(this.uploadPartKey(caller.projectId, bucket.name, uploadId, i))
        .catch(() => {
          throw new StorageError('VALIDATION_ERROR', `Missing part ${i} — upload it before completing`, 400);
        });
      chunks.push(bytes);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const finish = async (value: ExposedObject): Promise<ExposedObject> => {
      for (let i = 0; i <= max; i += 1) {
        await this.provider.delete(this.uploadPartKey(caller.projectId, bucket.name, uploadId, i)).catch(() => undefined);
      }
      await this.meta.finishUploadSession(caller.projectId, uploadId, 'completed');
      return value;
    };
    try {
      const assembled = await this.upload({
        caller,
        bucket: bucket.name,
        path: session.path,
        contentType: session.contentType,
        source: (async function* () {
          for (const c of chunks) yield c;
        })(),
        sample: chunks[0]?.slice(0, 32) ?? new Uint8Array(0),
        upsert: session.upsert,
      });
      void total;
      return await finish(assembled);
    } catch (err) {
      for (let i = 0; i <= max; i += 1) {
        await this.provider.delete(this.uploadPartKey(caller.projectId, bucket.name, uploadId, i)).catch(() => undefined);
      }
      await this.meta.finishUploadSession(caller.projectId, uploadId, 'aborted');
      throw err;
    }
  }

  async abortUploadSession(caller: StorageCaller, uploadId: string): Promise<void> {
    const session = await this.meta.getUploadSession(caller.projectId, uploadId);
    if (!session || session.organizationId !== caller.organizationId) {
      throw new StorageError('NOT_FOUND', 'Upload session not found', 404);
    }
    for (const index of session.parts) {
      await this.provider.delete(this.uploadPartKey(caller.projectId, session.bucket, uploadId, index)).catch(() => undefined);
    }
    await this.meta.finishUploadSession(caller.projectId, uploadId, 'aborted');
    this.audit('file.upload.aborted', { projectId: caller.projectId, bucket: session.bucket, path: session.path });
  }

  async list(
    caller: StorageCaller,
    bucketName: string,
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ objects: ExposedObject[]; total: number }> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    if (prefix) assertObjectPath(prefix.replace(/\/$/, ''));
    this.check(bucket, caller, 'object:list', prefix || null);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new StorageError('INVALID_PAGINATION', 'limit must be 1-200', 400);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new StorageError('INVALID_PAGINATION', 'Bad offset', 400);
    }
    // Owner scoping: customers see only their folder (prefix forced).
    let effective = prefix;
    if (
      caller.kind === 'customer' &&
      caller.role !== 'admin' &&
      bucket.ownerIsolation &&
      caller.userId
    ) {
      const own = `${caller.userId}/`;
      if (effective && !effective.startsWith(own) && effective !== caller.userId) {
        return { objects: [], total: 0 };
      }
      if (!effective) effective = own;
    }
    const { objects, total } = await this.meta.listObjects(
      caller.projectId,
      bucket.name,
      effective,
      limit,
      offset,
    );
    return { objects: objects.map(exposeObject), total };
  }

  async remove(caller: StorageCaller, bucketName: string, rawPath: string): Promise<void> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    this.check(bucket, caller, 'object:delete', path);
    const record = await this.meta.getObject(caller.projectId, bucket.name, path);
    if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    await this.provider.delete(record.storageKey);
    await this.meta.deleteObject(caller.projectId, bucket.name, path);
    await this.meta.adjustUsage(caller.projectId, -1, -record.size);
    this.audit('file.deleted', { projectId: caller.projectId, bucket: bucket.name, path });
  }

  async move(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
    rawDest: string,
  ): Promise<ExposedObject> {
    return this.copyOrMove(caller, bucketName, rawPath, rawDest, true);
  }

  async copy(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
    rawDest: string,
  ): Promise<ExposedObject> {
    return this.copyOrMove(caller, bucketName, rawPath, rawDest, false);
  }

  private async copyOrMove(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
    rawDest: string,
    isMove: boolean,
  ): Promise<ExposedObject> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    const dest = assertObjectPath(rawDest);
    this.check(bucket, caller, isMove ? 'object:move' : 'object:copy', path);
    this.check(bucket, caller, 'object:upload', dest);
    const record = await this.meta.getObject(caller.projectId, bucket.name, path);
    if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    if (await this.meta.getObject(caller.projectId, bucket.name, dest)) {
      throw new StorageError('CONFLICT', 'Destination exists', 409);
    }
    if (!isMove) {
      const usage = await this.meta.usage(caller.projectId);
      if (usage.bytes + record.size > this.quotaBytes()) {
        throw new StorageError('QUOTA_EXCEEDED', 'Project storage quota exceeded', 403);
      }
    }
    const destKey = storageKeyFor(caller.projectId, bucket.name, dest);
    await this.provider.copy(record.storageKey, destKey);
    const copied = await this.meta.putObject({
      organizationId: caller.organizationId,
      projectId: caller.projectId,
      bucketId: bucket.id,
      bucket: bucket.name,
      path: dest,
      filename: fileNameOf(dest),
      mimeType: record.mimeType,
      size: record.size,
      etag: record.etag,
      storageKey: destKey,
      metadata: {},
    });
    if (isMove) {
      await this.provider.delete(record.storageKey);
      await this.meta.deleteObject(caller.projectId, bucket.name, path);
      this.audit('file.moved', { projectId: caller.projectId, bucket: bucket.name, path, dest });
    } else {
      await this.meta.recordUpload(caller.projectId, record.size);
      this.audit('file.copied', { projectId: caller.projectId, bucket: bucket.name, path, dest });
    }
    return exposeObject(copied);
  }

  /** Mint a capability token (download or upload). Upload tokens pre-authorize one path. */ async sign(
    caller: StorageCaller,
    bucketName: string,
    rawPath: string,
    op: 'download' | 'upload',
    expiresInSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const bucket = await this.bucketFor(caller.projectId, caller.organizationId, bucketName);
    const path = assertObjectPath(rawPath);
    this.check(bucket, caller, 'object:sign', path);
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > this.opts.maxSignedTtlSeconds
    ) {
      throw new StorageError(
        'INVALID_TTL',
        `expiresIn must be 60-${this.opts.maxSignedTtlSeconds}s`,
        400,
      );
    }
    if (op === 'download') {
      const record = await this.meta.getObject(caller.projectId, bucket.name, path);
      if (!record) throw new StorageError('NOT_FOUND', 'Object not found', 404);
    }
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = signToken(
      this.opts.signingSecret,
      { projectId: caller.projectId, bucket: bucket.name, path, op, exp },
      this.opts.maxSignedTtlSeconds,
    );
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Verify a capability token against the caller's project scope. */
  verifySigned(
    projectId: string,
    token: string,
    op: 'download' | 'upload',
  ): { bucket: string; path: string } {
    const claims = verifyToken(this.opts.signingSecret, token);
    if (claims.projectId !== projectId || claims.op !== op) {
      throw new StorageError('INVALID_SIGNATURE', 'Token not valid here', 401);
    }
    return { bucket: claims.bucket, path: claims.path };
  }

  async usage(caller: StorageCaller): Promise<{
    files: number;
    bytes: number;
    uploads: number;
    downloads: number;
    quotaBytes: number;
  }> {
    const u = await this.meta.usage(caller.projectId);
    return { ...u, quotaBytes: this.opts.quotaBytes };
  }

  /** System-initiated cascade for project deletion (no caller policy involved). */
  async deleteProjectData(projectId: string): Promise<{ buckets: number; objects: number }> {
    let buckets = 0;
    let objects = 0;
    for (const bucket of await this.meta.listBuckets(projectId)) {
      for (;;) {
        const { objects: batch } = await this.meta.listObjects(projectId, bucket.name, '', 200, 0);
        if (batch.length === 0) break;
        for (const o of batch) {
          await this.provider.delete(o.storageKey).catch(() => undefined);
          await this.meta.deleteObject(projectId, bucket.name, o.path);
          objects += 1;
        }
      }
      await this.meta.deleteBucket(projectId, bucket.name);
      buckets += 1;
    }
    const usage = await this.meta.usage(projectId);
    await this.meta.adjustUsage(projectId, -usage.files, -usage.bytes);
    return { buckets, objects };
  }
}
