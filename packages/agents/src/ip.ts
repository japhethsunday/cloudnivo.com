import { AgentTokenError } from './tokens.js';

/**
 * IP allowlists for agent tokens (CIDR for IPv4, exact match for IPv6).
 * Empty list = unrestricted (default, back-compat). Unknown/unparseable
 * caller IPs are denied whenever a list is set — fail closed.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;

function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some(n => n > 255)) return null;
  return ((parts[0] as number) * 256 ** 3 + (parts[1] as number) * 256 ** 2 + (parts[2] as number) * 256 + (parts[3] as number)) >>> 0;
}

function normalizeIpv6(ip: string): string | null {
  const clean = ip.trim().toLowerCase();
  if (!clean.includes(':')) return null;
  if (!/^[0-9a-f:.%]+$/.test(clean)) return null;
  return clean;
}

/** Validate + normalize an allowlist (max 20 entries). Throws on junk. */
export function parseIpAllowlist(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new AgentTokenError('VALIDATION_ERROR', 'ipAllowlist must be an array', 400);
  }
  if (input.length > 20) {
    throw new AgentTokenError('VALIDATION_ERROR', 'ipAllowlist holds at most 20 entries', 400);
  }
  const out: string[] = [];
  for (const entry of input) {
    const s = String(entry ?? '').trim();
    if (!s) throw new AgentTokenError('VALIDATION_ERROR', 'ipAllowlist entries must be non-empty', 400);
    const cidr = CIDR_RE.exec(s);
    if (cidr) {
      const base = ipv4ToInt(cidr[1] as string);
      const bits = Number(cidr[2]);
      if (base === null || bits > 32) {
        throw new AgentTokenError('VALIDATION_ERROR', `Invalid CIDR: ${s.slice(0, 60)}`, 400);
      }
      out.push(`${cidr[1]}/${bits}`);
      continue;
    }
    if (ipv4ToInt(s) !== null) {
      out.push(s);
      continue;
    }
    const v6 = normalizeIpv6(s);
    if (v6) {
      out.push(v6);
      continue;
    }
    throw new AgentTokenError('VALIDATION_ERROR', `Invalid IP or CIDR: ${s.slice(0, 60)}`, 400);
  }
  return [...new Set(out)];
}

function v4Matches(ip: string, entry: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  const cidr = CIDR_RE.exec(entry);
  if (!cidr) return addr === ipv4ToInt(entry);
  const base = ipv4ToInt(cidr[1] as string) as number;
  const bits = Number(cidr[2]);
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

/** True when the caller IP satisfies the allowlist (empty = allow all). */
export function ipAllowed(allowlist: string[], ip: string | null | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (!ip || ip === 'unknown') return false;
  const clean = ip.trim();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is the same host as 10.0.0.1.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
  if (mapped) return allowlist.some(entry => v4Matches(mapped[1] as string, entry));
  if (clean.includes(':')) {
    const v6 = normalizeIpv6(clean);
    return v6 !== null && allowlist.includes(v6);
  }
  return allowlist.some(entry => v4Matches(clean, entry));
}
