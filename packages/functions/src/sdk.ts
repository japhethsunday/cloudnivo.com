import type { FunctionAuthContext } from './types.js';

/**
 * In-function CloudNivo SDK (`cloudnivo.*`).
 *
 * The control plane builds this per invocation with identity already
 * resolved — functions never see signing secrets, connection strings, or
 * other projects' data. Service namespaces are capability stubs in v1: they
 * expose what the caller may know (ids, auth context, public env) and throw
 * a clear error for operations that need a future service boundary. The
 * interface is modular so database/storage/realtime backends plug in later
 * without changing handler code.
 */

export interface SdkDatabase {
  /** v1: metadata only. Row access arrives with the Phase 8 service boundary. */
  readonly projectId: string;
  query(): Promise<never>;
}

export interface SdkStorage {
  readonly projectId: string;
  read(): Promise<never>;
  write(): Promise<never>;
}

export interface SdkRealtime {
  readonly projectId: string;
  publish(): Promise<never>;
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
    throw new Error(
      `cloudnivo.${service} data access is not enabled on this plan yet — ` +
        'use the CloudNivo REST API with a project key instead.',
    );
  };
}

export function buildFunctionSdk(opts: {
  auth: FunctionAuthContext;
  /**
   * Full function env (public + secrets). Lives in isolate memory only —
   * the service layer masks secrets in every API response and log line, so
   * values never leave the server through management surfaces.
   */
  publicEnv: Record<string, string>;
}): CloudnivoSdk {
  const op = notAvailable('database');
  const sop = notAvailable('storage');
  const rop = notAvailable('realtime');
  return {
    auth: Object.freeze({ userId: opts.auth.userId, email: opts.auth.email, role: opts.auth.role }),
    project: Object.freeze({ id: opts.auth.projectId }),
    env: Object.freeze({ ...opts.publicEnv }),
    database: Object.freeze({ projectId: opts.auth.projectId, query: op }),
    storage: Object.freeze({ projectId: opts.auth.projectId, read: sop, write: sop }),
    realtime: Object.freeze({ projectId: opts.auth.projectId, publish: rop }),
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
