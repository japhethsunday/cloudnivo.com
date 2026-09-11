'use client';

/** Read-only JWT claim inspection (no secret needed to read expiry). */
export function sessionExpiresAt(token: string | null): string | null {
  if (!token || typeof window === 'undefined') return null;
  try {
    const segment = token.split('.')[1] ?? '';
    const payload = JSON.parse(window.atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    if (typeof payload.exp !== 'number') return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}
