import { StorageError } from './types.js';

/**
 * Path + name validation — the traversal firewall. Object keys are LOGICAL
 * (`avatars/user-123/a.png`); they are never joined to the filesystem without
 * passing through here, and providers re-validate defensively.
 */

const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~()-]{0,127}$/;

export function assertBucketName(name: string): string {
  if (typeof name !== 'string' || !BUCKET_RE.test(name)) {
    throw new StorageError(
      'INVALID_BUCKET',
      'Bucket must be 3-63 chars, lowercase alphanumeric with interior hyphens',
      400,
    );
  }
  return name;
}

/** Validate + normalize a logical object path. Returns canonical `a/b/c.ext`. */
export function assertObjectPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) {
    throw new StorageError('INVALID_PATH', 'Object path must be 1-1024 characters', 400);
  }
  if (raw.includes('\0')) throw new StorageError('INVALID_PATH', 'Null bytes not allowed', 400);
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new StorageError('INVALID_PATH', 'Absolute paths not allowed', 400);
  }
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) {
    throw new StorageError('INVALID_PATH', 'Drive/UNC paths not allowed', 400);
  }
  const parts = raw.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new StorageError('INVALID_PATH', 'Parent traversal blocked', 400);
    if (!SEGMENT_RE.test(part) || part.length > 128) {
      throw new StorageError('INVALID_PATH', `Bad path segment: ${part.slice(0, 40)}`, 400);
    }
    out.push(part);
  }
  if (out.length === 0 || out.length > 32) {
    throw new StorageError('INVALID_PATH', 'Path must have 1-32 segments', 400);
  }
  const joined = out.join('/');
  if (joined.length > 1024) throw new StorageError('INVALID_PATH', 'Normalized path too long', 400);
  return joined;
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function assertFileName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    throw new StorageError('INVALID_FILENAME', 'Filename must be 1-255 characters', 400);
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new StorageError('INVALID_FILENAME', 'Filename must not contain separators', 400);
  }
  if (name === '.' || name === '..')
    throw new StorageError('INVALID_FILENAME', 'Bad filename', 400);
  return name;
}

/** Storage-internal key namespacing: `p_<project>/b_<bucket>/<path>`. */
export function storageKeyFor(projectId: string, bucket: string, path: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new StorageError('INVALID_PATH', 'Bad scope', 400);
  return `p_${projectId}/b_${bucket}/${assertObjectPath(path)}`;
}
