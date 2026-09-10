import type { FunctionAuthContext } from './types.js';

/**
 * In-function CloudNivo SDK (`cloudnivo.*`).
 *
 * The control plane builds this per invocation with identity already
 * resolved — functions never see signing secrets, connection strings, or
 * other projects' data. Service namespaces execute through a capability
 * channel back to the control plane (`SdkHooks`, injected per invocation and
 * bound to exactly one project): the isolate can only ask, the server
 * decides, with allow-list guards on both ends.
 */

export interface SdkDatabase {
  /** Guarded project-scoped SELECT (single statement, capped rows). */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  readonly projectId: string;
}

export interface SdkStorage {
  /** Read one object (bytes capped); writes stay on the REST API in v1. */
  read(
    bucket: string,
    path: string,
  ): Promise<{
    bucket: string;
    path: string;
    mimeType: string;
    size: number;
    body: string;
    encoding: 'utf8' | 'base64';
  } | null>;
  write(): Promise<never>;
  readonly projectId: string;
}

export interface SdkRealtime {
  /** Publish to a channel of the function's own project (prefix-enforced). */
  publish(channel: string, event: string, data?: unknown): Promise<void>;
  readonly projectId: string;
}

export interface CloudnivoSdk {
  readonly auth: {
    readonly userId: string | null;
    readonly email: string | null;
    readonly role: string;
  };
  readonly project: { readonly id: string };
  readonly env: Record<string, string>;
  readonly database: SdkDatabase;
  readonly storage: SdkStorage;
  readonly realtime: SdkRealtime;
}

function notAvailable(service: string): () => Promise<never> {
  return async () => {
    throw new Error(`cloudnivo.${service} is not enabled for this invocation`);
  };
}

/**
 * Capability hooks: the control plane injects project-bound implementations
 * per invocation. Each hook MUST re-check project scope — the isolate is
 * untrusted and the SDK guards below are defense in depth, not the boundary.
 */
export interface SdkHooks {
  databaseQuery?(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  storageRead?(
    bucket: string,
    path: string,
  ): Promise<{
    bucket: string;
    path: string;
    mimeType: string;
    size: number;
    body: string;
    encoding: 'utf8' | 'base64';
  } | null>;
  realtimePublish?(channel: string, event: string, data: unknown): Promise<void>;
}

/** SDK-side guards (mirrored server-side; never the sole enforcement). */
export function assertSdkQuery(sql: unknown, params: unknown): { sql: string; params: unknown[] } {
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > 8000) {
    throw new Error('query must be a string up to 8000 characters');
  }
  if (!/^\s*select\b/i.test(sql) || sql.includes(';')) {
    throw new Error('only single SELECT statements are allowed');
  }
  const list = params === undefined ? [] : params;
  if (!Array.isArray(list) || list.length > 20)
    throw new Error('params must be an array of at most 20 values');
  for (const p of list) {
    if (p !== null && typeof p !== 'string' && typeof p !== 'number' && typeof p !== 'boolean') {
      throw new Error('params must be primitives');
    }
    if (typeof p === 'string' && p.length > 4096) throw new Error('param too large');
  }
  return { sql, params: list };
}

export function assertSdkRead(bucket: unknown, path: unknown): { bucket: string; path: string } {
  if (typeof bucket !== 'string' || bucket.length === 0 || bucket.length > 63) {
    throw new Error('bucket must be a string up to 63 characters');
  }
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw new Error('path must be a string up to 1024 characters');
  }
  return { bucket, path };
}

export function assertSdkPublish(
  projectId: string,
  channel: unknown,
  event: unknown,
  data: unknown,
): { channel: string; event: string; data: unknown } {
  if (typeof channel !== 'string' || !channel.startsWith(`project:${projectId}:`)) {
    throw new Error('channel must belong to the function project');
  }
  if (typeof event !== 'string' || event.length === 0 || event.length > 80) {
    throw new Error('event must be 1-80 characters');
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(data ?? null) ?? 'null', 'utf8');
  } catch {
    throw new Error('data is not serializable');
  }
  if (size > 32_768) throw new Error('publish data exceeds 32 KB');
  return { channel, event, data: data ?? null };
}

export function buildFunctionSdk(opts: {
  auth: FunctionAuthContext;
  /**
   * Full function env (public + secrets). Lives in isolate memory only —
   * the service layer masks secrets in every API response and log line, so
   * values never leave the server through management surfaces.
   */
  publicEnv: Record<string, string>;
  hooks?: SdkHooks;
}): CloudnivoSdk {
  const hooks = opts.hooks ?? {};
  const need = (service: string): (() => Promise<never>) => notAvailable(service);
  return {
    auth: Object.freeze({ userId: opts.auth.userId, email: opts.auth.email, role: opts.auth.role }),
    project: Object.freeze({ id: opts.auth.projectId }),
    env: Object.freeze({ ...opts.publicEnv }),
    database: Object.freeze({
      projectId: opts.auth.projectId,
      query: hooks.databaseQuery
        ? async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
            const checked = assertSdkQuery(sql, params);
            const rows = await hooks.databaseQuery?.(checked.sql, checked.params);
            return Array.isArray(rows) ? rows.slice(0, 500) : [];
          }
        : need('database.query'),
    }),
    storage: Object.freeze({
      projectId: opts.auth.projectId,
      read: hooks.storageRead
        ? async (bucket: string, path: string) => {
            const checked = assertSdkRead(bucket, path);
            const out = await hooks.storageRead?.(checked.bucket, checked.path);
            if (!out) return null;
            return out;
          }
        : need('storage.read'),
      write: need('storage.write'),
    }),
    realtime: Object.freeze({
      projectId: opts.auth.projectId,
      publish: hooks.realtimePublish
        ? async (channel: string, event: string, data?: unknown): Promise<void> => {
            const checked = assertSdkPublish(opts.auth.projectId, channel, event, data);
            await hooks.realtimePublish?.(checked.channel, checked.event, checked.data);
          }
        : need('realtime.publish'),
    }),
  };
}

/** Names the sandbox may never define — enforced at build time. */
export const SANDBOX_DENY = [
  'require',
  'process',
  'globalThis',
  'global',
  '__dirname',
  '__filename',
  'module',
  'exports',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
] as const;
