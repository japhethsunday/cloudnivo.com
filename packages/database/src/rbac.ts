/**
 * RBAC foundation. Roles form a strict hierarchy; permissions are additive.
 * Keep the catalog in sync with the `roles`/`permissions` seed (see database.md).
 */

export const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
export type RoleKey = (typeof ROLE_HIERARCHY)[number];

export const PERMISSIONS = [
  'orgs:read',
  'orgs:update',
  'orgs:members:read',
  'orgs:members:manage',
  'projects:read',
  'projects:create',
  'projects:update',
  'projects:delete',
  'envs:read',
  'envs:manage',
  'keys:read',
  'keys:create',
  'keys:revoke',
  'logs:read',
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  viewer: ['orgs:read', 'projects:read', 'envs:read', 'logs:read'],
  member: [
    'orgs:read',
    'projects:read',
    'projects:create',
    'projects:update',
    'envs:read',
    'envs:manage',
    'keys:read',
    'logs:read',
  ],
  admin: [
    'orgs:read',
    'orgs:update',
    'orgs:members:read',
    'orgs:members:manage',
    'projects:read',
    'projects:create',
    'projects:update',
    'projects:delete',
    'envs:read',
    'envs:manage',
    'keys:read',
    'keys:create',
    'keys:revoke',
    'logs:read',
  ],
  owner: [
    'orgs:read',
    'orgs:update',
    'orgs:members:read',
    'orgs:members:manage',
    'projects:read',
    'projects:create',
    'projects:update',
    'projects:delete',
    'envs:read',
    'envs:manage',
    'keys:read',
    'keys:create',
    'keys:revoke',
    'logs:read',
  ],
};

export function roleRank(role: string): number {
  return ROLE_HIERARCHY.indexOf(role as RoleKey);
}

/** True when `actorRole` is at least as privileged as `requiredRole`. */
export function hasRoleAtLeast(actorRole: string, requiredRole: RoleKey): boolean {
  const a = roleRank(actorRole);
  const r = roleRank(requiredRole);
  if (a === -1 || r === -1) return false;
  return a >= r;
}

/** True when the role grants the permission. Unknown roles grant nothing. */
export function can(role: string, permission: PermissionKey): boolean {
  const perms = (ROLE_PERMISSIONS as Record<string, readonly string[]>)[role];
  if (!perms) return false;
  return perms.includes(permission);
}

export function permissionsFor(role: RoleKey): readonly PermissionKey[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
