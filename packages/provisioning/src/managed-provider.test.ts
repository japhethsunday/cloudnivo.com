import { describe, expect, it } from 'vitest';
import { ManagedPostgresProvider } from './managed-provider.js';
import { ProviderUnavailableError, ProvisionerError } from './provisioner.js';

const UNREACHABLE = 'postgres://u:p@127.0.0.1:1/db';

describe('managed postgres provider (no live server)', () => {
  it('rejects bad configuration without touching the network', () => {
    expect(() => new ManagedPostgresProvider({ connectionString: '' })).toThrow(
      'MANAGED_PG_URL is required',
    );
    expect(() => new ManagedPostgresProvider({ connectionString: 'not-a-url' })).toThrow(
      'not a valid URL',
    );
    expect(() => new ManagedPostgresProvider({ connectionString: 'mysql://u:p@h/db' })).toThrow(
      'postgres:// URL',
    );
  });

  it('reports unreachable servers as recoverable (safe to retry)', async () => {
    const provider = new ManagedPostgresProvider({ connectionString: UNREACHABLE });
    expect(await provider.isAvailable()).toBe(false);
    await expect(
      provider.createDatabase({
        projectId: 'p1',
        organizationId: 'o1',
        slug: 'shop',
        password: 'long-enough-password-1',
        version: '16',
        region: 'local',
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('validates inputs before connecting', async () => {
    const provider = new ManagedPostgresProvider({ connectionString: UNREACHABLE });
    await expect(
      provider.createDatabase({
        projectId: 'p1',
        organizationId: 'o1',
        slug: 'BAD SLUG',
        password: 'long-enough-password-1',
        version: '16',
        region: 'local',
      }),
    ).rejects.toThrow();
    await expect(provider.deleteDatabase('not a handle!!')).rejects.toBeInstanceOf(
      ProvisionerError,
    );
    await expect(
      provider.getStatus('managed:db:u', {
        host: 'h',
        port: 1,
        database: 'd',
        user: 'u',
        password: 'p',
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('never leaks passwords in errors', async () => {
    const provider = new ManagedPostgresProvider({ connectionString: UNREACHABLE });
    const err = await provider
      .createDatabase({
        projectId: 'p1',
        organizationId: 'o1',
        slug: 'shop',
        password: 'super-secret-password-1',
        version: '16',
        region: 'local',
      })
      .catch(e => e as Error);
    expect(String(err?.message ?? '')).not.toContain('super-secret-password-1');
  });
});
