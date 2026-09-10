import { count, desc, eq } from 'drizzle-orm';
import {
  auditLogs,
  databaseCredentials,
  organizationMemberships,
  organizations,
  projectAuthConfigs,
  projectDatabases,
  projects,
  type Database,
  type DatabaseStatus,
} from '@cloudnivo/database';
import { assertSameTenant } from '@cloudnivo/database';
import { ApiError } from '@cloudnivo/api-core';
import type {
  AuditRecord,
  MembershipRecord,
  OrganizationRecord,
  ProjectAuthConfig,
  ProjectDbRecord,
  ProjectOrg,
  ProjectRecord,
  Registry,
} from './registry.js';

/**
 * Drizzle-backed control-plane metadata store. Same `Registry` contract as
 * memory — routes never know which adapter serves them. Selected with
 * `CONTROL_STORE=drizzle` (migrations + seed applied at deploy); the memory
 * adapter stays the dev/test default.
 *
 * failure mapping: unique violations (23505) become the same 409 CONFLICTs
 * memory throws, so callers and tests behave identically on both adapters.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slugOk(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug);
}

function isConflict(err: unknown): boolean {
  return String((err as { code?: unknown }).code) === '23505';
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Non-uuid ids can never match a uuid PK — return null (404) instead of a driver error. */
function uuidOrNull(id: string): string | null {
  return UUID_RE.test(id) ? id : null;
}

/** Membership roles outside the catalog degrade to member (memory parity for reads). */
function asOrgRole(role: string): 'owner' | 'admin' | 'member' | 'viewer' {
  return role === 'owner' || role === 'admin' || role === 'member' || role === 'viewer'
    ? role
    : 'member';
}

function toOrg(row: typeof organizations.$inferSelect, createdBy: string): OrganizationRecord {
  return { id: row.id, name: row.name, slug: row.slug, createdBy };
}

function toProject(row: typeof projects.$inferSelect, createdBy: string): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    region: row.region,
    status: row.status,
    createdBy,
    createdAt: iso(row.createdAt),
  };
}

