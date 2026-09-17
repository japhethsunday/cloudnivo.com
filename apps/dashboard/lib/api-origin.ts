/**
 * Where the dashboard believes the API lives.
 *
 * NEXT_PUBLIC_API_URL decides two things at once: the origin every client
 * request goes to, and the CSP connect-src that permits it. It is inlined at
 * BUILD time, so a wrong value is not a setting anyone can correct after the
 * fact — it is compiled into the bundle and ships.
 *
 * That is how the dashboard came to ship a generated *.up.railway.app host in
 * production after the API had moved to its own domain: the value lived in
 * Vercel project state, nothing in the repository could see it, and a build
 * that read it looked completely healthy.
 *
 * So any production build (NODE_ENV=production — deployed production AND
 * preview) refuses a hosting provider's generated hostname outright and falls
 * back to the canonical origin. A generated host is never the right answer
 * for a deployed build: it is a scaffold address that changes when a service
 * is recreated. Failing over to the real domain is safer than compiling a
 * wrong one in.
 *
 * In development the value is taken as given, so `next dev` against a local
 * or throwaway API still works.
 *
 * middleware.ts (CSP connect-src) and lib/api.ts (the origin requests go to)
 * BOTH resolve through here, reading the same NODE_ENV flag. If they were
 * allowed to disagree, the client would call an origin its own CSP blocks.
 */

/** The API origin this product is served from. */
export const CANONICAL_API_ORIGIN = 'https://api.cloudnivo.org';

/**
 * Hostnames that are a platform's own scaffolding rather than a product
 * domain. Matched on the host, so a path or query cannot smuggle one past.
 */
const GENERATED_HOSTS = [/\.up\.railway\.app$/i, /\.vercel\.app$/i, /\.onrender\.com$/i];

export interface ResolvedApiOrigin {
  /** The origin to use — always safe to put in a URL or a CSP. */
  origin: string;
  /** Set when the configured value was rejected, for a build-time warning. */
  rejected: string | null;
}

export function resolveApiOrigin(raw: string | undefined, isProduction: boolean): ResolvedApiOrigin {
  if (!raw) return { origin: isProduction ? CANONICAL_API_ORIGIN : 'http://localhost:3001', rejected: null };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Unparseable: fail over rather than emit a malformed origin into the CSP.
    return { origin: isProduction ? CANONICAL_API_ORIGIN : 'http://localhost:3001', rejected: raw };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { origin: isProduction ? CANONICAL_API_ORIGIN : 'http://localhost:3001', rejected: raw };
  }

  if (isProduction && GENERATED_HOSTS.some(re => re.test(url.hostname))) {
    return { origin: CANONICAL_API_ORIGIN, rejected: raw };
  }

  return { origin: url.origin, rejected: null };
}

/** The origin alone, for call sites that cannot act on a rejection. */
export function apiOrigin(raw: string | undefined, isProduction: boolean): string {
  return resolveApiOrigin(raw, isProduction).origin;
}
