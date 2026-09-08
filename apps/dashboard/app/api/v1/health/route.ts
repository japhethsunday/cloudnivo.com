import { NextResponse } from 'next/server';
import { ok, securityHeaders } from '@cloudnivo/api-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): NextResponse {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const body = ok({ status: 'ok', version: '0.1.0' }, requestId);
  const res = NextResponse.json(body, { status: 200 });
  res.headers.set('X-Request-Id', requestId);
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  return res;
}
