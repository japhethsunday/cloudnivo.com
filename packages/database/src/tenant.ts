/**
 * Tenant-isolation helpers — pure functions so they are unit-testable without a DB.
 *
 * GOLDEN RULE: never trust client-supplied organizationId / projectId / role.
 * Every check takes the server-verified membership list (from the DB session)
 * and the server-resolved resource, then decides. Callers MUST load memberships
 * via `DatabaseService` first.
 */

export interface Membership {
  organizationId: string;
  userId: string;
  role: string;
}

export interface OrgScopedResource {
  organizationId: string;
}

export class TenantAccessError extends Error {
  readonly code = 'TENANT_FORBIDDEN';
  constructor(message = 'Access denied for this organization') {
    super(message);
    this.name = 'TenantAccessError';
  }
}

/** Does the user belong to the organization at all? */
export function isMemberOf(memberships: Membership[], organizationId: string): boolean {
  return memberships.some(m => m.organizationId === organizationId);
}

/**
 * Assert the caller may access a resource belonging to `resource.organizationId`.
 * Throws {@link TenantAccessError} otherwise. Use for every org-scoped read/write.
 */
export function assertSameTenant(
  memberships: Membership[],
  resource: OrgScopedResource,
  userId: string,
): void {
  const ok = memberships.some(
    m => m.userId === userId && m.organizationId === resource.organizationId,
  );
  if (!ok) throw new TenantAccessError();
}

/**
 * Filter a project list to only the organizations the user belongs to.
 * Pure + safe to use for list endpoints before pagination.
 */
export function scopeProjectsToMemberOrgs<T extends OrgScopedResource & { id: string }>(
  projects: T[],
  memberships: Membership[],
  userId: string,
): T[] {
  const allowed = new Set(memberships.filter(m => m.userId === userId).map(m => m.organizationId));
  return projects.filter(p => allowed.has(p.organizationId));
}

/** Resolve an organization ID from a project row — never accept it from the client. */
export function resolveOrgIdFromProject<T extends OrgScopedResource>(project: T): string {
  return project.organizationId;
}
