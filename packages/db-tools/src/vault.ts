import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DbToolsError } from './errors.js';

/**
 * Project vault: AES-256-GCM envelope encryption for per-project secrets
 * (third-party API keys, function env secrets). Ciphertext lives in the
 * control plane; the data key comes from VAULT_KEY env (required in
 * production — no weak default). Values are write-only: reads return
 * metadata (name, createdAt) unless explicitly revealed with audit.
 */

export function vaultKeyFromSecret(secret: string): Buffer {
  if (secret.length < 32) {
    throw new DbToolsError('VALIDATION_ERROR', 'VAULT_KEY must be at least 32 characters', 400);
  }
  return createHash('sha256').update(`vault:${secret}`).digest();
}

/** Envelope: base64url(iv).base64url(tag).base64url(ciphertext). */
export function vaultEncrypt(plaintext: string, key: Buffer): string {
  if (Buffer.byteLength(plaintext, 'utf8') > 65_536) {
    throw new DbToolsError('VALIDATION_ERROR', 'Vault value exceeds 64 KiB', 400);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function vaultDecrypt(envelope: string, key: Buffer): string {
  const [ivB, tagB, dataB] = envelope.split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Malformed vault envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const VAULT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function assertVaultName(name: string): string {
  if (!VAULT_NAME_RE.test(name)) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      'Vault names must be 1-64 chars: letters, digits, underscore, dash',
      400,
    );
  }
  return name;
}

export interface VaultRecord {
  projectId: string;
  name: string;
  /** Ciphertext envelope — the only thing persisted. */
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultStore {
  put(record: VaultRecord): Promise<void>;
  get(projectId: string, name: string): Promise<VaultRecord | null>;
  list(projectId: string): Promise<{ name: string; createdAt: string; updatedAt: string }[]>;
  remove(projectId: string, name: string): Promise<boolean>;
}

export class MemoryVaultStore implements VaultStore {
  private readonly map = new Map<string, VaultRecord>();
  private key(projectId: string, name: string): string {
    return `${projectId}:${name}`;
  }
  async put(record: VaultRecord): Promise<void> {
    this.map.set(this.key(record.projectId, record.name), { ...record });
  }
  async get(projectId: string, name: string): Promise<VaultRecord | null> {
    const r = this.map.get(this.key(projectId, name));
    return r ? { ...r } : null;
  }
  async list(projectId: string): Promise<{ name: string; createdAt: string; updatedAt: string }[]> {
    return [...this.map.values()]
      .filter(r => r.projectId === projectId)
      .map(r => ({ name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async remove(projectId: string, name: string): Promise<boolean> {
    return this.map.delete(this.key(projectId, name));
  }
}
