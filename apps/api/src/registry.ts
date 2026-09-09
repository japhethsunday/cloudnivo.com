import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseStatus } from '@cloudnivo/database';
import { TenantAccessError, assertSameTenant } from '@cloudnivo/database';
import { ApiError } from '@cloudnivo/api-core';

/**
 * Control-plane metadata store.
 *
 * Holds organizations, memberships, projects, provisioned-database records,
 * credentials, and audit events. `MemoryRegistry` backs local dev and tests;
 * the Drizzle tables in `@cloudnivo/database` (`projectDatabases`,
 * `databaseCredentials`, `infrastructureInstances`, `provisioningJobs`) are
 * the durable adapter target — same record shapes, swapped without touching
 * routes (see docs/database.md).
 */

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
}

export interface MembershipRecord {
  organizationId: string;
  userId: string;
  role: string;
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  region: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface ProjectDbRecord {
  projectId: string;
  organizationId: string;
  databaseId: string;
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
  version: string;
  region: string;
  status: DatabaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  id: string;
  event: string;
  projectId: string | null;
  organizationId: string | null;
  userId: string | null;
  at: string;
}

export interface ProjectAuthConfig {
  projectId: string;
  /** Project-level browser allowlist. Empty = inherit global CORS_ORIGINS. */
  allowedOrigins: string[];
  updatedAt: string;
}

export interface Registry {
  createOrganization(userId: string, name: string, slug: string): ProjectOrg;
  listOrganizations(userId: string): OrganizationRecord[];
  membershipsFor(userId: string): MembershipRecord[];
  createProject(input: {
    userId: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }): ProjectRecord;
  listProjects(userId: string): ProjectRecord[];
  getProject(projectId: string): ProjectRecord | null;
  deleteProject(projectId: string): void;
  countDatabases(): number;
  saveDatabase(rec: Omit<ProjectDbRecord, 'createdAt' | 'updatedAt'>): ProjectDbRecord;
  getDatabaseByProject(projectId: string): ProjectDbRecord | null;
  updateDatabaseStatus(projectId: string, status: DatabaseStatus): ProjectDbRecord | null;
  saveCredential(projectId: string, dbUser: string, password: string): void;
  getCredential(projectId: string): { dbUser: string; password: string } | null;
  deleteCredential(projectId: string): void;
  recordAudit(
    event: string,
    fields: { projectId?: string; organizationId?: string; userId?: string },
  ): void;
  listAudit(): AuditRecord[];
  getAuthConfig(projectId: string): ProjectAuthConfig | null;
  setAuthConfig(projectId: string, allowedOrigins: string[]): ProjectAuthConfig;
}

export interface ProjectOrg {
  org: OrganizationRecord;
}

function slugOk(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug);
}

export class MemoryRegistry implements Registry {
  private readonly orgs = new Map<string, OrganizationRecord>();
  private readonly memberships: MembershipRecord[] = [];
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly databases = new Map<string, ProjectDbRecord>();
  private readonly credentials = new Map<string, { dbUser: string; password: string }>();
  private readonly audit: AuditRecord[] = [];
  private readonly authConfigs = new Map<string, ProjectAuthConfig>();
  private auditCounter = 0;

  createOrganization(userId: string, name: string, slug: string): ProjectOrg {
    if (!slugOk(slug)) throw new ApiError('VALIDATION_ERROR', 'Invalid organization slug', 400);
    for (const o of this.orgs.values()) {
      if (o.slug === slug) throw new ApiError('CONFLICT', 'Organization slug taken', 409);
    }
    const org: OrganizationRecord = { id: randomUUID(), name, slug, createdBy: userId };
    this.orgs.set(org.id, org);
    this.memberships.push({ organizationId: org.id, userId, role: 'owner' });
    return { org };
  }

  listOrganizations(userId: string): OrganizationRecord[] {
    const allowed = new Set(
      this.memberships.filter(m => m.userId === userId).map(m => m.organizationId),
    );
    return [...this.orgs.values()].filter(o => allowed.has(o.id));
  }

  membershipsFor(userId: string): MembershipRecord[] {
    return this.memberships.filter(m => m.userId === userId);
  }

  /** Seed helper for tests/dev fixtures (bypasses HTTP). */
  seedMembership(organizationId: string, userId: string, role: string): void {
    this.memberships.push({ organizationId, userId, role });
  }

