import { verifyActiveSession, type SessionClaims } from '@cloudnivo/auth';
import { assertNotSuspended, platformAuthFor } from './platform-auth.js';
import type { ApiContext } from './v1.js';

/**
 * Platform session gate: signature + expiry + server-side revocation
 * (logout) check, then the account's own standing. Use for EVERY platform
 * Bearer verification — never call `verifySession` directly in routes
 * (customer tokens and agent tokens have their own verification paths).
 *
 * The suspension check lives HERE, at the one chokepoint all 46 platform
 * call sites already pass through, rather than in each route. A suspension
 * enforced anywhere else would be partial by construction: the token stays
 * validly signed, so every route that forgot the check would keep serving a
 * suspended account until its token expired.
 *
 * It costs one store read per authenticated request. That is the price of a
 * suspension that takes effect on the next call instead of at token expiry,
 * and it is the same read the staff gate already performs.
 *
 * Lives in its own module so route files don't import the full v1 wiring
 * (import is type-only; no runtime cycle).
 */
export async function verifyPlatformSession(
  ctx: ApiContext,
  token: string,
): Promise<SessionClaims> {
  const claims = await verifyActiveSession(
    token,
    { jwtSecret: ctx.config.JWT_SECRET, issuer: ctx.config.JWT_ISSUER },
    ctx.sessionRevocations,
  );
  const user = await platformAuthFor(ctx).users.findById(claims.sub);
  // A token for a user the store no longer knows is not this gate's problem
  // — routes resolve the user themselves and 404/401 accordingly.
  if (user) assertNotSuspended(user);
  return claims;
}