function toDbRecord(row: typeof projectDatabases.$inferSelect): ProjectDbRecord {
  return {
    projectId: row.projectId,
    organizationId: row.organizationId,
    databaseId: row.databaseId,
    host: row.host,
    port: row.port,
    dbName: row.dbName,
    dbUser: row.dbUser,
    version: row.version,
    region: row.region,
    status: row.status as DatabaseStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleRegistry implements Registry {
  constructor(private readonly db: Database) {}

  async createOrganization(userId: string, name: string, slug: string): Promise<ProjectOrg> {
    if (!slugOk(slug)) throw new ApiError('VALIDATION_ERROR', 'Invalid organization slug', 400);
    try {
      const org = await this.db.transaction(async tx => {
        const inserted = await tx
          .insert(organizations)
          .values({ name, slug, createdBy: uuidOrNull(userId) })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error('Organization insert failed');
        if (uuidOrNull(userId)) {
          await tx.insert(organizationMemberships).values({
            organizationId: row.id,
            userId: userId,
            role: 'owner',
          });
        }
        return row;
      });
      return { org: toOrg(org, userId) };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isConflict(err)) throw new ApiError('CONFLICT', 'Organization slug taken', 409);
      throw err;
    }
  }

  async listOrganizations(userId: string): Promise<OrganizationRecord[]> {
    const uid = uuidOrNull(userId);
    if (!uid) return [];
    const memberships = await this.db
      .select({ organizationId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, uid));
    const ids = new Set(memberships.map(m => m.organizationId));
    if (ids.size === 0) return [];
    const rows = await this.db.select().from(organizations);
    return rows.filter(o => ids.has(o.id)).map(o => toOrg(o, o.createdBy ?? ''));
  }

  async membershipsFor(userId: string): Promise<MembershipRecord[]> {
    const uid = uuidOrNull(userId);
    if (!uid) return [];
    const rows = await this.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, uid));
    return rows.map(r => ({ organizationId: r.organizationId, userId: r.userId, role: r.role }));
  }

  async addMembership(organizationId: string, userId: string, role: string): Promise<void> {
    if (!uuidOrNull(organizationId) || !uuidOrNull(userId)) return;
    await this.db
      .insert(organizationMemberships)
      .values({ organizationId, userId, role: asOrgRole(role) })
      .onConflictDoNothing();
  }

  async createProject(input: {
    userId: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }): Promise<ProjectRecord> {
    const memberships = await this.membershipsFor(input.userId);
    assertSameTenant(memberships, { organizationId: input.organizationId }, input.userId);
    if (!slugOk(input.slug)) throw new ApiError('VALIDATION_ERROR', 'Invalid project slug', 400);
    if (!uuidOrNull(input.organizationId))
      throw new ApiError('NOT_FOUND', 'Organization not found', 404);
    try {
      const rows = await this.db
        .insert(projects)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          slug: input.slug,
          region: input.region,
          status: 'active',
          createdBy: uuidOrNull(input.userId),
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Project insert failed');
      return toProject(row, input.userId);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isConflict(err))
        throw new ApiError('CONFLICT', 'Project slug taken in this organization', 409);
      throw err;
    }
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const memberships = await this.membershipsFor(userId);
    const allowed = new Set(memberships.map(m => m.organizationId));
    if (allowed.size === 0) return [];
    const rows = await this.db.select().from(projects);
    return rows
      .filter(p => allowed.has(p.organizationId))
      .map(p => toProject(p, p.createdBy ?? ''));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const pid = uuidOrNull(projectId);
    if (!pid) return null;
    const rows = await this.db.select().from(projects).where(eq(projects.id, pid)).limit(1);
    const row = rows[0];
    return row ? toProject(row, row.createdBy ?? '') : null;
  }

  async deleteProject(projectId: string): Promise<void> {
    const pid = uuidOrNull(projectId);
    if (!pid) return;
    // FK cascades clear databases, credentials, keys, jobs, storage,
    // functions, versions, env, and auth configs; audit rows detach.
    await this.db.delete(projects).where(eq(projects.id, pid));
  }

  async countDatabases(): Promise<number> {
    const rows = await this.db.select({ n: count() }).from(projectDatabases);
    return rows[0]?.n ?? 0;
  }

  async saveDatabase(
    rec: Omit<ProjectDbRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ProjectDbRecord> {
    const pid = uuidOrNull(rec.projectId);
    if (!pid) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const values = {
      projectId: rec.projectId,
      organizationId: rec.organizationId,
      databaseId: rec.databaseId,
      engine: 'postgres',
      version: rec.version,
      host: rec.host,
      port: rec.port,
      dbName: rec.dbName,
      dbUser: rec.dbUser,
      status: rec.status,
      region: rec.region,
    };
    const rows = await this.db
      .insert(projectDatabases)
      .values(values)
      .onConflictDoUpdate({
        target: projectDatabases.projectId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Database record save failed');
    return toDbRecord(row);
  }

  async getDatabaseByProject(projectId: string): Promise<ProjectDbRecord | null> {
    const pid = uuidOrNull(projectId);
    if (!pid) return null;
    const rows = await this.db
      .select()
      .from(projectDatabases)
      .where(eq(projectDatabases.projectId, pid))
      .limit(1);
    const row = rows[0];
    return row ? toDbRecord(row) : null;
  }

  async updateDatabaseStatus(
    projectId: string,
    status: DatabaseStatus,
  ): Promise<ProjectDbRecord | null> {
    const pid = uuidOrNull(projectId);
    if (!pid) return null;
    const rows = await this.db
      .update(projectDatabases)
      .set({ status, updatedAt: new Date() })
      .where(eq(projectDatabases.projectId, pid))
      .returning();
    const row = rows[0];
    return row ? toDbRecord(row) : null;
  }

  async saveCredential(projectId: string, dbUser: string, password: string): Promise<void> {
    const pid = uuidOrNull(projectId);
    if (!pid) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const dbRow = await this.getDatabaseByProject(pid);
    if (!dbRow) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
    const dbIdRows = await this.db
      .select({ id: projectDatabases.id })
      .from(projectDatabases)
      .where(eq(projectDatabases.projectId, pid))
      .limit(1);
    const dbId = dbIdRows[0]?.id;
    if (!dbId) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
    await this.db.transaction(async tx => {
      await tx.delete(databaseCredentials).where(eq(databaseCredentials.projectDatabaseId, dbId));
      await tx.insert(databaseCredentials).values({
        projectDatabaseId: dbId,
        projectId: pid,
        organizationId: dbRow.organizationId,
        dbUser,
        dbPassword: password,
      });
    });
  }

  async getCredential(projectId: string): Promise<{ dbUser: string; password: string } | null> {
    const pid = uuidOrNull(projectId);
    if (!pid) return null;
    const rows = await this.db
      .select()
      .from(databaseCredentials)
      .where(eq(databaseCredentials.projectId, pid))
      .limit(1);
    const row = rows[0];
    return row ? { dbUser: row.dbUser, password: row.dbPassword } : null;
  }

  async deleteCredential(projectId: string): Promise<void> {
    const pid = uuidOrNull(projectId);
    if (!pid) return;
    await this.db.delete(databaseCredentials).where(eq(databaseCredentials.projectId, pid));
  }

  async recordAudit(
    event: string,
    fields: { projectId?: string; organizationId?: string; userId?: string },
  ): Promise<void> {
    await this.db.insert(auditLogs).values({
      organizationId: uuidOrNull(fields.organizationId ?? ''),
      actorUserId: uuidOrNull(fields.userId ?? ''),
      action: event.slice(0, 100),
      entityType: fields.projectId ? 'project' : null,
      entityId: uuidOrNull(fields.projectId ?? ''),
      metadata: fields.projectId ? { projectId: fields.projectId } : {},
    });
  }

  async listAudit(): Promise<AuditRecord[]> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(1000);
    return rows.map(r => ({
      id: r.id,
      event: r.action,
      projectId:
        ((r.metadata as Record<string, unknown> | null)?.['projectId'] as string | null) ??
        r.entityId,
      organizationId: r.organizationId,
      userId: r.actorUserId,
      at: iso(r.createdAt),
    }));
  }

  async getAuthConfig(projectId: string): Promise<ProjectAuthConfig | null> {
    const pid = uuidOrNull(projectId);
    if (!pid) return null;
    const rows = await this.db
      .select()
      .from(projectAuthConfigs)
      .where(eq(projectAuthConfigs.projectId, pid))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          projectId: row.projectId,
          allowedOrigins: [...row.allowedOrigins],
          updatedAt: iso(row.updatedAt),
        }
      : null;
  }

  async setAuthConfig(projectId: string, allowedOrigins: string[]): Promise<ProjectAuthConfig> {
    for (const o of allowedOrigins) {
      if (o !== 'null' && !/^https?:\/\/[^/]+$/.test(o)) {
        throw new ApiError('VALIDATION_ERROR', `Invalid origin: ${o.slice(0, 80)}`, 400);
      }
    }
    const pid = uuidOrNull(projectId);
    if (!pid) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const project = await this.getProject(pid);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const origins = [...new Set(allowedOrigins)].slice(0, 20);
    const rows = await this.db
      .insert(projectAuthConfigs)
      .values({ projectId: pid, organizationId: project.organizationId, allowedOrigins: origins })
      .onConflictDoUpdate({
        target: projectAuthConfigs.projectId,
        set: { allowedOrigins: origins, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Auth config save failed');
    return {
      projectId: row.projectId,
      allowedOrigins: [...row.allowedOrigins],
      updatedAt: iso(row.updatedAt),
    };
  }
}
