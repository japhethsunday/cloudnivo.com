import { authorize } from './policies.js';
import { signToken, verifyToken } from './signed-urls.js';
import { resolveMime } from './mime.js';
import { assertBucketName, assertObjectPath, fileNameOf, storageKeyFor } from './validation.js';
import type { StorageMetadataStore } from './metadata.js';
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

  async usage(
    caller: StorageCaller,
  ): Promise<{
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
