import { createHash, randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

const scrypt = promisify(_scrypt);

/**
 * AuthService boundary.
 *
 * - Passwords: scrypt (Node built-in, no native deps) with per-user salt.
 * - Sessions: signed JWTs (jose, Edge-compatible for future middleware).
 * - API keys: `cn_<32 random chars>` shown ONCE; only SHA-256 hash is stored.
 * - Authorization is ALWAYS server-side (see @cloudnivo/database tenant+rbac).
 */

export const SessionClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  org: z.string().uuid().optional(),
  /** Session ID for server-side revocation. Absent on pre-revocation tokens. */
  jti: z.string().uuid().optional(),
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;

export interface AuthServiceOptions {
  jwtSecret: string;
  issuer?: string;
  expiresInSeconds?: number;
}

export interface ApiKeyPair {
  /** Raw key — return to the caller once, then discard. Never persist. */
  raw: string;
  prefix: string;
  hash: string;
}

// Single AuthError definition lives in the leaf module so customer/* can
// extend it without a package-level import cycle (see errors.ts).
import { AuthError } from './errors.js';
export { AuthError } from './errors.js';

function secretKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new AuthError('WEAK_SECRET', 'JWT secret is too short');
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new AuthError('WEAK_PASSWORD', 'Password too short');
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split(':');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function signSession(
  claims: SessionClaims,
  opts: AuthServiceOptions,
): Promise<string> {
  const parsed = SessionClaimsSchema.parse(claims);
  // Every session carries a unique ID so logout can revoke exactly this
  // session server-side without touching any other session of the user.
  const jti = parsed.jti ?? randomUUID();
  return new SignJWT({ email: parsed.email, org: parsed.org } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(parsed.sub)
    .setIssuer(opts.issuer ?? 'cloudnivo')
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 3600}s`)
    .setJti(jti)
    .sign(secretKey(opts.jwtSecret));
}

export async function verifySession(
  token: string,
  opts: AuthServiceOptions,
): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(opts.jwtSecret), {
      issuer: opts.issuer ?? 'cloudnivo',
    });
    return SessionClaimsSchema.parse({
      sub: payload.sub,
      email: (payload as Record<string, unknown>)['email'],
      org: (payload as Record<string, unknown>)['org'],
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    });
  } catch {
    throw new AuthError('INVALID_SESSION', 'Invalid or expired session');
  }
}

// ── Server-side session revocation ─────────────────────────────
//
// Stateless JWTs cannot be "taken back" by themselves: logout must record the
// session ID (jti) in a shared denylist checked on every request. The store
// is the existing CacheService (Redis in production → shared across
// instances; memory in dev/test). Only hashes/IDs are stored — never raw
// tokens. Entries expire with the session itself, so the denylist is
// self-cleaning and needs no background reaper.

/** Minimal surface the revocation denylist needs (satisfied by CacheService). */
export interface RevocationStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

const REVOKED_PREFIX = 'sess-revoked:';

function revocationKeys(token: string, jti: string | undefined): string[] {
  const keys: string[] = [];
  if (jti) keys.push(`${REVOKED_PREFIX}jti:${jti}`);
  // Token-hash fallback covers pre-jti legacy tokens (no jti claim) and
  // double-guards jti tokens. sha256 only — the raw token never persists.
  keys.push(`${REVOKED_PREFIX}tok:${createHash('sha256').update(token).digest('hex')}`);
  return keys;
}

/** Seconds until `exp` (floor 1). Used to bound denylist entry lifetime. */
export function sessionTtlSeconds(token: string, opts: AuthServiceOptions): Promise<number> {
  return jwtVerify(token, secretKey(opts.jwtSecret), {
    issuer: opts.issuer ?? 'cloudnivo',
  })
    .then(({ payload }) => {
      const exp = typeof payload.exp === 'number' ? payload.exp : 0;
      return Math.max(1, exp - Math.floor(Date.now() / 1000));
    })
    .catch(() => 1);
}

/** Verify signature + expiry AND reject revoked sessions. */
export async function verifyActiveSession(
  token: string,
  opts: AuthServiceOptions,
  store?: RevocationStore | null,
): Promise<SessionClaims> {
  const session = await verifySession(token, opts);
  if (store) {
    for (const key of revocationKeys(token, session.jti)) {
      const hit = await store.get(key).catch(() => null);
      if (hit !== null) throw new AuthError('REVOKED_SESSION', 'Session has been revoked');
    }
  }
  return session;
}

/**
 * Revoke a session server-side. Safe to call with expired/malformed tokens
 * (logout must still clear the cookie): unparsable tokens resolve to a
 * token-hash entry with a minimal TTL.
 */
export async function revokeSession(
  token: string,
  opts: AuthServiceOptions,
  store: RevocationStore,
): Promise<{ revoked: boolean; jti: string | null }> {
  const ttl = await sessionTtlSeconds(token, opts);
  let jti: string | null = null;
  try {
    const session = await verifySession(token, opts);
    jti = session.jti ?? null;
  } catch {
    jti = null;
  }
  for (const key of revocationKeys(token, jti ?? undefined)) {
    await store.set(key, '1', ttl).catch(() => undefined);
  }
  return { revoked: true, jti };
}

/** Create an API key pair. Store `{ prefix, hash }` — never `raw`. */
export function createApiKey(): ApiKeyPair {
  const raw = `cn_${randomBytes(24).toString('base64url')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, prefix: raw.slice(0, 12), hash };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Extract a Bearer token without logging it. Returns null when absent/malformed. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

// ── Customer authentication (per-project application users) ─────────────
// Extends — never replaces — the platform primitives above.
export * from './totp.js';
export * from './password-policy.js';
export * from './otp.js';
export * from './captcha.js';
export * from './sms.js';
export * from './oidc.js';
export * from './customer/types.js';
export * from './customer/tokens.js';
export * from './customer/metadata.js';
export * from './customer/email.js';
export * from './customer/email-providers.js';
export * from './customer/store.js';
export * from './customer/pg-store.js';
export * from './customer/service.js';
export * from './customer/rls.js';
