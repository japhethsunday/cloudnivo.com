import { describe, expect, it } from 'vitest';
import {
  BACKEND_ONLY_ENV,
  DASHBOARD_ENV,
  namesPrivateHost,
  scrubBackendEnv,
} from './env-boundary.js';

/**
 * The failure this pins: a Railway -> Vercel integration syncs the API
 * service's environment into the dashboard's Vercel project. DATABASE_URL
 * then holds a `*.railway.internal` host, which Vercel's network cannot
 * resolve, so anything reading it fails with a DNS error naming a hostname
 * that appears nowhere in the frontend's code.
 */

const RAILWAY_PG = 'postgresql://u:p@postgres.railway.internal:5432/railway';

function env(over: Record<string, string> = {}): Record<string, string | undefined> {
  return { NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.cloudnivo.org', ...over };
}

describe('the dashboard refuses the API environment', () => {
  it('drops a private-network DATABASE_URL and says the host is unreachable', () => {
    const e = env({ DATABASE_URL: RAILWAY_PG });
    const { removed, unreachable } = scrubBackendEnv(e);

    expect(e['DATABASE_URL'], 'must not remain readable').toBeUndefined();
    expect(removed).toContain('DATABASE_URL');
    expect(unreachable).toContain('DATABASE_URL');
  });

  it('drops every API-owned variable the integration syncs', () => {
    const e = env(Object.fromEntries(BACKEND_ONLY_ENV.map(k => [k, 'x'])));
    const { removed } = scrubBackendEnv(e);

    expect(removed).toEqual([...BACKEND_ONLY_ENV].sort());
    for (const key of BACKEND_ONLY_ENV) expect(e[key]).toBeUndefined();
  });

  it('keeps everything the dashboard actually reads', () => {
    const e = env({
      JWT_SECRET: 'a'.repeat(48),
      VERCEL_ENV: 'production',
      CLOUDNIVO_PROJECT_ID: 'proj_1',
      DATABASE_URL: RAILWAY_PG,
    });
    scrubBackendEnv(e);

    expect(e['NEXT_PUBLIC_API_URL']).toBe('https://api.cloudnivo.org');
    expect(e['JWT_SECRET'], 'the BFF verifies sessions with this').toBeDefined();
    expect(e['VERCEL_ENV']).toBe('production');
    expect(e['CLOUDNIVO_PROJECT_ID']).toBe('proj_1');
  });

  it('never lists a variable the dashboard needs as backend-only', () => {
    // A future edit that moves a key into the wrong list breaks the app at
    // runtime; this fails the build instead.
    const needed = new Set<string>(DASHBOARD_ENV);
    for (const key of BACKEND_ONLY_ENV) expect(needed.has(key)).toBe(false);
  });

  it('is a no-op when the environment is already clean', () => {
    const e = env();
    expect(scrubBackendEnv(e).removed).toEqual([]);
    expect(e['NEXT_PUBLIC_API_URL']).toBe('https://api.cloudnivo.org');
  });

  it('reports a private host regardless of the value shape', () => {
    expect(namesPrivateHost(RAILWAY_PG)).toBe(true);
    expect(namesPrivateHost('redis://default:pw@redis.railway.internal:6379')).toBe(true);
    expect(namesPrivateHost('monorail.proxy.rlwy.net')).toBe(false);
    expect(namesPrivateHost('https://api.cloudnivo.org')).toBe(false);
  });
});
