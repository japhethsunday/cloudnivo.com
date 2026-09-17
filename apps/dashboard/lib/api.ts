/**
 * Dashboard → standalone API client helpers.
 * The dashboard never sees database passwords except through the explicit
 * reveal flow (masked by default, server audit-logged). The Bearer token
 * lives in localStorage (dev) — never in source code.
 */

import { apiOrigin } from './api-origin';

export function apiBase(): string {
  /**
   * Shares one resolver with middleware.ts so the origin the client CALLS and
   * the origin the CSP ALLOWS can never disagree — if they drift apart, every
   * request is blocked by the policy meant to permit it.
   */
  const raw = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : undefined;
  // NODE_ENV, not VERCEL_ENV: middleware.ts reads the same flag, and the two
  // must agree or a build calls one origin while its CSP allows another.
  // NODE_ENV also needs no "system environment variables" opt-in to exist.
  const isProduction = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
  return apiOrigin(raw, isProduction);
}

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem('cn_token') ?? '';
}

export function setToken(token: string): void {
  // Empty = logged out: remove the key entirely instead of leaving cn_token="".
  if (!token) {
    window.localStorage.removeItem('cn_token');
    return;
  }
  window.localStorage.setItem('cn_token', token);
}

/** Forget the stored session, if any. */
export function clearToken(): void {
  window.localStorage.removeItem('cn_token');
}

export interface ApiErrorShape {
  error: { code: string; message: string; requestId: string };
}

export async function apiFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  const token = opts.token ?? getToken();
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: opts.method ?? 'GET',
      // Live infrastructure console: never serve API responses from the
      // browser HTTP cache. A cached project/database payload freezes the
      // whole UI on stale status (e.g. "provisioning" forever).
      cache: 'no-store',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    return { ok: false, status: 0, data: null, error: 'API unreachable. Is the API running?' };
  }
  let json: unknown = null;
  // 204 No Content is success with no body (e.g. deletes) — never an error.
  if (res.status === 204) return { ok: res.ok, status: res.status, data: null, error: null };
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const msg = (json as ApiErrorShape)?.error?.message ?? `HTTP ${res.status}`;
    return { ok: false, status: res.status, data: null, error: msg };
  }
  return { ok: true, status: res.status, data: (json as { data: T }).data, error: null };
}

/** Raw (non-JSON) requests with the same Bearer auth — for bytes up/down. */
export async function apiFetchRaw(
  path: string,
  opts: {
    method?: string;
    body?: BodyInit;
    contentType?: string;
    token?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const token = opts.token ?? getToken();
  return fetch(`${apiBase()}${path}`, {
    method: opts.method ?? 'GET',
    cache: 'no-store',
    headers: {
      ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body,
  });
}

/**
 * A response the session cannot recover from by retrying: the token is gone,
 * expired or revoked. Background pollers use this to stop instead of hammering
 * the API with 401s every few seconds until the tab is closed.
 */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}
