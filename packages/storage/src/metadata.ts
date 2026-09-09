import { randomUUID } from 'node:crypto';
import type { Bucket, BucketVisibility, StoredObject } from './types.js';

/**
 * Storage metadata store. Memory adapter for dev/test with identical
 * semantics; Drizzle tables (`storage_buckets`, `storage_objects`) are the
 * documented durable target — same record shapes (see docs/database.md).
 */

export interface CreateBucketInput {
  organizationId: string;
  projectId: string;
  name: string;
  visibility: BucketVisibility;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[];
  ownerIsolation: boolean;
}

export interface PutObjectInput {
  organizationId: string;
  projectId: string;
  bucketId: string;
  bucket: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  etag: string;
  storageKey: string;
  metadata: Record<string, unknown>;
}

export interface StorageMetadataStore {
  createBucket(input: CreateBucketInput): Promise<Bucket>;
  getBucket(projectId: string, name: string): Promise<Bucket | null>;
  listBuckets(projectId: string): Promise<Bucket[]>;
  updateBucket(
    projectId: string,
    name: string,
    patch: Partial<
      Pick<Bucket, 'visibility' | 'fileSizeLimit' | 'allowedMimeTypes' | 'ownerIsolation'>
    >,
  ): Promise<Bucket | null>;
  deleteBucket(projectId: string, name: string): Promise<boolean>;
  countBuckets(projectId: string): Promise<number>;
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(projectId: string, bucket: string, path: string): Promise<StoredObject | null>;
  listObjects(
    projectId: string,
    bucket: string,
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ objects: StoredObject[]; total: number }>;
  deleteObject(projectId: string, bucket: string, path: string): Promise<boolean>;
  countObjectsInBucket(projectId: string, bucket: string): Promise<number>;
  usage(
    projectId: string,
  ): Promise<{ files: number; bytes: number; uploads: number; downloads: number }>;
  recordUpload(projectId: string, bytes: number): Promise<void>;
  recordDownload(projectId: string): Promise<void>;
  adjustUsage(projectId: string, filesDelta: number, bytesDelta: number): Promise<void>;
}

interface UsageCounters {
  files: number;
  bytes: number;
  uploads: number;
  downloads: number;
}

export class MemoryStorageMetadataStore implements StorageMetadataStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly objects = new Map<string, StoredObject>();
  private readonly usageCounters = new Map<string, UsageCounters>();

  private bucketKey(projectId: string, name: string): string {
    return `${projectId}/${name}`;
  }

  private objectKey(projectId: string, bucket: string, path: string): string {
    return `${projectId}/${bucket}/${path}`;
  }

  private counters(projectId: string): UsageCounters {
    let c = this.usageCounters.get(projectId);
    if (!c) {
      c = { files: 0, bytes: 0, uploads: 0, downloads: 0 };
      this.usageCounters.set(projectId, c);
    }
    return c;
  }

  async createBucket(input: CreateBucketInput): Promise<Bucket> {
    const key = this.bucketKey(input.projectId, input.name);
    if (this.buckets.has(key)) {
      const err = new Error('Bucket already exists') as Error & { code: string };
      err.code = 'BUCKET_EXISTS';
      throw err;
    }
    const now = new Date().toISOString();
    const bucket: Bucket = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.buckets.set(key, bucket);
    return { ...bucket };
  }

  async getBucket(projectId: string, name: string): Promise<Bucket | null> {
    const b = this.buckets.get(this.bucketKey(projectId, name));
    return b ? { ...b, allowedMimeTypes: [...b.allowedMimeTypes] } : null;
  }

  async listBuckets(projectId: string): Promise<Bucket[]> {
    return [...this.buckets.values()]
      .filter(b => b.projectId === projectId)
      .map(b => ({ ...b, allowedMimeTypes: [...b.allowedMimeTypes] }));
  }

  async updateBucket(
    projectId: string,
    name: string,
    patch: Partial<
      Pick<Bucket, 'visibility' | 'fileSizeLimit' | 'allowedMimeTypes' | 'ownerIsolation'>
    >,
  ): Promise<Bucket | null> {
    const key = this.bucketKey(projectId, name);
    const b = this.buckets.get(key);
    if (!b) return null;
    const next: Bucket = { ...b, ...patch, updatedAt: new Date().toISOString() };
    this.buckets.set(key, next);
    return { ...next, allowedMimeTypes: [...next.allowedMimeTypes] };
  }

  async deleteBucket(projectId: string, name: string): Promise<boolean> {
    return this.buckets.delete(this.bucketKey(projectId, name));
  }

  async countBuckets(projectId: string): Promise<number> {
    return [...this.buckets.values()].filter(b => b.projectId === projectId).length;
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const now = new Date().toISOString();
    const prev = this.objects.get(this.objectKey(input.projectId, input.bucket, input.path));
    const obj: StoredObject = {
      id: prev?.id ?? randomUUID(),
      ...input,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.objects.set(this.objectKey(input.projectId, input.bucket, input.path), obj);
    return { ...obj };
  }

  async getObject(projectId: string, bucket: string, path: string): Promise<StoredObject | null> {
    const o = this.objects.get(this.objectKey(projectId, bucket, path));
    return o ? { ...o } : null;
  }

  async listObjects(
    projectId: string,
    bucket: string,
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ objects: StoredObject[]; total: number }> {
    const all = [...this.objects.values()]
      .filter(o => o.projectId === projectId && o.bucket === bucket && o.path.startsWith(prefix))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return { objects: all.slice(offset, offset + limit).map(o => ({ ...o })), total: all.length };
  }

  async deleteObject(projectId: string, bucket: string, path: string): Promise<boolean> {
    return this.objects.delete(this.objectKey(projectId, bucket, path));
  }

  async countObjectsInBucket(projectId: string, bucket: string): Promise<number> {
    return [...this.objects.values()].filter(o => o.projectId === projectId && o.bucket === bucket)
      .length;
  }

  async usage(
    projectId: string,
  ): Promise<{ files: number; bytes: number; uploads: number; downloads: number }> {
    const c = this.counters(projectId);
    return { files: c.files, bytes: c.bytes, uploads: c.uploads, downloads: c.downloads };
  }

  async recordUpload(projectId: string, bytes: number): Promise<void> {
    const c = this.counters(projectId);
    c.files += 1;
    c.bytes += bytes;
    c.uploads += 1;
  }

  async recordDownload(projectId: string): Promise<void> {
    this.counters(projectId).downloads += 1;
  }

  async adjustUsage(projectId: string, filesDelta: number, bytesDelta: number): Promise<void> {
    const c = this.counters(projectId);
    c.files = Math.max(0, c.files + filesDelta);
    c.bytes = Math.max(0, c.bytes + bytesDelta);
  }
}
