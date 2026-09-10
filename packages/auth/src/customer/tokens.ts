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

export const CustomerAccessClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  projectId: z.string().uuid(),
  sessionId: z.string(),
  role: z.string(),
  tokenType: z.literal('customer_access'),
});
export type CustomerAccessClaims = z.infer<typeof CustomerAccessClaimsSchema>;

export interface CustomerTokenOptions {
  jwtSecret: string;
  issuer: string;
  projectId: string;
  accessTtlSeconds: number;
}

export async function signCustomerAccessToken(
  claims: { sub: string; email: string; sessionId: string; role: string },
  opts: CustomerTokenOptions,
): Promise<string> {
  if (opts.jwtSecret.length < 32) throw new AuthError('WEAK_SECRET', 'JWT secret is too short');
  return new SignJWT({
    email: claims.email,
    projectId: opts.projectId,
    sessionId: claims.sessionId,
    role: claims.role,
    tokenType: 'customer_access',
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
    return CustomerAccessClaimsSchema.parse({
      sub: payload.sub,
      email: (payload as Record<string, unknown>)['email'],
      projectId: (payload as Record<string, unknown>)['projectId'],
      sessionId: (payload as Record<string, unknown>)['sessionId'],
      role: (payload as Record<string, unknown>)['role'],
      tokenType: (payload as Record<string, unknown>)['tokenType'],
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
