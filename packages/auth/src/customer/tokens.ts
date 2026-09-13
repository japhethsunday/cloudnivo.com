import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AuthError } from '../errors.js';

/**
 * Customer token material.
 *
 * - Access: short-lived JWT, audience-bound to ONE project, carrying the
 *   session id for instant server-side revocation checks.
 * - Refresh/reset/verify: opaque random tokens; ONLY sha256 hashes are stored.
 *   Refresh rotates on every use; presenting an already-used refresh token
 *   signals theft → the whole session is revoked (reuse detection).
 */

export const CustomerAccessClaimsSchema = z
  .object({
    sub: z.string().uuid(),
    email: z.string().email(),
    projectId: z.string().uuid(),
    sessionId: z.string(),
    role: z.string(),
    tokenType: z.literal('customer_access'),
  })
  // Custom claims ride flat beside the canonical set (Supabase-style).
  // Scalars only — anything else fails closed here.
  .catchall(z.union([z.string(), z.number(), z.boolean()]));
export type CustomerAccessClaims = z.infer<typeof CustomerAccessClaimsSchema>;

export interface CustomerTokenOptions {
  jwtSecret: string;
  issuer: string;
  projectId: string;
  accessTtlSeconds: number;
}

const CLAIM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/;
const RESERVED_CLAIMS = new Set([
  'sub',
  'email',
  'projectId',
  'sessionId',
  'role',
  'tokenType',
  'iss',
  'aud',
  'exp',
  'iat',
]);

/**
 * Sanitize developer custom claims for JWT injection: flat scalar values,
 * allowlisted key shape, reserved names rejected, max 10 entries. Anything
 * else is dropped (never throws — claims must not break sign-in).
 */
export function sanitizeCustomClaims(
  input: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= 10) break;
    if (!CLAIM_KEY_RE.test(key) || RESERVED_CLAIMS.has(key)) continue;
    if (typeof value === 'string' && value.length <= 200) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export async function signCustomerAccessToken(
  claims: { sub: string; email: string; sessionId: string; role: string },
  opts: CustomerTokenOptions,
  customClaims?: unknown,
): Promise<string> {
  if (opts.jwtSecret.length < 32) throw new AuthError('WEAK_SECRET', 'JWT secret is too short');
  return new SignJWT({
    email: claims.email,
    projectId: opts.projectId,
    sessionId: claims.sessionId,
    role: claims.role,
    tokenType: 'customer_access',
    ...sanitizeCustomClaims(customClaims),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(opts.issuer)
    .setAudience(opts.projectId)
    .setIssuedAt()
    .setExpirationTime(`${opts.accessTtlSeconds}s`)
    .sign(new TextEncoder().encode(opts.jwtSecret));
}

export async function verifyCustomerAccessToken(
  token: string,
  opts: { jwtSecret: string; issuer: string; projectId: string },
): Promise<CustomerAccessClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.jwtSecret), {
      issuer: opts.issuer,
      audience: opts.projectId,
    });
    const record = payload as Record<string, unknown>;
    // Custom claims ride flat beside the canonical set: forward every
    // scalar extra to the schema (catchall), drop everything else so a
    // malformed claim can never fail verification of a server-issued token.
    const extra: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        if (key.length <= 64) extra[key] = value;
      }
    }
    return CustomerAccessClaimsSchema.parse({
      sub: payload.sub,
      email: record['email'],
      projectId: record['projectId'],
      sessionId: record['sessionId'],
      role: record['role'],
      tokenType: record['tokenType'],
      ...extra,
    });
  } catch {
    throw new AuthError('INVALID_CUSTOMER_TOKEN', 'Invalid or expired access token');
  }
}

/**
 * Signature + expiry check WITHOUT audience binding. Used only to classify a
 * Bearer token (customer-shaped or not) before project matching — never as an
 * authorization decision on its own.
 */
export async function decodeCustomerToken(
  token: string,
  opts: { jwtSecret: string; issuer: string },
): Promise<CustomerAccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(opts.jwtSecret), {
      issuer: opts.issuer,
    });
    return CustomerAccessClaimsSchema.parse({
      sub: payload.sub,
      email: (payload as Record<string, unknown>)['email'],
      projectId: (payload as Record<string, unknown>)['projectId'],
      sessionId: (payload as Record<string, unknown>)['sessionId'],
      role: (payload as Record<string, unknown>)['role'],
      tokenType: (payload as Record<string, unknown>)['tokenType'],
    });
  } catch {
    return null;
  }
}

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
