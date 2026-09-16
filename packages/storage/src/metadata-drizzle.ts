import { and, count, eq, lt, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@cloudnivo/api-core';
import {
  projects,
  storageBuckets,
  storageObjects,
  storageUploadSessions,
  storageUsage,
  type Database,
} from '@cloudnivo/database';
import type { Bucket, StoredObject } from './types.js';
import type { CreateBucketInput, PutObjectInput, StorageMetadataStore, UploadSession } from './metadata.js';

/**
 * Drizzle-backed storage metadata (`storage_buckets`, `storage_objects`,
 * `storage_usage`). Same record shapes and upsert semantics as memory.
 * Selected with `CONTROL_STORE=drizzle` (migrations applied at deploy).
 */

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToBucket(row: typeof storageBuckets.$inferSelect): Bucket {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    name: row.name,
    visibility: row.visibility === 'public' ? 'public' : 'private',
    fileSizeLimit: row.fileSizeLimit,
    allowedMimeTypes: [...row.allowedMimeTypes],
    ownerIsolation: row.ownerIsolation !== 'false',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function rowToObject(row: typeof storageObjects.$inferSelect): StoredObject {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    bucketId: row.bucketId,
    bucket: row.bucket,
    path: row.path,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    etag: row.etag,
    storageKey: row.storageKey,
    metadata: { ...(row.metadata ?? {}) } as Record<string, unknown>,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function duplicate(err: unknown): boolean {
  return isUniqueViolation(err);
}

export class DrizzleStorageMetadataStore implements StorageMetadataStore {
  constructor(private readonly db: Database) {}

  private async bucketRow(projectId: string, name: string) {
    const rows = await this.db
      .select()
      .from(storageBuckets)
      .where(and(eq(storageBuckets.projectId, projectId), eq(storageBuckets.name, name)))
      .limit(1);
    return rows[0] ?? null;
  }

  async createBucket(input: CreateBucketInput): Promise<Bucket> {
    try {
      const rows = await this.db
        .insert(storageBuckets)
        .values({
          projectId: input.projectId,
          organizationId: input.organizationId,
          name: input.name,
          visibility: input.visibility,
          fileSizeLimit: input.fileSizeLimit,
          allowedMimeTypes: input.allowedMimeTypes,
          ownerIsolation: input.ownerIsolation ? 'true' : 'false',
        })
        .returning();
      const saved = rows[0];
      if (!saved) throw new Error('Bucket insert failed');
      return rowToBucket(saved);
    } catch (err) {
      if (duplicate(err)) {
        const thrown = new Error('Bucket already exists') as Error & { code: string };
        thrown.code = 'BUCKET_EXISTS';
        throw thrown;
      }
      throw err;
    }
  }

  async getBucket(projectId: string, name: string): Promise<Bucket | null> {
    const row = await this.bucketRow(projectId, name);
    return row ? rowToBucket(row) : null;
  }

  async listBuckets(projectId: string): Promise<Bucket[]> {
    const rows = await this.db
      .select()
      .from(storageBuckets)
      .where(eq(storageBuckets.projectId, projectId));
    return rows.map(rowToBucket);
  }

  async updateBucket(
    projectId: string,
    name: string,
    patch: Partial<
      Pick<Bucket, 'visibility' | 'fileSizeLimit' | 'allowedMimeTypes' | 'ownerIsolation'>
    >,
  ): Promise<Bucket | null> {
    const set: Partial<typeof storageBuckets.$inferInsert> = { updatedAt: new Date() };
    if (patch.visibility !== undefined) set.visibility = patch.visibility;
    if (patch.fileSizeLimit !== undefined) set.fileSizeLimit = patch.fileSizeLimit;
    if (patch.allowedMimeTypes !== undefined) set.allowedMimeTypes = patch.allowedMimeTypes;
    if (patch.ownerIsolation !== undefined)
      set.ownerIsolation = patch.ownerIsolation ? 'true' : 'false';
    const rows = await this.db
      .update(storageBuckets)
      .set(set)
      .where(and(eq(storageBuckets.projectId, projectId), eq(storageBuckets.name, name)))
      .returning();
    const row = rows[0];
    return row ? rowToBucket(row) : null;
  }

  async deleteBucket(projectId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(storageBuckets)
      .where(and(eq(storageBuckets.projectId, projectId), eq(storageBuckets.name, name)))
      .returning({ id: storageBuckets.id });
    return rows.length > 0;
  }

  async countBuckets(projectId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(storageBuckets)
      .where(eq(storageBuckets.projectId, projectId));
    return rows[0]?.n ?? 0;
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const existing = await this.db
      .select({ id: storageObjects.id, createdAt: storageObjects.createdAt })
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.projectId, input.projectId),
          eq(storageObjects.bucket, input.bucket),
          eq(storageObjects.path, input.path),
        ),
      )
      .limit(1);
    const prev = existing[0];
    if (prev) {
      const rows = await this.db
        .update(storageObjects)
        .set({
          filename: input.filename,
          mimeType: input.mimeType,
          size: input.size,
          etag: input.etag,
          storageKey: input.storageKey,
          metadata: input.metadata,
          updatedAt: new Date(),
        })
        .where(eq(storageObjects.id, prev.id))
        .returning();
      const saved = rows[0];
      if (!saved) throw new Error('Object update failed');
      return rowToObject(saved);
    }
    const rows = await this.db
      .insert(storageObjects)
      .values({
        projectId: input.projectId,
        organizationId: input.organizationId,
        bucketId: input.bucketId,
        bucket: input.bucket,
        path: input.path,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        etag: input.etag,
        storageKey: input.storageKey,
        metadata: input.metadata,
      })
      .returning();
    const saved = rows[0];
    if (!saved) throw new Error('Object insert failed');
    return rowToObject(saved);
  }

  async getObject(projectId: string, bucket: string, path: string): Promise<StoredObject | null> {
    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.projectId, projectId),
          eq(storageObjects.bucket, bucket),
          eq(storageObjects.path, path),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToObject(row) : null;
  }

  async listObjects(
    projectId: string,
    bucket: string,
    prefix: string,
    limit: number,
    offset: number,
  ): Promise<{ objects: StoredObject[]; total: number }> {
    const where = prefix
      ? and(
          eq(storageObjects.projectId, projectId),
          eq(storageObjects.bucket, bucket),
          sql`${storageObjects.path} LIKE ${prefix + '%'}`,
        )
      : and(eq(storageObjects.projectId, projectId), eq(storageObjects.bucket, bucket));
    const totalRows = await this.db.select({ n: count() }).from(storageObjects).where(where);
    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(where)
      .orderBy(storageObjects.path)
      .limit(limit)
      .offset(offset);
    return { objects: rows.map(rowToObject), total: totalRows[0]?.n ?? 0 };
  }

  async deleteObject(projectId: string, bucket: string, path: string): Promise<boolean> {
    const rows = await this.db
      .delete(storageObjects)
      .where(
        and(
          eq(storageObjects.projectId, projectId),
          eq(storageObjects.bucket, bucket),
          eq(storageObjects.path, path),
        ),
      )
      .returning({ id: storageObjects.id });
    return rows.length > 0;
  }

  async countObjectsInBucket(projectId: string, bucket: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(storageObjects)
      .where(and(eq(storageObjects.projectId, projectId), eq(storageObjects.bucket, bucket)));
    return rows[0]?.n ?? 0;
  }

  async usage(
    projectId: string,
  ): Promise<{ files: number; bytes: number; uploads: number; downloads: number }> {
    const filesRows = await this.db
      .select({ n: count(), b: sql<number | null>`COALESCE(SUM(${storageObjects.size}), 0)` })
      .from(storageObjects)
      .where(eq(storageObjects.projectId, projectId));
    const counters = await this.db
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.projectId, projectId))
      .limit(1);
    return {
      files: filesRows[0]?.n ?? 0,
      bytes: Number(filesRows[0]?.b ?? 0),
      uploads: counters[0]?.uploads ?? 0,
      downloads: counters[0]?.downloads ?? 0,
    };
  }

  private async bump(
    projectId: string,
    patch: { uploads?: number; downloads?: number },
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.projectId, projectId))
      .limit(1);
    if (!existing[0]) {
      const proj = await this.db
        .select({ organizationId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const organizationId = proj[0]?.organizationId;
      if (!organizationId) return;
      await this.db.insert(storageUsage).values({
        projectId,
        organizationId,
        uploads: patch.uploads ?? 0,
        downloads: patch.downloads ?? 0,
      });
      return;
    }
    await this.db
      .update(storageUsage)
      .set({
        uploads: sql`${storageUsage.uploads} + ${patch.uploads ?? 0}`,
        downloads: sql`${storageUsage.downloads} + ${patch.downloads ?? 0}`,
        updatedAt: new Date(),
      })
      .where(eq(storageUsage.projectId, projectId));
  }

  async recordUpload(projectId: string, _bytes: number): Promise<void> {
    void _bytes;
    await this.bump(projectId, { uploads: 1 });
  }

  async recordDownload(projectId: string): Promise<void> {
    await this.bump(projectId, { downloads: 1 });
  }

  async adjustUsage(_projectId: string, _filesDelta: number, _bytesDelta: number): Promise<void> {
    // files/bytes derive live from storage_objects; event counters only.
    void _projectId;
    void _filesDelta;
    void _bytesDelta;
  }

  async createUploadSession(input: {
    organizationId: string;
    projectId: string;
    bucket: string;
    path: string;
    contentType: string | null;
    totalBytes: number | null;
    upsert: boolean;
  }): Promise<UploadSession> {
    const rows = await this.db
      .insert(storageUploadSessions)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        bucket: input.bucket,
        path: input.path,
        contentType: input.contentType,
        totalBytes: input.totalBytes,
        upsert: input.upsert,
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Upload session insert failed');
    return rowToUploadSession(row);
  }

  async getUploadSession(projectId: string, id: string): Promise<UploadSession | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db
      .select()
      .from(storageUploadSessions)
      .where(eq(storageUploadSessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.projectId !== projectId) return null;
    return rowToUploadSession(row);
  }

  async recordUploadPart(projectId: string, id: string, index: number, bytes: number): Promise<UploadSession | null> {
    const current = await this.getUploadSession(projectId, id);
    if (!current || current.status !== 'active' || Date.parse(current.expiresAt) <= Date.now()) {
      return null;
    }
    const parts = current.parts.includes(index) ? current.parts : [...current.parts, index].sort((a, b) => a - b);
    const rows = await this.db
      .update(storageUploadSessions)
      .set({ parts, receivedBytes: current.receivedBytes + bytes })
      .where(eq(storageUploadSessions.id, id))
      .returning();
    const row = rows[0];
    return row ? rowToUploadSession(row) : null;
  }

  async finishUploadSession(projectId: string, id: string, status: 'completed' | 'aborted'): Promise<boolean> {
    const current = await this.getUploadSession(projectId, id);
    if (!current) return false;
    await this.db
      .update(storageUploadSessions)
      .set({ status })
      .where(eq(storageUploadSessions.id, id));
    return true;
  }

  async pruneUploadSessions(beforeIso: string): Promise<number> {
    const cutoff = new Date(beforeIso);
    if (Number.isNaN(cutoff.getTime())) return 0;
    const rows = await this.db
      .delete(storageUploadSessions)
      .where(lt(storageUploadSessions.expiresAt, cutoff))
      .returning({ id: storageUploadSessions.id });
    return rows.length;
  }
}

function rowToUploadSession(row: typeof storageUploadSessions.$inferSelect): UploadSession {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    bucket: row.bucket,
    path: row.path,
    contentType: row.contentType,
    totalBytes: row.totalBytes,
    receivedBytes: row.receivedBytes ?? 0,
    parts: Array.isArray(row.parts) ? (row.parts as number[]).map(Number) : [],
    upsert: row.upsert ?? false,
    status: row.status === 'completed' || row.status === 'aborted' ? row.status : 'active',
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}
