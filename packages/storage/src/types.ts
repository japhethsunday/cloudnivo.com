/**
 * Storage domain types. Buckets and objects are always scoped to
 * (organizationId, projectId) server-side — clients never supply ownership.
 */

export type BucketVisibility = 'public' | 'private';

export interface Bucket {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  visibility: BucketVisibility;
  /** Max bytes per file; null = provider default. */
  fileSizeLimit: number | null;
  /** Allowed MIME prefixes, e.g. ["image/"]; empty = all. */
  allowedMimeTypes: string[];
  /** Owner-prefix isolation for customer callers (default true). */
  ownerIsolation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredObject {
  id: string;
  organizationId: string;
  projectId: string;
  bucketId: string;
  bucket: string;
  /** Logical key, e.g. "avatars/user-123/profile.png". Never a filesystem path. */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  etag: string;
  storageKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Public shape — storageKey and any credential material never included. */
export interface ExposedObject {
  id: string;
  bucket: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  etag: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function exposeObject(o: StoredObject): ExposedObject {
  const { storageKey: _drop, organizationId: _o, projectId: _p, bucketId: _b, ...rest } = o;
  void _drop;
  void _o;
  void _p;
  void _b;
  return rest;
}

export type StorageCallerKind = 'session' | 'key' | 'customer' | 'anonymous';

export interface StorageCaller {
  kind: StorageCallerKind;
  /** Platform user id or customer user id; null for anonymous/service keys. */
  userId: string | null;
  /** Platform role, project-key role, or customer role. */
  role: string;
  projectId: string;
  organizationId: string;
  /** Present for agent-token callers (identity refs for audit trails). */
  agent?: { id: string; userId: string };
}

export type StorageOp =
  | 'bucket:create'
  | 'bucket:read'
  | 'bucket:delete'
  | 'bucket:update'
  | 'object:upload'
  | 'object:download'
  | 'object:delete'
  | 'object:move'
  | 'object:copy'
  | 'object:list'
  | 'object:sign';

export const STORAGE_EVENTS = [
  'bucket.created',
  'bucket.deleted',
  'bucket.updated',
  'file.uploaded',
  'file.deleted',
  'file.updated',
  'file.moved',
  'file.copied',
] as const;
export type StorageEvent = (typeof STORAGE_EVENTS)[number];

export class StorageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}

export interface UsageSummary {
  projectId: string;
  files: number;
  bytes: number;
  uploads: number;
  downloads: number;
  quotaBytes: number;
}
