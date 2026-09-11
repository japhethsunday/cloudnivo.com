import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook signing. Each subscription gets a `whsec_` secret whose
 * raw value is shown once at creation; only the sha256 hash is stored.
 *
 * Deliveries carry `X-CloudNivo-Signature: sha256=<hex>` where hex =
 * HMAC-SHA256(key, body) and the key is the UTF-8 bytes of
 * `sha256_hex(raw_secret)` — i.e. the stored hash itself. This is deliberate:
 * the server never retains the raw secret, so first attempts, worker
 * retries, and replays all sign identically, and receivers verify without
 * any privileged channel:
 *
 *   key      = sha256_hex(your_raw_whsec_secret)
 *   expected = "sha256=" + HMAC_SHA256(key, exact_response_bytes)
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export function createWebhookSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
  return { raw, hash: hashSecret(raw), prefix: raw.slice(0, 12) };
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function signPayload(keyHex: string, payloadBytes: string): string {
  return `sha256=${createHmac('sha256', keyHex).update(payloadBytes, 'utf8').digest('hex')}`;
}

/** Constant-time verification helper (used by tests and consumer SDKs). */
export function verifySignature(keyHex: string, payloadBytes: string, signature: string): boolean {
  const expected = signPayload(keyHex, payloadBytes);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Retry backoff: 1m, 5m, 30m, 2h, 8h, then 24h. Null = no more retries. */
export function backoffMs(attempt: number): number | null {
  const table = [60_000, 300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000];
  return attempt < table.length ? (table[attempt] as number) : null;
}
