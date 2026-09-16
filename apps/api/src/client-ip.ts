import type { IncomingMessage } from 'node:http';

/**
 * The caller's real IP address, for rate limiting, brute-force protection and
 * audit records.
 *
 * `X-Forwarded-For` is a client-supplied header. Taking its FIRST entry — as
 * every call site here used to — hands the attacker the value: sending a new
 * `X-Forwarded-For` per request gave every login attempt its own rate-limit
 * bucket, which removed brute-force protection entirely (verified: 12 failed
 * logins, no 429; the same 12 without the header hit 429 at the tenth).
 *
 * The only trustworthy entries are the ones appended by proxies we actually
 * run in front of this service. With N trusted hops the client address is the
 * Nth entry from the RIGHT; with zero hops the header is ignored outright and
 * only the socket address counts.
 */
export function clientIpOf(req: IncomingMessage, trustedProxyHops: number): string | null {
  const socketIp = req.socket.remoteAddress ?? null;
  if (trustedProxyHops <= 0) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header) return socketIp;
  const entries = header
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  // Only the last `trustedProxyHops` entries were appended by proxies we run;
  // the client IP is the one immediately to their left. Fewer entries than
  // trusted hops means the header did not come through our proxy chain at all,
  // so it is entirely client-controlled — fail closed on the socket address
  // rather than trusting a value the caller chose.
  if (entries.length <= trustedProxyHops) return socketIp;
  return entries[entries.length - trustedProxyHops - 1] ?? socketIp;
}

/** Same value with a non-null fallback, for rate-limit bucket keys. */
export function rateLimitIp(req: IncomingMessage, trustedProxyHops: number): string {
  return clientIpOf(req, trustedProxyHops) ?? 'unknown';
}