  createProject(input: {
    userId: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }): ProjectRecord {
    assertSameTenant(
      this.membershipsFor(input.userId),
      { organizationId: input.organizationId },
      input.userId,
    );
    if (!slugOk(input.slug)) throw new ApiError('VALIDATION_ERROR', 'Invalid project slug', 400);
    for (const p of this.projects.values()) {
      if (p.organizationId === input.organizationId && p.slug === input.slug) {
        throw new ApiError('CONFLICT', 'Project slug taken in this organization', 409);
      }
    }
    const project: ProjectRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      region: input.region,
      status: 'active',
      createdBy: input.userId,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  listProjects(userId: string): ProjectRecord[] {
    const allowed = new Set(this.membershipsFor(userId).map(m => m.organizationId));
    return [...this.projects.values()].filter(p => allowed.has(p.organizationId));
  }

  getProject(projectId: string): ProjectRecord | null {
    return this.projects.get(projectId) ?? null;
  }

  deleteProject(projectId: string): void {
    this.projects.delete(projectId);
    this.databases.delete(projectId);
    this.credentials.delete(projectId);
  }

  countDatabases(): number {
    return this.databases.size;
  }

  saveDatabase(rec: Omit<ProjectDbRecord, 'createdAt' | 'updatedAt'>): ProjectDbRecord {
    const now = new Date().toISOString();
    const full: ProjectDbRecord = { ...rec, createdAt: now, updatedAt: now };
    this.databases.set(rec.projectId, full);
    return full;
  }

  getDatabaseByProject(projectId: string): ProjectDbRecord | null {
    return this.databases.get(projectId) ?? null;
  }

  updateDatabaseStatus(projectId: string, status: DatabaseStatus): ProjectDbRecord | null {
    const rec = this.databases.get(projectId);
    if (!rec) return null;
    const next = { ...rec, status, updatedAt: new Date().toISOString() };
    this.databases.set(projectId, next);
    return next;
  }

  saveCredential(projectId: string, dbUser: string, password: string): void {
    this.credentials.set(projectId, { dbUser, password });
  }

  getCredential(projectId: string): { dbUser: string; password: string } | null {
    return this.credentials.get(projectId) ?? null;
  }

  deleteCredential(projectId: string): void {
    this.credentials.delete(projectId);
  }

  recordAudit(
    event: string,
    fields: { projectId?: string; organizationId?: string; userId?: string },
  ): void {
    this.auditCounter += 1;
    this.audit.push({
      id: `audit_${this.auditCounter}`,
      event,
      projectId: fields.projectId ?? null,
      organizationId: fields.organizationId ?? null,
      userId: fields.userId ?? null,
      at: new Date().toISOString(),
    });
  }

  listAudit(): AuditRecord[] {
    return [...this.audit];
  }

  getAuthConfig(projectId: string): ProjectAuthConfig | null {
    return this.authConfigs.get(projectId) ?? null;
  }

  setAuthConfig(projectId: string, allowedOrigins: string[]): ProjectAuthConfig {
    for (const o of allowedOrigins) {
      if (o !== 'null' && !/^https?:\/\/[^/]+$/.test(o)) {
        throw new ApiError('VALIDATION_ERROR', `Invalid origin: ${o.slice(0, 80)}`, 400);
      }
    }
    const cfg: ProjectAuthConfig = {
      projectId,
      allowedOrigins: [...new Set(allowedOrigins)].slice(0, 20),
      updatedAt: new Date().toISOString(),
    };
    this.authConfigs.set(projectId, cfg);
    return cfg;
  }
}

/** Server-side password generation (24 random bytes, URL-safe). */
export function generateDbPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Resolve a project or throw 404; then enforce caller's membership (403). */
export function mustOwnProject(
  registry: Registry,
  userId: string,
  projectId: string,
): ProjectRecord {
  const project = registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const memberships = registry.membershipsFor(userId);
  // Never trust client org claims — resolve org from the stored project row.
  assertSameTenant(memberships, { organizationId: project.organizationId }, userId);
  return project;
}

export function toTenantError(err: unknown): ApiError | null {
  if (err instanceof TenantAccessError) {
    return new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
  }
  return null;
}
