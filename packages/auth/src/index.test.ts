import { describe, expect, it } from 'vitest';
import {
  bearerFromHeader,
  createApiKey,
  hashApiKey,
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from './index.js';

const SECRET = 'x'.repeat(48);

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

  it('parses bearer headers without throwing', () => {
    expect(bearerFromHeader('Bearer abc')).toBe('abc');
    expect(bearerFromHeader(null)).toBe(null);
    expect(bearerFromHeader('Basic abc')).toBe(null);
  });
});
