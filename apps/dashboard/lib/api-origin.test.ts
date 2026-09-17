import { describe, expect, it } from 'vitest';
import { CANONICAL_API_ORIGIN, apiOrigin, resolveApiOrigin } from './api-origin.js';

/**
 * The regression this pins: production shipped with NEXT_PUBLIC_API_URL set
 * to cloudnivo-api-production.up.railway.app long after the API moved to
 * api.cloudnivo.org. The value is inlined at build time and also builds the
 * CSP connect-src, so the wrong host was compiled into the bundle and into
 * the policy — and nothing in the repository could see it.
 */

const RAILWAY = 'https://cloudnivo-api-production.up.railway.app';

describe('resolveApiOrigin in production', () => {
  it('refuses a generated Railway host and falls back to the real domain', () => {
    const r = resolveApiOrigin(RAILWAY, true);
    expect(r.origin).toBe(CANONICAL_API_ORIGIN);
    expect(r.rejected).toBe(RAILWAY);
  });

  it('refuses other providers generated hosts too', () => {
    for (const host of ['https://x.vercel.app', 'https://y.onrender.com']) {
      expect(resolveApiOrigin(host, true).origin).toBe(CANONICAL_API_ORIGIN);
    }
  });

  it('cannot be fooled by a generated host in the path or query', () => {
    const sneaky = 'https://api.cloudnivo.org/proxy?to=x.up.railway.app';
    // The host is the real domain, so this is accepted — and normalised to
    // the origin, which drops the path a CSP could not have used anyway.
    expect(resolveApiOrigin(sneaky, true).origin).toBe('https://api.cloudnivo.org');
  });

  it('accepts a real custom domain unchanged', () => {
    expect(resolveApiOrigin('https://api.cloudnivo.org/api/v1', true).origin).toBe(
      'https://api.cloudnivo.org',
    );
  });

  it('falls back when the value is missing or unparseable', () => {
    expect(resolveApiOrigin(undefined, true).origin).toBe(CANONICAL_API_ORIGIN);
    expect(resolveApiOrigin('not a url', true).origin).toBe(CANONICAL_API_ORIGIN);
    expect(resolveApiOrigin('not a url', true).rejected).toBe('not a url');
  });

  it('rejects a non-http scheme rather than emitting it into the CSP', () => {
    expect(resolveApiOrigin('javascript:alert(1)', true).origin).toBe(CANONICAL_API_ORIGIN);
    expect(resolveApiOrigin('file:///etc/passwd', true).origin).toBe(CANONICAL_API_ORIGIN);
  });
});

describe('resolveApiOrigin in development', () => {
  it('takes the configured value as given, so `next dev` can point anywhere', () => {
    expect(resolveApiOrigin(RAILWAY, false).origin).toBe(RAILWAY);
    expect(resolveApiOrigin(RAILWAY, false).rejected).toBeNull();
  });

  it('defaults to the local API when nothing is set', () => {
    expect(resolveApiOrigin(undefined, false).origin).toBe('http://localhost:3001');
  });
});

describe('apiOrigin', () => {
  it('returns the origin alone', () => {
    expect(apiOrigin(RAILWAY, true)).toBe(CANONICAL_API_ORIGIN);
  });
});
