import { eq } from 'drizzle-orm';
import { apiKeys, type Database } from '@cloudnivo/database';
import { exposeKey, type ExposedKey, type KeyStore, type ProjectApiKey } from './keys.js';

/**
 * Drizzle-backed project key store (`api_keys` table). Raw keys never touch
 * the database — only `{ prefix, sha256 hash }`, same contract as memory.
 * Selected with `CONTROL_STORE=drizzle` (migrations + seed applied at
 * deploy); `MemoryKeyStore` stays the dev/test default.
 */

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToKey(row: typeof apiKeys.$inferSelect): ProjectApiKey {
  const role =
    row.role === 'public' || row.role === 'service' || row.role === 'admin' ? row.role : 'public';
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId ?? '',
    name: row.name,
    prefix: row.keyPrefix,
    hash: row.keyHash,
    role,
    scopes: [...row.scopes],
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    requestCount: row.requestCount,
    lastUsedAt: iso(row.lastUsedAt),
    createdBy: row.createdBy ?? '',
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
  };
}

export class DrizzleKeyStore implements KeyStore {
  constructor(private readonly db: Database) {}

  async save(key: ProjectApiKey): Promise<ProjectApiKey> {
    const rows = await this.db
      .insert(apiKeys)
      .values({
        projectId: key.projectId,
        organizationId: key.organizationId || null,
        name: key.name,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        role: key.role,
        scopes: key.scopes,
        expiresAt: key.expiresAt ? new Date(key.expiresAt) : null,
        revokedAt: key.revokedAt ? new Date(key.revokedAt) : null,
        createdBy: key.createdBy || null,
      })
      .returning();
    const saved = rows[0];
    if (!saved) throw new Error('Key insert failed');
    return { ...rowToKey(saved), role: key.role, scopes: key.scopes };
  }

  async findByHash(hash: string): Promise<ProjectApiKey | null> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    return row ? rowToKey(row) : null;
  }

  async listByProject(projectId: string): Promise<ExposedKey[]> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.projectId, projectId));
    return rows.map(r => exposeKey(rowToKey(r)));
  }

  async revoke(id: string): Promise<ExposedKey | null> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning();
    const row = rows[0];
    return row ? exposeKey(rowToKey(row)) : null;
  }

  async touch(id: string): Promise<void> {
    const rows = await this.db
      .select({ requestCount: apiKeys.requestCount })
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    const current = rows[0]?.requestCount ?? 0;
    await this.db
      .update(apiKeys)
      .set({ requestCount: current + 1, lastUsedAt: new Date() })
      .where(eq(apiKeys.id, id));
  }
}
