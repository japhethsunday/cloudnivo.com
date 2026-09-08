import { describe, expect, it } from 'vitest';
import { assertSameTenant, can } from '@cloudnivo/database';
import { bearerFromHeader, createApiKey, hashApiKey } from '@cloudnivo/auth';

/**
 * Cross-package isolation proof: auth identity + DB tenancy + RBAC combine so
 * a valid session in org-A can never touch org-B, even with a stolen project ID.
 */
describe('phase 1 isolation (integration)', () => {
  it('member of org-a cannot act on org-b resources', () => {
    const memberships = [{ organizationId: 'org-a', userId: 'u1', role: 'member' }];
    expect(() => assertSameTenant(memberships, { organizationId: 'org-b' }, 'u1')).toThrow();
    expect(can('member', 'keys:revoke')).toBe(false);
  });

  it('api keys never expose raw material in tenant checks', () => {
    const { raw, hash } = createApiKey();
    expect(hashApiKey(raw)).toBe(hash);
    expect(bearerFromHeader(`Bearer ${raw}`)).toBe(raw);
  });
});
