import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

/**
 * Object-storage abstraction. Phase 1 ships a local-filesystem driver
 * (zero cost, Docker-free). The `StorageService` interface is S3-compatible
 * by design — migrating to R2/S3/GCS later only changes the factory.
 *
 * Phase 5 adds the full bucket/object system alongside (new modules below).
 * The legacy key-value surface is preserved for compatibility.
 */
export * from './types.js';
export * from './validation.js';
export * from './mime.js';
export * from './signed-urls.js';
export * from './providers.js';
export * from './policies.js';
export * from './metadata.js';
export * from './service.js';
export * from './openapi.js';

export interface PutOptions {
  contentType?: string;
}

export interface StorageObject {
  key: string;
  size: number;
  contentType?: string;
}

export interface StorageService {
  readonly driver: string;
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<StorageObject>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

function assertSafeKey(key: string): void {
  const normalized = normalize(key).replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '..'
  ) {
    throw new Error('Invalid storage key (path traversal blocked)');
  }
}

export class LocalStorageService implements StorageService {
  readonly driver = 'local';
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return join(this.baseDir, ...key.split('/'));
  }

  async put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<StorageObject> {
    const path = this.resolve(key);
    await mkdir(path.slice(0, path.lastIndexOf(sep)), { recursive: true });
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    await writeFile(path, bytes);
    return { key, size: bytes.byteLength, contentType: opts?.contentType };
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(key)));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

export function createStorageService(opts: {
  driver: 'local' | 's3';
  localDir?: string;
}): StorageService {
  if (opts.driver === 'local') {
    return new LocalStorageService(opts.localDir ?? './.data/storage');
  }
  // S3-compatible driver lands in Phase 2; the interface already supports it.
  throw new Error('S3 storage driver not yet configured (Phase 2). Set STORAGE_DRIVER=local.');
}
