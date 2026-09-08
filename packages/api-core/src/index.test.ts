import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  checkRateLimit,
  corsHeaders,
  ok,
  parseBody,
  securityHeaders,
  toPublicError,
} from './index.js';

describe('api-core', () => {
  it('wraps success with requestId', () => {
    expect(ok({ a: 1 }, 'r1')).toEqual({ data: { a: 1 }, meta: { requestId: 'r1' } });
  });

  it('validates bodies with consistent 400s', () => {
    const schema = z.object({ name: z.string().min(2) });
    expect(() => parseBody(schema, { name: 'x' })).toThrowError(ApiError);
    try {
      parseBody(schema, { name: 'x' });
    } catch (e) {
      const { status, body } = toPublicError(e, 'r1');
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.requestId).toBe('r1');
    }
  });

  it('hides 500 internals', () => {
    const { status, body } = toPublicError(
      new ApiError('X', 'db conn postgres://u:p@h', 500),
      'r9',
    );
    expect(status).toBe(500);
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('maps domain errors to real statuses (not 500s)', () => {
    const tenant = Object.assign(new Error('Access denied for this organization'), {
      code: 'TENANT_FORBIDDEN',
    });
    expect(toPublicError(tenant, 'r2').status).toBe(403);
    const auth = Object.assign(new Error('Invalid or expired session'), {
      name: 'AuthError',
      code: 'INVALID_SESSION',
    });
    const mapped = toPublicError(auth, 'r3');
    expect(mapped.status).toBe(401);
    expect(mapped.body.error.code).toBe('INVALID_SESSION');
  });

  it('emits secure defaults + strict CORS', () => {
    expect(securityHeaders()['X-Frame-Options']).toBe('DENY');
    expect(
      corsHeaders('https://evil.test', ['https://app.test'])['Access-Control-Allow-Origin'],
    ).toBe(undefined);
    expect(
      corsHeaders('https://app.test', ['https://app.test'])['Access-Control-Allow-Origin'],
    ).toBe('https://app.test');
  });

  it('rate-limits with an abstract store', async () => {
    let n = 0;
    const store = { incr: async () => ++n };
    const opts = { windowMs: 60_000, max: 2 };
    expect((await checkRateLimit(store, 'ip:1', opts)).allowed).toBe(true);
    expect((await checkRateLimit(store, 'ip:1', opts)).allowed).toBe(true);
    expect((await checkRateLimit(store, 'ip:1', opts)).allowed).toBe(false);
  });
});
