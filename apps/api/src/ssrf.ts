import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * One SSRF guard for every outbound request CloudNivo makes on a user's
 * behalf (automation webhooks, log drains).
 *
 * A hostname allow-check alone is not a guard: the name an operator stores is
 * resolved later, and `evil.example` can resolve to 169.254.169.254 or a
 * 10.0.0.0/8 neighbour whenever the attacker chooses. Every delivery path must
 * therefore resolve first and judge the address, and fail closed when DNS
 * cannot answer.
 */

/** True for loopback, link-local, private, multicast and unspecified addresses. */
export function isPrivateResolvedIp(addr: string): boolean {
  const raw = addr.trim().replace(/^\[|\]$/g, '');
  if (isIP(raw) !== 4 && isIP(raw) !== 6) return true;
  if (raw.includes(':')) {
    const h = raw.toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) return isPrivateResolvedIp(h.slice(7));
    return /^(2001:db8|ff00)/i.test(h);
  }
  const b = raw.split('.').map(Number);
  const [a, c] = b;
  if (a === undefined || c === undefined) return true;
  return (
    a === 127 ||
    a === 0 ||
    a === 10 ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 169 && c === 254) ||
    a >= 224
  );
}

/**
 * Resolve `host` and report whether every answer is a public address.
 * Fails closed: an unresolvable host is treated as blocked.
 */
export async function resolvesToPublicAddress(host: string): Promise<boolean> {
  const name = host.trim().replace(/^\[|\]$/g, '');
  // A literal address needs no DNS — judge it directly.
  if (isIP(name) !== 0) return !isPrivateResolvedIp(name);
  const answers = await lookup(name, { all: true }).catch(() => null);
  if (!answers || answers.length === 0) return false;
  return answers.every(a => !isPrivateResolvedIp(a.address));
}
