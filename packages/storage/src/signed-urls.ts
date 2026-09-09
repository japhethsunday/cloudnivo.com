import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { StorageError } from './types.js';

/**
 * HMAC-signed capability tokens for the local provider (and any future
 * provider without native presigning). The token binds project + bucket +
 * path + operation + expiry; tampering invalidates the MAC. Secrets never
 * travel — only the token does.
 */

export type SignedOp = 'download' | 'upload';

export interface SignedUrlClaims {
  v: 1;
  projectId: string;
  bucket: string;
  path: string;
  op: SignedOp;
  exp: number;
  nonce: string;
}

function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function b64urlDecode<T>(raw: string): T {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T;
}

export function signToken(
  secret: string,
  claims: Omit<SignedUrlClaims, 'v' | 'nonce'> & { nonce?: string },
  maxTtlSeconds: number,
): string {
  if (secret.length < 32) throw new StorageError('WEAK_SECRET', 'Signing secret too short', 500);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new StorageError('INVALID_TTL', 'Expiry must be in the future', 400);
  if (claims.exp - now > maxTtlSeconds) {
    throw new StorageError('INVALID_TTL', `Expiry exceeds maximum of ${maxTtlSeconds}s`, 400);
  }
  const payload = b64urlEncode({
    v: 1,
    projectId: claims.projectId,
    bucket: claims.bucket,
    path: claims.path,
    op: claims.op,
    exp: claims.exp,
    nonce: claims.nonce ?? randomBytes(8).toString('hex'),
  });
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyToken(secret: string, token: string): SignedUrlClaims {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) throw new StorageError('INVALID_SIGNATURE', 'Malformed token', 401);
  const expected = createHmac('sha256', secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(mac, 'base64url');
  } catch {
    throw new StorageError('INVALID_SIGNATURE', 'Malformed token', 401);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new StorageError('INVALID_SIGNATURE', 'Invalid signature', 401);
  }
  let claims: SignedUrlClaims;
  try {
    claims = b64urlDecode<SignedUrlClaims>(payload);
  } catch {
    throw new StorageError('INVALID_SIGNATURE', 'Malformed token', 401);
  }
  if (claims.v !== 1 || typeof claims.exp !== 'number') {
    throw new StorageError('INVALID_SIGNATURE', 'Malformed token', 401);
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new StorageError('TOKEN_EXPIRED', 'Signed URL expired', 401);
  }
  return claims;
}
