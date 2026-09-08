import { NextResponse } from 'next/server';
import { ok, securityHeaders, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard BFF example for `/api/v1/projects`.
 * Mirrors `apps/api`: Bearer-required, tenant-scoped, same envelope.
 * DB-backed listing lands in Phase 2; Phase 1 proves the boundary.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const headers: Record<string, string> = { 'X-Request-Id': requestId };
  for (const [k, v] of Object.entries(securityHeaders())) headers[k] = v;
  try {
    const token = bearerFromHeader(request.headers.get('authorization'));
    if (!token) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing bearer token', requestId } },
        { status: 401, headers },
      );
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: 'Internal server error', requestId } },
        { status: 500, headers },
      );
    }
    const session = await verifySession(token, { jwtSecret: secret });
    return NextResponse.json(ok({ projects: [], user: session.sub }, requestId), {
      status: 200,
      headers,
    });
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    return NextResponse.json(body, { status, headers });
  }
}
