import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseStatus } from '@cloudnivo/database';
import { TenantAccessError, assertSameTenant } from '@cloudnivo/database';
import { ApiError } from '@cloudnivo/api-core';
import { credentialKeyFromSecret, decryptCredential, encryptCredential } from './credential-crypto.js';

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
  createOrganization(userId: string, name: string, slug: string): Promise<ProjectOrg>;
  listOrganizations(userId: string): Promise<OrganizationRecord[]>;
  /** Public-by-slug lookup (SSO discovery pre-login). Returns null when unknown. */
  getOrganizationBySlug(slug: string): Promise<OrganizationRecord | null>;
  membershipsFor(userId: string): Promise<MembershipRecord[]>;
  /** All memberships of one organization (member counts, billing visibility). */
  listOrganizationMembers(organizationId: string): Promise<MembershipRecord[]>;
  /** Grant a membership (invites, fixtures). Duplicate memberships are ignored. */
  addMembership(organizationId: string, userId: string, role: string): Promise<void>;
  createProject(input: {
    userId: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }): Promise<ProjectRecord>;
  listProjects(userId: string): Promise<ProjectRecord[]>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  deleteProject(projectId: string): Promise<void>;
  countDatabases(): Promise<number>;
  saveDatabase(rec: Omit<ProjectDbRecord, 'createdAt' | 'updatedAt'>): Promise<ProjectDbRecord>;
  getDatabaseByProject(projectId: string): Promise<ProjectDbRecord | null>;
  /** Batch database+credential read for list views (avoids N+1 on durable stores). */
  listProjectDatabases(projectIds: string[]): Promise<
    {
      projectId: string;
      db: ProjectDbRecord | null;
      cred: { dbUser: string; password: string } | null;
    }[]
  >;
  updateDatabaseStatus(projectId: string, status: DatabaseStatus): Promise<ProjectDbRecord | null>;
  saveCredential(projectId: string, dbUser: string, password: string): Promise<void>;
  getCredential(projectId: string): Promise<{ dbUser: string; password: string } | null>;
  deleteCredential(projectId: string): Promise<void>;
  recordAudit(
    event: string,
    fields: { projectId?: string; organizationId?: string; userId?: string },
  ): Promise<void>;
  listAudit(): Promise<AuditRecord[]>;
  /** Delete audit rows older than the ISO cutoff (optionally one org). Returns rows removed. */
  pruneAuditLogs(olderThanIso: string, organizationId?: string): Promise<number>;
  /** All organization ids (retention + maintenance enumeration). */
  listOrganizationIds(): Promise<string[]>;
  getAuthConfig(projectId: string): Promise<ProjectAuthConfig | null>;
  setAuthConfig(projectId: string, allowedOrigins: string[]): Promise<ProjectAuthConfig>;
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
  private audit: AuditRecord[] = [];
  private readonly authConfigs = new Map<string, ProjectAuthConfig>();
  private auditCounter = 0;
  private credentialKey: Buffer | null = null;

  /** Set at-rest encryption key (derived from VAULT_KEY). Null = legacy plaintext (dev). */
  setCredentialKeyFromSecret(secret: string | undefined): void {
    this.credentialKey = secret ? credentialKeyFromSecret(secret) : null;
  }

  /**
   * Cross-tenant snapshots for the operator console (apps/api/src/admin.ts).
   *
   * Deliberately NOT on the `Registry` interface: every other caller in the
   * API is tenant-scoped, and widening the shared contract with "give me
   * everyone's rows" would put that power one autocomplete away in routes
   * that must never have it. The durable path uses SQL in DrizzleAdminStore
   * instead, so these exist only for the memory store that dev and tests run
   * on. Reads are copies; callers cannot mutate the store through them.
   */
  adminOrganizations(): OrganizationRecord[] {
    return [...this.orgs.values()];
  }

  adminMemberships(): MembershipRecord[] {
    return [...this.memberships];
  }

  adminProjects(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  adminDatabases(): ProjectDbRecord[] {
    return [...this.databases.values()];
  }

  async createOrganization(userId: string, name: string, slug: string): Promise<ProjectOrg> {
    if (!slugOk(slug)) throw new ApiError('VALIDATION_ERROR', 'Invalid organization slug', 400);
    for (const o of this.orgs.values()) {
      if (o.slug === slug) throw new ApiError('CONFLICT', 'Organization slug taken', 409);
    }
    const org: OrganizationRecord = { id: randomUUID(), name, slug, createdBy: userId };
    this.orgs.set(org.id, org);
    this.memberships.push({ organizationId: org.id, userId, role: 'owner' });
    return { org };
  }

  async listOrganizations(userId: string): Promise<OrganizationRecord[]> {
    const allowed = new Set(
      this.memberships.filter(m => m.userId === userId).map(m => m.organizationId),
    );
    return [...this.orgs.values()].filter(o => allowed.has(o.id));
  }

  async getOrganizationBySlug(slug: string): Promise<OrganizationRecord | null> {
    for (const o of this.orgs.values()) {
      if (o.slug === slug) return o;
    }
    return null;
  }

  async membershipsFor(userId: string): Promise<MembershipRecord[]> {
    return this.memberships.filter(m => m.userId === userId);
  }

  async listOrganizationMembers(organizationId: string): Promise<MembershipRecord[]> {
    return this.memberships.filter(m => m.organizationId === organizationId);
  }

  async addMembership(organizationId: string, userId: string, role: string): Promise<void> {
    if (!this.memberships.some(m => m.organizationId === organizationId && m.userId === userId)) {
      this.memberships.push({ organizationId, userId, role });
    }
  }

  /** Seed helper for tests/dev fixtures (bypasses HTTP). */
  seedMembership(organizationId: string, userId: string, role: string): void {
    this.memberships.push({ organizationId, userId, role });
  }

  async createProject(input: {
    userId: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }): Promise<ProjectRecord> {
    assertSameTenant(
      this.memberships.filter(m => m.userId === input.userId),
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

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const allowed = new Set(
      this.memberships.filter(m => m.userId === userId).map(m => m.organizationId),
    );
    return [...this.projects.values()].filter(p => allowed.has(p.organizationId));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
    this.databases.delete(projectId);
    this.credentials.delete(projectId);
  }

  async countDatabases(): Promise<number> {
    return this.databases.size;
  }

  async saveDatabase(
    rec: Omit<ProjectDbRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ProjectDbRecord> {
    const now = new Date().toISOString();
    const full: ProjectDbRecord = { ...rec, createdAt: now, updatedAt: now };
    this.databases.set(rec.projectId, full);
    return full;
  }

  async getDatabaseByProject(projectId: string): Promise<ProjectDbRecord | null> {
    return this.databases.get(projectId) ?? null;
  }

  async listProjectDatabases(projectIds: string[]): Promise<
    {
      projectId: string;
      db: ProjectDbRecord | null;
      cred: { dbUser: string; password: string } | null;
    }[]
  > {
    return projectIds.map(projectId => ({
      projectId,
      db: this.databases.get(projectId) ?? null,
      cred: this.credentials.get(projectId) ?? null,
    }));
  }

  async updateDatabaseStatus(
    projectId: string,
    status: DatabaseStatus,
  ): Promise<ProjectDbRecord | null> {
    const rec = this.databases.get(projectId);
    if (!rec) return null;
    const next = { ...rec, status, updatedAt: new Date().toISOString() };
    this.databases.set(projectId, next);
    return next;
  }

  async saveCredential(projectId: string, dbUser: string, password: string): Promise<void> {
    this.credentials.set(projectId, { dbUser, password: encryptCredential(password, this.credentialKey) });
  }

  async getCredential(projectId: string): Promise<{ dbUser: string; password: string } | null> {
    const rec = this.credentials.get(projectId) ?? null;
    if (!rec) return null;
    return { dbUser: rec.dbUser, password: decryptCredential(rec.password, this.credentialKey) };
  }

  async deleteCredential(projectId: string): Promise<void> {
    this.credentials.delete(projectId);
  }

  async recordAudit(
    event: string,
    fields: { projectId?: string; organizationId?: string; userId?: string },
  ): Promise<void> {
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

  async listAudit(): Promise<AuditRecord[]> {
    return [...this.audit];
  }

  async pruneAuditLogs(olderThanIso: string, organizationId?: string): Promise<number> {
    const before = this.audit.length;
    this.audit = this.audit.filter(
      a => a.at >= olderThanIso || (organizationId !== undefined && a.organizationId !== organizationId),
    );
    return before - this.audit.length;
  }

  async listOrganizationIds(): Promise<string[]> {
    return [...this.orgs.keys()];
  }

  async getAuthConfig(projectId: string): Promise<ProjectAuthConfig | null> {
    return this.authConfigs.get(projectId) ?? null;
  }

  async setAuthConfig(projectId: string, allowedOrigins: string[]): Promise<ProjectAuthConfig> {
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
export async function mustOwnProject(
  registry: Registry,
  userId: string,
  projectId: string,
): Promise<ProjectRecord> {
  const project = await registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  const memberships = await registry.membershipsFor(userId);
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
