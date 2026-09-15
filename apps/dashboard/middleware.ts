import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Edge-safe middleware: request IDs + strict security headers.
 * Auth/CORS enforcement lives in route handlers (Node runtime) so secrets
 * never touch the Edge. Keep this file free of Node-only imports.
 *
 * The connect-src allowlist is built dynamically: the dashboard calls the
 * standalone API at NEXT_PUBLIC_API_URL (a different origin in production),
 * so its origin must be allowed or every API call is CSP-blocked.
 */
function cspHeader(): string {
  const connect = ["'self'"];
  // Local dev API/realtime origins (never in production builds).
  if (process.env.VERCEL_ENV !== 'production') {
    connect.push('http://localhost:3001', 'http://localhost:3002');
  }
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (raw) {
    try {
      const origin = new URL(raw).origin;
      if ((origin.startsWith('https://') || origin.startsWith('http://')) && !connect.includes(origin)) {
        connect.push(origin);
      }
    } catch {
      // Misconfigured env: fall back to 'self'-only (fail closed, no injection).
    }
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
}
export function middleware(request: NextRequest): NextResponse {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const response = NextResponse.next();
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('Content-Security-Policy', cspHeader());
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
