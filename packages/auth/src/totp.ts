import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238, SHA-1, 30s step, 6 digits) for MFA — dependency-free.
 * Secrets are base32 (RFC 4648, no padding) for `otpauth://` compatibility
 * with any authenticator app. Verification accepts ±1 step skew.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] as string;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] as string;
  return out;
}

export function decodeBase32(secret: string): Buffer {
  const clean = secret.trim().replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean) || clean.length < 16) {
    throw new Error('Invalid TOTP secret');
  }
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(code % 1_000_000).padStart(6, '0');
}

/** Current TOTP code (for tests against RFC vectors — never expose server-side). */
export function totpNow(secret: string, atMs = Date.now(), stepSeconds = 30): string {
  const key = decodeBase32(secret);
  const counter = BigInt(Math.floor(atMs / 1000 / stepSeconds));
  return hotp(key, counter);
}

export function verifyTotp(
  secret: string,
  code: string,
  opts: { atMs?: number; window?: number; stepSeconds?: number } = {},
): boolean {
  const clean = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6,8}$/.test(clean)) return false;
  const step = opts.stepSeconds ?? 30;
  const window = opts.window ?? 1;
  let key: Buffer;
  try {
    key = decodeBase32(secret);
  } catch {
    return false;
  }
  const counter = BigInt(Math.floor((opts.atMs ?? Date.now()) / 1000 / step));
  const want = Buffer.from(clean.length === 6 ? clean.padStart(6, '0') : clean);
  for (let d = -window; d <= window; d += 1) {
    const got = hotp(key, counter + BigInt(d)).padStart(6, '0');
    const a = Buffer.from(clean.length === 6 ? got : got.padStart(clean.length, '0'));
    if (a.length === want.length && timingSafeEqual(a, want)) return true;
  }
  return false;
}

export function totpProvisionUri(opts: { secret: string; account: string; issuer?: string }): string {
  const label = `${encodeURIComponent(opts.issuer ?? 'CloudNivo')}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer ?? 'CloudNivo',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use MFA recovery codes: `code` shown once, only sha256 stored. */
export function generateBackupCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = `${randomBytes(4).toString('hex').slice(0, 4)}-${randomBytes(4).toString('hex').slice(0, 4)}`;
    codes.push(code);
    // Canonical form (no separators): verification strips spaces/dashes
    // before comparing, so users can type codes either way.
    hashes.push(createHash('sha256').update(code.replace(/[\s-]/g, '')).digest('hex'));
  }
  return { codes, hashes };
}
