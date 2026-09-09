/**
 * Dashboard → standalone API client helpers.
 * The dashboard never sees database passwords except through the explicit
 * reveal flow (masked by default, server audit-logged). The Bearer token
 * lives in localStorage (dev) — never in source code.
 */

export function apiBase(): string {
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return 'http://localhost:3001';
}

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem('cn_token') ?? '';
}

export function setToken(token: string): void {
  window.localStorage.setItem('cn_token', token);
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
    headers: {
      ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body,
  });
}
