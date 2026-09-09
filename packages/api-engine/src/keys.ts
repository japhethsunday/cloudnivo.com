import { createApiKey, hashApiKey } from '@cloudnivo/auth';

/**
 * Project API keys — the customer-facing credential layer.
 *
 * Roles (least privilege first):
 * - `public`  — read-only (GET). Safe-ish for browsers, still rate-limited.
 * - `service` — read + write (GET/POST/PATCH/DELETE). Server-side only.
 * - `admin`   — reserved for future key management. Never issued to browsers.
 *
 * Storage: `{ prefix, sha256 hash }` only — raw keys are shown once at issue
 * and never logged. Keys bind to exactly one project, support expiry, and are
 * revocable. Usage counters back the dashboard usage panel.
 */

export const KEY_ROLES = ['public', 'service', 'admin'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

export interface ProjectApiKey {
  id: string;
  projectId: string;
  organizationId: string;
  name: string;
  prefix: string;
  hash: string;
  role: KeyRole;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  requestCount: number;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** Public key shape: hash is never exposed outside issue-time. */
export type ExposedKey = Omit<ProjectApiKey, 'hash'>;

export interface KeyStore {
  save(key: ProjectApiKey): Promise<void>;
  findByHash(hash: string): Promise<ProjectApiKey | null>;
  listByProject(projectId: string): Promise<ExposedKey[]>;
  revoke(id: string): Promise<ExposedKey | null>;
  touch(id: string): Promise<void>;
}

let keyCounter = 0;

export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, ProjectApiKey>();

  async save(key: ProjectApiKey): Promise<void> {
    this.keys.set(key.id, key);
  }

  async findByHash(hash: string): Promise<ProjectApiKey | null> {
    for (const k of this.keys.values()) {
      if (k.hash === hash) return { ...k };
    }
    return null;
  }

  async listByProject(projectId: string): Promise<ExposedKey[]> {
    return [...this.keys.values()]
      .filter(k => k.projectId === projectId)
      .map(k => {
        const { hash: _dropped, ...rest } = k;
        void _dropped;
        return rest;
      });
  }

  async revoke(id: string): Promise<ExposedKey | null> {
    const k = this.keys.get(id);
    if (!k || k.revokedAt) return null;
    const next = { ...k, revokedAt: new Date().toISOString() };
    this.keys.set(id, next);
    const { hash: _dropped, ...rest } = next;
    void _dropped;
    return rest;
  }

  async touch(id: string): Promise<void> {
    const k = this.keys.get(id);
    if (!k) return;
    this.keys.set(id, {
      ...k,
      requestCount: k.requestCount + 1,
      lastUsedAt: new Date().toISOString(),
    });
  }
}

export class KeyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'KeyError';
    this.code = code;
    this.status = status;
  }
}

export interface IssuedKey {
  key: Omit<ProjectApiKey, 'hash'>;
  /** Raw secret — return once, then discard. Never persist or log. */
  raw: string;
}

export async function issueKey(
  store: KeyStore,
  input: {
    projectId: string;
    organizationId: string;
    name: string;
    role: KeyRole;
    scopes?: string[];
    expiresAt?: string | null;
    createdBy: string;
  },
): Promise<IssuedKey> {
  if (!KEY_ROLES.includes(input.role)) throw new KeyError('INVALID_ROLE', 'Unknown key role', 400);
  if (!input.name || input.name.length > 100)
    throw new KeyError('INVALID_NAME', 'Bad key name', 400);
  let expiresAt: string | null = input.expiresAt ?? null;
  if (expiresAt) {
    const t = Date.parse(expiresAt);
    if (Number.isNaN(t) || t <= Date.now())
      throw new KeyError('INVALID_EXPIRY', 'Expiry must be future', 400);
    expiresAt = new Date(t).toISOString();
  }
  const pair = createApiKey();
  keyCounter += 1;
  const key: ProjectApiKey = {
    id: `key_${Date.now().toString(36)}_${keyCounter}`,
    projectId: input.projectId,
    organizationId: input.organizationId,
    name: input.name,
    prefix: pair.prefix,
    hash: pair.hash,
    role: input.role,
    scopes: input.scopes ?? [],
    expiresAt,
    revokedAt: null,
    requestCount: 0,
    lastUsedAt: null,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await store.save(key);
  const { hash: _hash, ...exposed } = key;
  void _hash;
  return { key: exposed, raw: pair.raw };
}

/** Verify a raw key → live record. Throws KeyError (401/403/410) otherwise. */
export async function verifyKey(store: KeyStore, raw: string): Promise<ProjectApiKey> {
  if (!raw || raw.length > 200) throw new KeyError('INVALID_KEY', 'Invalid API key');
  const found = await store.findByHash(hashApiKey(raw));
  if (!found) throw new KeyError('INVALID_KEY', 'Invalid API key');
  if (found.revokedAt) throw new KeyError('KEY_REVOKED', 'API key revoked', 403);
  if (found.expiresAt && Date.parse(found.expiresAt) <= Date.now()) {
    throw new KeyError('KEY_EXPIRED', 'API key expired', 401);
  }
  return found;
}

export function keyCanWrite(role: KeyRole): boolean {
  return role === 'service' || role === 'admin';
}

/** Public shape: hash stripped, safe for list/revoke responses. */
export function exposeKey(key: ProjectApiKey): Omit<ProjectApiKey, 'hash'> {
  const { hash: _hash, ...rest } = key;
  void _hash;
  return rest;
}
