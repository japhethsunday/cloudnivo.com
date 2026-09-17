import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveApiOrigin } from './lib/api-origin';

/**
 * Edge-safe middleware: request IDs + strict security headers.
 * Auth/CORS enforcement lives in route handlers (Node runtime) so secrets
 * never touch the Edge. Keep this file free of Node-only imports.
 *
 * The connect-src allowlist is built dynamically: the dashboard calls the
 * standalone API at NEXT_PUBLIC_API_URL (a different origin in production),
 * so its origin must be allowed or every API call is CSP-blocked.
 *
 * script-src is nonce-based, not `'self'` alone. The App Router streams its
 * RSC payload through inline `<script>self.__next_f.push(...)</script>` tags;
 * under a bare `script-src 'self'` the browser refuses every one of them and
 * the app never hydrates — a blank console, no API calls, no recovery. Next
 * reads the nonce from the CSP on the *request* headers and stamps it onto
 * those inline scripts, so the nonce must travel both ways: on the request
 * (for Next) and on the response (for the browser). `'self'` stays for the
 * build-time `<script src>` tags on prerendered pages, which exist before
 * any request can hand them a nonce.
 */
function cspHeader(nonce: string): string {
  const connect = ["'self'"];
  // Local dev API/realtime origins (never in production builds).
  if (process.env.NODE_ENV !== 'production') {
    connect.push(
      'http://localhost:3001',
      'http://localhost:3002',
      'ws://localhost:3001',
      'ws://localhost:3002',
    );
  }
  /**
   * resolveApiOrigin validates the configured value and, in a production
   * build, refuses a hosting provider's generated hostname in favour of the
   * canonical API domain. A malformed or non-http value can therefore never
   * reach the policy below.
   */
  const { origin } = resolveApiOrigin(
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NODE_ENV === 'production',
  );
  if (!connect.includes(origin)) {
    connect.push(origin);
    /**
     * The WebSocket origin has to be listed separately. CSP matches
     * `wss://host` against `https://host` as a DIFFERENT scheme — only
     * http→https and ws→wss are treated as equivalent — so realtime
     * sockets were blocked by the very policy meant to allow the API
     * they share a host with.
     */
    const wsOrigin = origin.replace(/^http/, 'ws');
    if (!connect.includes(wsOrigin)) connect.push(wsOrigin);
  }
  // `'self'` stays alongside the nonce: statically prerendered pages emit
  // their `<script src>` tags at build time, before any request exists to
  // carry a nonce, so `'strict-dynamic'` (which makes the browser ignore
  // `'self'`) would block the very chunks the page needs.
  const scriptSrc = `'self' 'nonce-${nonce}'`;
  return `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
}

export function middleware(request: NextRequest): NextResponse {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const nonce = btoa(crypto.randomUUID());
  const csp = cspHeader(nonce);

  // Next reads the nonce off the request-side CSP to stamp its inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
