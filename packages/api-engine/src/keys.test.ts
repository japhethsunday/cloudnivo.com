import { describe, expect, it } from 'vitest';
import { MemoryKeyStore, exposeKey, issueKey, keyCanWrite, verifyKey } from './keys.js';
import { buildOpenApiDoc, curlExample } from './openapi.js';
import type { SchemaInfo } from '@cloudnivo/database';

describe('project api keys', () => {
  it('issues once-visible raw secrets, stores hashes only', async () => {
    const store = new MemoryKeyStore();
    const { key, raw } = await issueKey(store, {
      projectId: 'p1',
      organizationId: 'o1',
      name: 'web',
      role: 'public',
      createdBy: 'u1',
    });
    expect(raw.startsWith('cn_')).toBe(true);
    expect(key.prefix).toBe(raw.slice(0, 12));
    const listed = await store.listByProject('p1');
    expect(listed).toHaveLength(1);
    expect('hash' in (listed[0] as Record<string, unknown>)).toBe(false);
    const verified = await verifyKey(store, raw);
    expect(verified.projectId).toBe('p1');
    expect('hash' in exposeKey(verified)).toBe(false);
  });

  it('rejects unknown, revoked, and expired keys', async () => {
    const store = new MemoryKeyStore();
    await expect(verifyKey(store, 'cn_bogus')).rejects.toMatchObject({ code: 'INVALID_KEY' });
    const { raw } = await issueKey(store, {
      projectId: 'p1',
      organizationId: 'o1',
      name: 'srv',
      role: 'service',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: 'u1',
    });
    const live = await verifyKey(store, raw);
    await store.revoke(live.id);
    await expect(verifyKey(store, raw)).rejects.toMatchObject({ code: 'KEY_REVOKED' });
    await expect(
      issueKey(store, {
        projectId: 'p1',
        organizationId: 'o1',
        name: 'old',
        role: 'public',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        createdBy: 'u1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EXPIRY' });
  });

  it('enforces read/write separation by role', () => {
    expect(keyCanWrite('public')).toBe(false);
    expect(keyCanWrite('service')).toBe(true);
    expect(keyCanWrite('admin')).toBe(true);
  });
});

describe('openapi generation', () => {
  const schema: SchemaInfo = {
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
          { name: 'email', dataType: 'character varying', nullable: false, defaultValue: null },
        ],
        primaryKeys: ['id'],
        indexes: [],
      },
    ],
    foreignKeys: [],
  };

  it('derives paths from live tables', () => {
    const doc = buildOpenApiDoc({ baseUrl: 'http://x', projectId: 'p1', schema, maxRows: 500 });
    expect(doc['openapi']).toBe('3.0.3');
    const paths = doc['paths'] as Record<string, unknown>;
    expect(paths['/users']).toBeTruthy();
    expect(paths['/users/{id}']).toBeTruthy();
  });

  it('renders copyable curl examples without secrets', () => {
    const ex = curlExample('http://x', 'p1', 'users', 'GET');
    expect(ex).toContain('/api/v1/projects/p1/users?limit=20');
    expect(ex).toContain('YOUR_API_KEY');
    expect(ex).not.toContain('cn_');
  });
});
