import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
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

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

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
  return new SignJWT({ email: parsed.email, org: parsed.org } as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(parsed.sub)
    .setIssuer(opts.issuer ?? 'cloudnivo')
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 3600}s`)
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
    });
  } catch {
    throw new AuthError('INVALID_SESSION', 'Invalid or expired session');
  }
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
