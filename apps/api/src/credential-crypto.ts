import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Credential at-rest encryption (H4 fix).
 * AES-256-GCM with key derived from VAULT_KEY. Stored format `enc:v1:<envelope>`,
 * where envelope is base64url(iv).base64url(tag).base64url(ciphertext).
 * Reads fall back to plaintext for legacy rows so migration is non-breaking.
 */

const PREFIX = 'enc:v1:';

export function credentialKeyFromSecret(secret: string): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return createHash('sha256').update(`cred:${secret}`).digest();
}

export function encryptCredential(plaintext: string, key: Buffer | null): string {
  if (!key) return plaintext;
  return `${PREFIX}${encryptEnvelope(plaintext, key)}`;
}

function encryptEnvelope(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptCredential(stored: string, key: Buffer | null): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!key) throw new Error('Encrypted credential requires VAULT_KEY');
  const envelope = stored.slice(PREFIX.length);
  const [ivB, tagB, dataB] = envelope.split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Malformed credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
