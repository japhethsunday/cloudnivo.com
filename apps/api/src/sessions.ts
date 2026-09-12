import { verifyActiveSession, type SessionClaims } from '@cloudnivo/auth';
import type { ApiContext } from './v1.js';

/**
 * Platform session gate: signature + expiry + server-side revocation
 * (logout) check. Use for EVERY platform Bearer verification — never call
 * `verifySession` directly in routes (customer tokens and agent tokens have
 * their own verification paths).
 *
 * Lives in its own module so route files don't import the full v1 wiring
 * (import is type-only; no runtime cycle).
 */
export async function verifyPlatformSession(
  ctx: ApiContext,
  token: string,
): Promise<SessionClaims> {
  return verifyActiveSession(
    token,
    { jwtSecret: ctx.config.JWT_SECRET, issuer: ctx.config.JWT_ISSUER },
    ctx.sessionRevocations,
  );
}
