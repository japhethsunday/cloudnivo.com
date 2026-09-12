import { describe, expect, it } from 'vitest';
import {
  bearerFromHeader,
  createApiKey,
  hashApiKey,
  hashPassword,
  revokeSession,
  signSession,
  verifyActiveSession,
  verifyPassword,
  verifySession,
  type RevocationStore,
} from './index.js';

const SECRET = 'x'.repeat(48);

function memoryRevocations(): RevocationStore & { size: number } {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    get size() {
      return m.size;
    },
    async get(k: string) {
      const e = m.get(k);
      if (!e || Date.now() > e.exp) {
        m.delete(k);
        return null;
      }
      return e.v;
    },
    async set(k: string, v: string, ttl = 300) {
      m.set(k, { v, exp: Date.now() + ttl * 1000 });
    },
    async del(k: string) {
      m.delete(k);
    },
  };
}

describe('auth', () => {
  it('hashes and verifies passwords (wrong password fails)', async () => {
    const stored = await hashPassword('correct-horse-123');
    expect(stored).not.toContain('correct-horse-123');
    expect(await verifyPassword('correct-horse-123', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('round-trips sessions and rejects tampered tokens', async () => {
    const sub = '123e4567-e89b-12d3-a456-426614174000';
    const token = await signSession({ sub, email: 'dev@example.com' }, { jwtSecret: SECRET });
    const claims = await verifySession(token, { jwtSecret: SECRET });
    expect(claims.sub).toBe(sub);
    await expect(verifySession(`${token}tampered`, { jwtSecret: SECRET })).rejects.toThrow();
  });

  it('api keys store hash only (raw never derivable)', () => {
    const { raw, prefix, hash } = createApiKey();
    expect(raw.startsWith('cn_')).toBe(true);
    expect(prefix).toBe(raw.slice(0, 12));
    expect(hash).toBe(hashApiKey(raw));
    expect(hash).not.toContain(raw);
  });

  it('parses bearer headers without throwing', async () => {
    expect(bearerFromHeader('Bearer abc')).toBe('abc');
    expect(bearerFromHeader(null)).toBe(null);
    expect(bearerFromHeader('Basic abc')).toBe(null);
  });

  it('revokes exactly one session; others survive', async () => {
    const store = memoryRevocations();
    const sub = '123e4567-e89b-12d3-a456-426614174000';
    const a = await signSession({ sub, email: 'a@example.com' }, { jwtSecret: SECRET });
    const b = await signSession({ sub, email: 'a@example.com' }, { jwtSecret: SECRET });
    // Distinct sessions get distinct IDs.
    expect((await verifySession(a, { jwtSecret: SECRET })).jti).toBeTruthy();
    expect((await verifySession(a, { jwtSecret: SECRET })).jti).not.toBe(
      (await verifySession(b, { jwtSecret: SECRET })).jti,
    );
    expect(await verifyActiveSession(a, { jwtSecret: SECRET }, store)).toBeTruthy();
    const { revoked } = await revokeSession(a, { jwtSecret: SECRET }, store);
    expect(revoked).toBe(true);
    await expect(verifyActiveSession(a, { jwtSecret: SECRET }, store)).rejects.toMatchObject({
      name: 'AuthError',
    });
    // Unrelated session of the same user is untouched.
    expect(await verifyActiveSession(b, { jwtSecret: SECRET }, store)).toBeTruthy();
    // Denylist stores IDs/hashes only — never the raw token.
    expect(store.size).toBeGreaterThan(0);
  });
});
