import type { IncomingMessage, ServerResponse } from 'node:http';
import { count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ApiError, checkRateLimit, ok, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader } from '@cloudnivo/auth';
import {
  auditLogs,
  organizationMemberships,
  organizations,
  projectDatabases,
  projects,
  users,
  type Database,
} from '@cloudnivo/database';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';
import { verifyPlatformSession } from './sessions.js';
import { MemoryPlatformUsers, platformAuthFor } from './platform-auth.js';
import { MemoryRegistry } from './registry.js';
import { readJson } from './v1.js';
import { platformMailer } from './platform-mail.js';
import {
  EMAIL_TEMPLATES,
  MAX_RECIPIENTS,
  SEND_RATE_LIMIT,
  SEND_RATE_WINDOW_SECONDS,
  emailStoreFor,
  parseRecipients,
  renderOperatorEmail,
  type EmailStatus,
} from './admin-email.js';

/**
 * Platform operator console (`/api/v1/admin/*`).
 *
 * This is the ONE part of CloudNivo that reads across tenants. Everything
 * else in the API answers "what may this member of this organization see";
 * these routes answer "what is happening on the platform", which is a
 * different and far more dangerous question. Three rules hold that line:
 *
 * 1. Staff is a stored fact (`users.is_platform_admin`), re-read from the
 *    store on EVERY request. A session token minted before a demotion must
 *    not keep working, so the flag is never carried in the JWT.
 * 2. Non-staff callers get 404, not 403. A 403 would confirm the console
 *    exists and that the caller found a real route; 404 tells an attacker
 *    with a stolen developer token nothing at all.
 * 3. Reads, plus a SHORT closed list of operator actions: suspend/restore an
 *    account, and send an operator email. Nothing here writes to a tenant's
 *    data — no project, database, bucket or row is ever mutated from this
 *    module — so a mistake can over-share or disable an account, never
 *    corrupt a customer's data. Every action is audited with the actor.
 *
 * Secrets are never selected: no password hashes, no TOTP material, no
 * database credentials. The console shows shape and health, not contents.
 */

/** Hard ceiling on any list endpoint, whatever the caller asks for. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;
/** Months of history in the growth series. */
const GROWTH_MONTHS = 12;

export interface AdminTotals {
  users: number;
  organizations: number;
  projects: number;
  databases: number;
}

export interface AdminRecent {
  usersThisWeek: number;
  usersThisMonth: number;
  projectsThisWeek: number;
  projectsThisMonth: number;
}

export interface AdminGrowthPoint {
  /** `YYYY-MM`, oldest first. */
  month: string;
  users: number;
  projects: number;
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  members: number;
  projects: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
  suspendedAt: string | null;
}

/** One account, with the tenancy it belongs to. Never any secret material. */
export interface AdminUserDetail extends AdminUser {
  totpEnabled: boolean;
  organizations: { id: string; name: string; slug: string; role: string }[];
  projects: { id: string; name: string; organizationId: string }[];
}

export interface AdminOrgDetail extends AdminOrganization {
  createdAt: string;
  memberList: { userId: string; email: string | null; role: string }[];
  projectList: { id: string; name: string; slug: string; region: string }[];
}

export interface AdminProjectDetail extends AdminProject {
  slugPath: string;
  databaseHealth: string | null;
  ownerEmail: string | null;
}

export interface AdminProject {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  organizationName: string | null;
  region: string;
  databaseStatus: string | null;
  createdAt: string;
}

export interface AdminAuditRow {
  id: string;
  action: string;
  organizationId: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface AdminStore {
  totals(): Promise<AdminTotals>;
  recent(weekAgo: Date, monthAgo: Date): Promise<AdminRecent>;
  growth(since: Date): Promise<AdminGrowthPoint[]>;
  organizations(limit: number): Promise<AdminOrganization[]>;
  users(limit: number): Promise<AdminUser[]>;
  projects(limit: number): Promise<AdminProject[]>;
  audit(limit: number): Promise<AdminAuditRow[]>;
  /** Audit rows whose action matches one of `actions`, newest first. */
  auditByActions(actions: string[], limit: number): Promise<AdminAuditRow[]>;
  userDetail(id: string): Promise<AdminUserDetail | null>;
  organizationDetail(id: string): Promise<AdminOrgDetail | null>;
  projectDetail(id: string): Promise<AdminProjectDetail | null>;
  /** Everyone carrying the staff flag. Small by construction. */
  platformAdmins(): Promise<AdminUser[]>;
  /** Per-status database counts, e.g. `{ running: 12, creating: 1 }`. */
  databasesByStatus(): Promise<Record<string, number>>;
}

function monthKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The months the series must contain, oldest first. Built from the calendar
 * rather than from the rows, so a month with no signups renders as a zero
 * instead of vanishing and silently flattening the line.
 */
function monthsSince(since: Date, now: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= end) {
    out.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function emptyGrowth(since: Date, now: Date): Map<string, AdminGrowthPoint> {
  const map = new Map<string, AdminGrowthPoint>();
  for (const month of monthsSince(since, now)) map.set(month, { month, users: 0, projects: 0 });
  return map;
}

/** One shape for an admin user row, so both stores cannot drift apart. */
function toAdminUser(u: {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
  suspendedAt: string | null;
}): AdminUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    isPlatformAdmin: u.isPlatformAdmin,
    createdAt: u.createdAt,
    suspendedAt: u.suspendedAt,
  };
}

// ── Memory (dev, tests, e2e) ────────────────────────────────────────

export class MemoryAdminStore implements AdminStore {
  constructor(
    private readonly registry: MemoryRegistry,
    private readonly userStore: MemoryPlatformUsers,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async totals(): Promise<AdminTotals> {
    return {
      users: await this.userStore.countAll(),
      organizations: this.registry.adminOrganizations().length,
      projects: this.registry.adminProjects().length,
      databases: this.registry.adminDatabases().length,
    };
  }

  async recent(weekAgo: Date, monthAgo: Date): Promise<AdminRecent> {
    const allUsers = await this.userStore.listAll(Number.MAX_SAFE_INTEGER);
    const after = (iso: string, cut: Date): boolean => new Date(iso).getTime() >= cut.getTime();
    const projectRows = this.registry.adminProjects();
    return {
      usersThisWeek: allUsers.filter(u => after(u.createdAt, weekAgo)).length,
      usersThisMonth: allUsers.filter(u => after(u.createdAt, monthAgo)).length,
      projectsThisWeek: projectRows.filter(p => after(p.createdAt, weekAgo)).length,
      projectsThisMonth: projectRows.filter(p => after(p.createdAt, monthAgo)).length,
    };
  }

  async growth(since: Date): Promise<AdminGrowthPoint[]> {
    const buckets = emptyGrowth(since, this.now());
    const bump = (iso: string, key: 'users' | 'projects'): void => {
      const point = buckets.get(monthKey(iso));
      if (point) point[key] += 1;
    };
    for (const u of await this.userStore.listAll(Number.MAX_SAFE_INTEGER)) bump(u.createdAt, 'users');
    for (const p of this.registry.adminProjects()) bump(p.createdAt, 'projects');
    return [...buckets.values()];
  }

  async organizations(limit: number): Promise<AdminOrganization[]> {
    const members = this.registry.adminMemberships();
    const projectRows = this.registry.adminProjects();
    return this.registry
      .adminOrganizations()
      .map(o => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        members: members.filter(m => m.organizationId === o.id).length,
        projects: projectRows.filter(p => p.organizationId === o.id).length,
      }))
      .sort((a, b) => b.projects - a.projects || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async users(limit: number): Promise<AdminUser[]> {
    return (await this.userStore.listAll(limit)).map(toAdminUser);
  }

  async platformAdmins(): Promise<AdminUser[]> {
    const all = await this.userStore.listAll(Number.MAX_SAFE_INTEGER);
    return all.filter(u => u.isPlatformAdmin).map(toAdminUser);
  }

  async userDetail(id: string): Promise<AdminUserDetail | null> {
    const u = await this.userStore.findById(id);
    if (!u) return null;
    const memberships = this.registry.adminMemberships().filter(m => m.userId === id);
    const orgs = new Map(this.registry.adminOrganizations().map(o => [o.id, o]));
    const orgIds = new Set(memberships.map(m => m.organizationId));
    return {
      ...toAdminUser(u),
      totpEnabled: u.totpEnabled,
      organizations: memberships.map(m => {
        const o = orgs.get(m.organizationId);
        return {
          id: m.organizationId,
          name: o?.name ?? 'unknown',
          slug: o?.slug ?? '',
          role: m.role,
        };
      }),
      projects: this.registry
        .adminProjects()
        .filter(p => orgIds.has(p.organizationId))
        .map(p => ({ id: p.id, name: p.name, organizationId: p.organizationId })),
    };
  }

  async organizationDetail(id: string): Promise<AdminOrgDetail | null> {
    const org = this.registry.adminOrganizations().find(o => o.id === id);
    if (!org) return null;
    const members = this.registry.adminMemberships().filter(m => m.organizationId === id);
    const projectRows = this.registry.adminProjects().filter(p => p.organizationId === id);
    const emails = new Map(
      (await this.userStore.listAll(Number.MAX_SAFE_INTEGER)).map(u => [u.id, u.email]),
    );
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      members: members.length,
      projects: projectRows.length,
      createdAt: '',
      memberList: members.map(m => ({
        userId: m.userId,
        email: emails.get(m.userId) ?? null,
        role: m.role,
      })),
      projectList: projectRows.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        region: p.region,
      })),
    };
  }

  async projectDetail(id: string): Promise<AdminProjectDetail | null> {
    const p = this.registry.adminProjects().find(x => x.id === id);
    if (!p) return null;
    const org = this.registry.adminOrganizations().find(o => o.id === p.organizationId);
    const db = this.registry.adminDatabases().find(d => d.projectId === id);
    const owner = p.createdBy ? await this.userStore.findById(p.createdBy) : null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      organizationId: p.organizationId,
      organizationName: org?.name ?? null,
      region: p.region,
      databaseStatus: db?.status ?? null,
      databaseHealth: null,
      createdAt: p.createdAt,
      slugPath: `${org?.slug ?? '?'}/${p.slug}`,
      ownerEmail: owner?.email ?? null,
    };
  }

  async auditByActions(actions: string[], limit: number): Promise<AdminAuditRow[]> {
    const wanted = new Set(actions);
    const rows = await this.registry.listAudit();
    return rows
      .filter(r => wanted.has(r.event))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        action: r.event,
        organizationId: r.organizationId ?? null,
        actorUserId: r.userId ?? null,
        createdAt: r.at,
      }));
  }

  async projects(limit: number): Promise<AdminProject[]> {
    const orgs = new Map(this.registry.adminOrganizations().map(o => [o.id, o.name]));
    const dbs = new Map(this.registry.adminDatabases().map(d => [d.projectId, d.status]));
    return this.registry
      .adminProjects()
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        organizationId: p.organizationId,
        organizationName: orgs.get(p.organizationId) ?? null,
        region: p.region,
        databaseStatus: dbs.get(p.id) ?? null,
        createdAt: p.createdAt,
      }));
  }

  async audit(limit: number): Promise<AdminAuditRow[]> {
    const rows = await this.registry.listAudit();
    return rows
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        action: r.event,
        organizationId: r.organizationId,
        actorUserId: r.userId,
        createdAt: r.at,
      }));
  }

  async databasesByStatus(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const d of this.registry.adminDatabases()) {
      out[d.status] = (out[d.status] ?? 0) + 1;
    }
    return out;
  }
}

// ── Drizzle (production) ────────────────────────────────────────────

export class DrizzleAdminStore implements AdminStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async totals(): Promise<AdminTotals> {
    const [u, o, p, d] = await Promise.all([
      this.db.select({ n: count() }).from(users),
      this.db.select({ n: count() }).from(organizations),
      this.db.select({ n: count() }).from(projects),
      this.db.select({ n: count() }).from(projectDatabases),
    ]);
    const n = (rows: { n: number }[]): number => Number(rows[0]?.n ?? 0);
    return { users: n(u), organizations: n(o), projects: n(p), databases: n(d) };
  }

  async recent(weekAgo: Date, monthAgo: Date): Promise<AdminRecent> {
    const [uw, um, pw, pm] = await Promise.all([
      this.db.select({ n: count() }).from(users).where(gte(users.createdAt, weekAgo)),
      this.db.select({ n: count() }).from(users).where(gte(users.createdAt, monthAgo)),
      this.db.select({ n: count() }).from(projects).where(gte(projects.createdAt, weekAgo)),
      this.db.select({ n: count() }).from(projects).where(gte(projects.createdAt, monthAgo)),
    ]);
    const n = (rows: { n: number }[]): number => Number(rows[0]?.n ?? 0);
    return {
      usersThisWeek: n(uw),
      usersThisMonth: n(um),
      projectsThisWeek: n(pw),
      projectsThisMonth: n(pm),
    };
  }

  async growth(since: Date): Promise<AdminGrowthPoint[]> {
    const bucket = emptyGrowth(since, this.now());
    const monthOf = (col: AnyPgColumn): SQL<string> =>
      sql<string>`to_char(date_trunc('month', ${col}), 'YYYY-MM')`;
    const [userRows, projectRows] = await Promise.all([
      this.db
        .select({ month: monthOf(users.createdAt), n: count() })
        .from(users)
        .where(gte(users.createdAt, since))
        .groupBy(monthOf(users.createdAt)),
      this.db
        .select({ month: monthOf(projects.createdAt), n: count() })
        .from(projects)
        .where(gte(projects.createdAt, since))
        .groupBy(monthOf(projects.createdAt)),
    ]);
    for (const r of userRows) {
      const point = bucket.get(r.month);
      if (point) point.users = Number(r.n);
    }
    for (const r of projectRows) {
      const point = bucket.get(r.month);
      if (point) point.projects = Number(r.n);
    }
    return [...bucket.values()];
  }

  async organizations(limit: number): Promise<AdminOrganization[]> {
    /**
     * Counted with correlated subqueries rather than two joins: joining
     * memberships AND projects to organizations multiplies the rows, and the
     * counts come back as each other's products.
     */
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        members: sql<number>`(select count(*) from ${organizationMemberships} m where m.organization_id = ${organizations.id})`,
        projects: sql<number>`(select count(*) from ${projects} p where p.organization_id = ${organizations.id})`,
      })
      .from(organizations)
      .orderBy(
        desc(sql`(select count(*) from ${projects} p where p.organization_id = ${organizations.id})`),
      )
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      members: Number(r.members),
      projects: Number(r.projects),
    }));
  }

  /** The user columns this console may read. Never a hash or TOTP secret. */
  private userCols() {
    return {
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
      createdAt: users.createdAt,
      suspendedAt: users.suspendedAt,
    };
  }

  private mapUser(r: {
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
    createdAt: Date;
    suspendedAt: Date | null;
  }): AdminUser {
    return {
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      isPlatformAdmin: r.isPlatformAdmin,
      createdAt: r.createdAt.toISOString(),
      suspendedAt: r.suspendedAt ? r.suspendedAt.toISOString() : null,
    };
  }

  async users(limit: number): Promise<AdminUser[]> {
    const rows = await this.db
      .select(this.userCols())
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit);
    return rows.map(r => this.mapUser(r));
  }

  async platformAdmins(): Promise<AdminUser[]> {
    const rows = await this.db
      .select(this.userCols())
      .from(users)
      .where(eq(users.isPlatformAdmin, true))
      .orderBy(desc(users.createdAt))
      .limit(MAX_LIMIT);
    return rows.map(r => this.mapUser(r));
  }

  async userDetail(id: string): Promise<AdminUserDetail | null> {
    const rows = await this.db
      .select({ ...this.userCols(), totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const memberships = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(eq(organizationMemberships.userId, id));
    const orgIds = memberships.map(m => m.id);
    const projectRows =
      orgIds.length === 0
        ? []
        : await this.db
            .select({
              id: projects.id,
              name: projects.name,
              organizationId: projects.organizationId,
            })
            .from(projects)
            .where(inArray(projects.organizationId, orgIds))
            .limit(MAX_LIMIT);
    return {
      ...this.mapUser(row),
      totpEnabled: row.totpEnabled,
      organizations: memberships,
      projects: projectRows,
    };
  }

  async organizationDetail(id: string): Promise<AdminOrgDetail | null> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    const org = rows[0];
    if (!org) return null;
    const [memberList, projectList] = await Promise.all([
      this.db
        .select({
          userId: organizationMemberships.userId,
          email: users.email,
          role: organizationMemberships.role,
        })
        .from(organizationMemberships)
        .leftJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(organizationMemberships.organizationId, id))
        .limit(MAX_LIMIT),
      this.db
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          region: projects.region,
        })
        .from(projects)
        .where(eq(projects.organizationId, id))
        .limit(MAX_LIMIT),
    ]);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      members: memberList.length,
      projects: projectList.length,
      createdAt: org.createdAt.toISOString(),
      memberList,
      projectList,
    };
  }

  async projectDetail(id: string): Promise<AdminProjectDetail | null> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        organizationId: projects.organizationId,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        region: projects.region,
        createdAt: projects.createdAt,
        createdBy: projects.createdBy,
        databaseStatus: projectDatabases.status,
      })
      .from(projects)
      .leftJoin(organizations, eq(organizations.id, projects.organizationId))
      .leftJoin(projectDatabases, eq(projectDatabases.projectId, projects.id))
      .where(eq(projects.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const owner = row.createdBy
      ? await this.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, row.createdBy))
          .limit(1)
      : [];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      organizationId: row.organizationId,
      organizationName: row.organizationName ?? null,
      region: row.region,
      databaseStatus: row.databaseStatus ?? null,
      databaseHealth: null,
      createdAt: row.createdAt.toISOString(),
      slugPath: `${row.organizationSlug ?? '?'}/${row.slug}`,
      ownerEmail: owner[0]?.email ?? null,
    };
  }

  async auditByActions(actions: string[], limit: number): Promise<AdminAuditRow[]> {
    if (actions.length === 0) return [];
    const rows = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        organizationId: auditLogs.organizationId,
        actorUserId: auditLogs.actorUserId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(inArray(auditLogs.action, actions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      organizationId: r.organizationId,
      actorUserId: r.actorUserId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async projects(limit: number): Promise<AdminProject[]> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        organizationId: projects.organizationId,
        organizationName: organizations.name,
        region: projects.region,
        databaseStatus: projectDatabases.status,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .leftJoin(organizations, eq(organizations.id, projects.organizationId))
      .leftJoin(projectDatabases, eq(projectDatabases.projectId, projects.id))
      .orderBy(desc(projects.createdAt))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      region: r.region,
      databaseStatus: r.databaseStatus,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async audit(limit: number): Promise<AdminAuditRow[]> {
    const rows = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        organizationId: auditLogs.organizationId,
        actorUserId: auditLogs.actorUserId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      organizationId: r.organizationId,
      actorUserId: r.actorUserId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async databasesByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: projectDatabases.status, n: count() })
      .from(projectDatabases)
      .groupBy(projectDatabases.status);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}

// ── Wiring ──────────────────────────────────────────────────────────

export function adminStoreFor(ctx: ApiContext): AdminStore {
  const cached = (ctx as unknown as { __admin?: AdminStore }).__admin;
  if (cached) return cached;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const controlDb = ctx.controlDb;
  const platform = platformAuthFor(ctx);
  let store: AdminStore;
  if (durable && controlDb) {
    store = new DrizzleAdminStore(controlDb.db);
  } else if (ctx.registry instanceof MemoryRegistry && platform.users instanceof MemoryPlatformUsers) {
    store = new MemoryAdminStore(ctx.registry, platform.users);
  } else {
    /**
     * A mixed wiring (durable registry, memory users, or the reverse) would
     * report one half of the platform and silently zero the other. An
     * operator console that under-reports is worse than one that is absent,
     * so this refuses instead of guessing.
     */
    throw new ApiError(
      'UNAVAILABLE',
      'Operator console requires a consistent control store',
      503,
    );
  }
  (ctx as unknown as { __admin?: AdminStore }).__admin = store;
  return store;
}

/**
 * Promote the PLATFORM_ADMIN_EMAILS allowlist. Runs on boot, after
 * migrations. Grants only; never demotes (see the config comment).
 */
export async function bootstrapPlatformAdmins(ctx: ApiContext, logger: Logger): Promise<number> {
  const raw = ctx.config.PLATFORM_ADMIN_EMAILS.trim();
  if (!raw) return 0;
  const emails = raw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);
  const { users: store } = platformAuthFor(ctx);
  let granted = 0;
  for (const email of emails) {
    try {
      if (await store.grantPlatformAdmin(email)) granted += 1;
    } catch (err) {
      // A bootstrap failure must never stop the API from booting.
      logger.warn('admin.bootstrap_failed', {
        error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
    }
  }
  if (granted > 0) logger.info('admin.bootstrap', { granted, configured: emails.length });
  return granted;
}

/**
 * True when `email` is on the PLATFORM_ADMIN_EMAILS allowlist and the grant
 * changed the row. Called at signup so an operator who registers after the
 * env var is set is still promoted, and at boot for one already registered.
 */
export async function applyStaffAllowlist(ctx: ApiContext, email: string): Promise<boolean> {
  const raw = ctx.config.PLATFORM_ADMIN_EMAILS.trim();
  if (!raw) return false;
  const allow = new Set(
    raw
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 0),
  );
  if (!allow.has(email.toLowerCase())) return false;
  try {
    return await platformAuthFor(ctx).users.grantPlatformAdmin(email);
  } catch {
    // Never let a promotion failure break signup.
    return false;
  }
}

export function isAdminRoute(pathname: string, method: string): boolean {
  void method;
  return pathname === '/api/v1/admin' || pathname.startsWith('/api/v1/admin/');
}

/**
 * Actions the console treats as security-relevant.
 *
 * These are the audit events the platform already records; the Security
 * Center reads them rather than inventing a parallel event stream, so what
 * an operator sees there is exactly what the API wrote.
 */
const SECURITY_ACTIONS = [
  'platform.login_failed',
  'platform.login_suspended',
  'platform.mfa_challenged',
  'platform.mfa.enabled',
  'platform.mfa.disabled',
  'platform.password_reset',
  'admin.user_suspended',
  'admin.user_restored',
  'admin.email_sent',
] as const;

/** Admin actions, for the Admin Management and Audit sections. */
const ADMIN_ACTIONS = [
  'admin.user_suspended',
  'admin.user_restored',
  'admin.email_sent',
  'admin.bootstrap',
] as const;

export function adminOpenApi(): Record<string, unknown> {
  return {
    '/admin/overview': {
      get: { summary: 'Platform totals, recent signups, growth series (staff only)' },
    },
    '/admin/organizations': { get: { summary: 'Organizations by project count (staff only)' } },
    '/admin/users': { get: { summary: 'Newest platform users (staff only)' } },
    '/admin/projects': { get: { summary: 'Newest projects with database status (staff only)' } },
    '/admin/jobs': { get: { summary: 'Failed provisioning jobs (staff only)' } },
    '/admin/audit': { get: { summary: 'Recent audit events across tenants (staff only)' } },
  };
}

/**
 * Staff gate. Verifies the session, then re-reads the flag from the store —
 * never from the token — so a demotion takes effect on the next request.
 * Returns the staff user id; throws 404 for everyone else.
 */
async function requireStaff(req: IncomingMessage, ctx: ApiContext): Promise<string> {
  const notFound = new ApiError('NOT_FOUND', 'Not found', 404);
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw notFound;
  let sub: string;
  try {
    const session = await verifyPlatformSession(ctx, token);
    sub = session.sub;
  } catch {
    throw notFound;
  }
  const user = await platformAuthFor(ctx).users.findById(sub);
  if (!user?.isPlatformAdmin) throw notFound;
  return user.id;
}

function limitFrom(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!isAdminRoute(url.pathname, req.method ?? 'GET')) return false;
  const start = Date.now();
  const method = (req.method ?? 'GET').toUpperCase();
  const route = url.pathname.replace('/api/v1/admin', '') || '/';
  const finish = (status: number, body: unknown): true => {
    logger.info('admin.request', { route, method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };

  try {
    const staffId = await requireStaff(req, ctx);
    const store = adminStoreFor(ctx);
    const limit = limitFrom(url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

    // ── Mutations ──────────────────────────────────────────────────
    if (method === 'POST') {
      const suspendMatch = /^\/users\/([^/]+)\/(suspend|restore)$/.exec(route);
      if (suspendMatch) {
        const targetId = suspendMatch[1] as string;
        const suspend = suspendMatch[2] === 'suspend';
        if (targetId === staffId) {
          throw new ApiError('VALIDATION_ERROR', 'You cannot suspend your own account', 400);
        }
        const body = (await readJson(req)) as { reason?: unknown } | undefined;
        const reason =
          typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) || null : null;
        const users = platformAuthFor(ctx).users;
        const target = await users.findById(targetId);
        if (!target) throw new ApiError('NOT_FOUND', 'User not found', 404);
        /**
         * Staff cannot be suspended from the console. Removing an operator
         * is a deliberate act that should go through the staff flag, not a
         * button that could lock every operator out of the platform at once.
         */
        if (target.isPlatformAdmin) {
          throw new ApiError('FORBIDDEN', 'Platform staff cannot be suspended here', 403);
        }
        const updated = await users.setSuspended(targetId, suspend, reason);
        if (!updated) throw new ApiError('NOT_FOUND', 'User not found', 404);
        await ctx.registry.recordAudit(suspend ? 'admin.user_suspended' : 'admin.user_restored', {
          userId: staffId,
        });
        logger.warn('admin.account_action', {
          action: suspend ? 'suspend' : 'restore',
          actor: staffId,
          target: targetId,
        });
        return finish(
          200,
          ok(
            {
              user: {
                id: updated.id,
                email: updated.email,
                suspendedAt: updated.suspendedAt,
              },
            },
            requestId,
          ),
        );
      }

      if (route === '/emails' || route === '/emails/test' || route === '/emails/preview') {
        return await handleAdminEmail(req, ctx, logger, route, staffId, requestId, finish);
      }
      throw new ApiError('NOT_FOUND', 'Not found', 404);
    }

    if (method === 'DELETE') {
      const draft = /^\/emails\/([^/]+)$/.exec(route);
      if (draft) {
        const removed = await emailStoreFor(ctx).remove(draft[1] as string);
        if (!removed) throw new ApiError('NOT_FOUND', 'Draft not found', 404);
        return finish(200, ok({ deleted: true }, requestId));
      }
      throw new ApiError('NOT_FOUND', 'Not found', 404);
    }

    if (method !== 'GET') throw new ApiError('NOT_FOUND', 'Not found', 404);

    // ── Reads ──────────────────────────────────────────────────────
    if (route === '/overview' || route === '/') {
      const since = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (GROWTH_MONTHS - 1), 1),
      );
      const [totals, recent, growth, databases, failedJobs] = await Promise.all([
        store.totals(),
        store.recent(weekAgo, monthAgo),
        store.growth(since),
        store.databasesByStatus(),
        ctx.jobs.listByStatus('failed', MAX_LIMIT),
      ]);
      // Request metrics are process-local and reset on deploy — the field
      // name says so rather than implying platform-wide history.
      const traffic = ctx.metrics.summarize(24 * 3600_000, now.getTime());
      return finish(
        200,
        ok(
          {
            totals,
            recent,
            growth,
            databases,
            provisioning: { failed: failedJobs.length },
            trafficSinceBoot: {
              requests: traffic.requests,
              errors: traffic.errors,
              errorRate: traffic.errorRate,
              p50Ms: traffic.p50Ms,
              p95Ms: traffic.p95Ms,
              since: new Date(traffic.since).toISOString(),
            },
            generatedAt: now.toISOString(),
          },
          requestId,
        ),
      );
    }

    if (route === '/organizations') {
      const rows = await store.organizations(limit);
      return finish(
        200,
        ok(
          {
            organizations: q
              ? rows.filter(o => `${o.name} ${o.slug}`.toLowerCase().includes(q))
              : rows,
          },
          requestId,
        ),
      );
    }
    const orgDetail = /^\/organizations\/([^/]+)$/.exec(route);
    if (orgDetail) {
      const detail = await store.organizationDetail(orgDetail[1] as string);
      if (!detail) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
      return finish(200, ok({ organization: detail }, requestId));
    }

    if (route === '/users') {
      const rows = await store.users(q ? MAX_LIMIT : limit);
      const filtered = q
        ? rows.filter(u => `${u.email} ${u.displayName ?? ''}`.toLowerCase().includes(q))
        : rows;
      return finish(200, ok({ users: filtered.slice(0, limit) }, requestId));
    }
    const userDetail = /^\/users\/([^/]+)$/.exec(route);
    if (userDetail) {
      const detail = await store.userDetail(userDetail[1] as string);
      if (!detail) throw new ApiError('NOT_FOUND', 'User not found', 404);
      return finish(200, ok({ user: detail }, requestId));
    }

    if (route === '/projects') {
      const rows = await store.projects(q ? MAX_LIMIT : limit);
      const filtered = q
        ? rows.filter(p =>
            `${p.name} ${p.slug} ${p.organizationName ?? ''} ${p.region}`.toLowerCase().includes(q),
          )
        : rows;
      return finish(200, ok({ projects: filtered.slice(0, limit) }, requestId));
    }
    const projectDetail = /^\/projects\/([^/]+)$/.exec(route);
    if (projectDetail) {
      const detail = await store.projectDetail(projectDetail[1] as string);
      if (!detail) throw new ApiError('NOT_FOUND', 'Project not found', 404);
      return finish(200, ok({ project: detail }, requestId));
    }

    if (route === '/audit') {
      const action = url.searchParams.get('action');
      const rows = action
        ? await store.auditByActions([action], limit)
        : await store.audit(limit);
      return finish(200, ok({ audit: rows }, requestId));
    }

    if (route === '/security') {
      const [events, admins] = await Promise.all([
        store.auditByActions([...SECURITY_ACTIONS], limit),
        store.platformAdmins(),
      ]);
      const failedLogins = events.filter(e => e.action === 'platform.login_failed');
      return finish(
        200,
        ok(
          {
            events,
            failedLogins: failedLogins.length,
            suspendedLoginAttempts: events.filter(e => e.action === 'platform.login_suspended')
              .length,
            staffCount: admins.length,
            /** Configuration facts an operator should be able to confirm. */
            posture: {
              captchaConfigured: ctx.config.CAPTCHA_PROVIDER !== 'disabled',
              emailDriver: ctx.config.EMAIL_DRIVER,
              controlStore: ctx.controlDb ? 'drizzle' : 'memory',
              trustedProxyHops: ctx.config.TRUSTED_PROXY_HOPS,
            },
          },
          requestId,
        ),
      );
    }

    if (route === '/admins') {
      const [admins, actions] = await Promise.all([
        store.platformAdmins(),
        store.auditByActions([...ADMIN_ACTIONS], limit),
      ]);
      return finish(200, ok({ admins, actions }, requestId));
    }

    if (route === '/observability') {
      const windowMs = Math.min(
        7 * 24 * 3600_000,
        Math.max(300_000, Number(url.searchParams.get('windowMs') ?? 3600_000)),
      );
      const summary = ctx.metrics.summarize(windowMs, now.getTime());
      return finish(
        200,
        ok(
          {
            /**
             * Process-local and reset by every deploy. Named so no operator
             * mistakes it for platform-wide retained history.
             */
            scope: 'this API process, since boot',
            since: new Date(summary.since).toISOString(),
            windowMs: summary.windowMs,
            requests: summary.requests,
            errors: summary.errors,
            errorRate: summary.errorRate,
            p50Ms: summary.p50Ms,
            p95Ms: summary.p95Ms,
            byService: summary.byService,
            topRoutes: summary.topRoutes,
            timeline: summary.timeline,
          },
          requestId,
        ),
      );
    }

    if (route === '/infrastructure') {
      const components: Record<string, { ok: boolean; detail: string | null }> = {
        http: { ok: true, detail: null },
      };
      if (ctx.controlDb) {
        const health = await ctx.controlDb
          .healthCheck()
          .catch(() => ({ ok: false as const, latencyMs: -1 }));
        components['controlDatabase'] = {
          ok: health.ok,
          detail: health.latencyMs >= 0 ? `${health.latencyMs}ms` : null,
        };
      } else {
        components['controlStore'] = { ok: true, detail: 'in-memory (CONTROL_STORE=memory)' };
      }
      try {
        const n = await ctx.registry.countDatabases();
        components['registry'] = { ok: true, detail: `${n} databases` };
      } catch {
        components['registry'] = { ok: false, detail: 'unreachable' };
      }
      const [databases, failed] = await Promise.all([
        store.databasesByStatus(),
        ctx.jobs.listByStatus('failed', MAX_LIMIT),
      ]);
      return finish(
        200,
        ok(
          {
            components,
            databases,
            failedJobs: failed.slice(0, limit).map(j => ({
              id: j.id,
              projectId: j.projectId,
              kind: j.kind,
              attempts: j.attempts,
              maxAttempts: j.maxAttempts,
              lastError: j.lastError,
              updatedAt: j.updatedAt,
            })),
            drivers: {
              provisioning: ctx.config.PROVISION_DRIVER,
              storage: ctx.config.STORAGE_DRIVER,
              realtime: ctx.config.REALTIME_DRIVER,
              functions: ctx.config.FUNCTION_RUNTIME,
              billing: ctx.config.BILLING_PROVIDER,
              email: ctx.config.EMAIL_DRIVER,
            },
          },
          requestId,
        ),
      );
    }

    if (route === '/config') {
      /**
       * Configuration, REDACTED. Every value here is a mode or a boolean —
       * "is a key present", never the key. A console that printed a secret
       * would turn one compromised staff session into a credential leak.
       */
      const c = ctx.config;
      return finish(
        200,
        ok(
          {
            environment: c.NODE_ENV,
            appUrl: c.APP_URL,
            drivers: {
              controlStore: ctx.controlDb ? 'drizzle' : 'memory',
              provisioning: c.PROVISION_DRIVER,
              storage: c.STORAGE_DRIVER,
              realtime: c.REALTIME_DRIVER,
              functions: c.FUNCTION_RUNTIME,
              billing: c.BILLING_PROVIDER,
              email: c.EMAIL_DRIVER,
              captcha: c.CAPTCHA_PROVIDER,
            },
            configured: {
              resendApiKey: Boolean(c.RESEND_API_KEY),
              resendFrom: Boolean(c.RESEND_FROM),
              smtpHost: Boolean(c.SMTP_HOST),
              redis: Boolean(c.REDIS_URL),
              jwtIssuer: Boolean(c.JWT_ISSUER),
            },
            senderAddress: c.RESEND_FROM || c.SMTP_FROM || null,
            migrateOnBoot: c.MIGRATE_ON_BOOT,
            trustedProxyHops: c.TRUSTED_PROXY_HOPS,
          },
          requestId,
        ),
      );
    }

    if (route === '/emails') {
      const status = url.searchParams.get('status');
      const [emails, counts] = await Promise.all([
        emailStoreFor(ctx).list({
          status: (status as EmailStatus | null) ?? null,
          query: q || null,
          limit,
        }),
        emailStoreFor(ctx).counts(),
      ]);
      return finish(
        200,
        ok(
          {
            emails,
            counts,
            sender: {
              driver: ctx.config.EMAIL_DRIVER,
              from: ctx.config.RESEND_FROM || ctx.config.SMTP_FROM || null,
              /** Whether a real provider is wired. The key itself never leaves the server. */
              ready:
                (ctx.config.EMAIL_DRIVER === 'resend' &&
                  Boolean(ctx.config.RESEND_API_KEY && ctx.config.RESEND_FROM)) ||
                (ctx.config.EMAIL_DRIVER === 'smtp' &&
                  Boolean(ctx.config.SMTP_HOST && ctx.config.SMTP_FROM)),
            },
          },
          requestId,
        ),
      );
    }
    if (route === '/emails/templates') {
      return finish(200, ok({ templates: EMAIL_TEMPLATES }, requestId));
    }
    const emailDetail = /^\/emails\/([^/]+)$/.exec(route);
    if (emailDetail) {
      const row = await emailStoreFor(ctx).get(emailDetail[1] as string);
      if (!row) throw new ApiError('NOT_FOUND', 'Email not found', 404);
      return finish(200, ok({ email: row }, requestId));
    }

    if (route === '/jobs') {
      const jobs = await ctx.jobs.listByStatus('failed', limit);
      return finish(
        200,
        ok(
          {
            jobs: jobs.map(j => ({
              id: j.id,
              projectId: j.projectId,
              organizationId: j.organizationId,
              kind: j.kind,
              status: j.status,
              attempts: j.attempts,
              maxAttempts: j.maxAttempts,
              lastError: j.lastError,
              updatedAt: j.updatedAt,
            })),
          },
          requestId,
        ),
      );
    }
    throw new ApiError('NOT_FOUND', 'Not found', 404);
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    logger.info('admin.request', { route, method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  }
}

/**
 * The Email Center's write side.
 *
 * Four things this does that a naive implementation would not:
 *
 * 1. It records the attempt BEFORE sending and updates the row with the
 *    outcome. If the process dies mid-send, the operator sees an attempt
 *    that never resolved rather than nothing at all.
 * 2. It reports the provider's own verdict. An accepted message is `sent`,
 *    never `delivered` — see admin-email.ts.
 * 3. It refuses to pretend. With no real sender configured the request fails
 *    with a 503 that names the missing configuration, rather than writing a
 *    `sent` row against the memory driver.
 * 4. It rate-limits per operator and caps recipients, so one compromised
 *    staff session cannot turn the platform into a mailer.
 */
async function handleAdminEmail(
  req: IncomingMessage,
  ctx: ApiContext,
  logger: Logger,
  route: string,
  staffId: string,
  requestId: string,
  finish: (status: number, body: unknown) => true,
): Promise<true> {
  const body = (await readJson(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    throw new ApiError('VALIDATION_ERROR', 'A JSON body is required', 400);
  }

  const actor = await platformAuthFor(ctx).users.findById(staffId);
  if (!actor) throw new ApiError('UNAUTHORIZED', 'Session no longer valid', 401);

  const subject = typeof body['subject'] === 'string' ? body['subject'].trim() : '';
  const intro = typeof body['intro'] === 'string' ? body['intro'] : '';
  const closing = typeof body['closing'] === 'string' ? body['closing'] : '';
  const templateId = typeof body['template'] === 'string' ? body['template'] : null;
  const bullets = Array.isArray(body['bullets'])
    ? body['bullets'].filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    : [];
  const ctaLabel = typeof body['ctaLabel'] === 'string' ? body['ctaLabel'].trim() : '';
  const ctaPath = typeof body['ctaPath'] === 'string' ? body['ctaPath'].trim() : '';

  const appUrl = (ctx.config.APP_URL ?? '').replace(/\/+$/, '') || 'http://localhost:3000';
  const brand = { appUrl, logoUrl: `${appUrl}/email-logo.png` };
  /**
   * The CTA is built from a PATH on the product's own origin. Accepting a
   * full URL would let an operator mail an arbitrary link on CloudNivo
   * letterhead, which is a phishing primitive, not a feature.
   */
  const cta =
    ctaLabel && ctaPath
      ? { label: ctaLabel, url: `${appUrl}${ctaPath.startsWith('/') ? ctaPath : `/${ctaPath}`}` }
      : null;

  if (subject.length < 2) {
    throw new ApiError('VALIDATION_ERROR', 'A subject is required', 400);
  }
  if (intro.trim() === '' && bullets.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'The email has no body', 400);
  }

  const rendered = renderOperatorEmail({ subject, intro, bullets, closing, cta, brand });

  // Preview renders only. Nothing is stored and nothing is sent.
  if (route === '/emails/preview') {
    return finish(200, ok({ preview: rendered }, requestId));
  }

  const isTest = route === '/emails/test';
  const to = isTest ? [actor.email] : parseRecipients(body['to'], 'to');
  const cc = isTest ? [] : parseRecipients(body['cc'], 'cc');
  const bcc = isTest ? [] : parseRecipients(body['bcc'], 'bcc');
  const audience = [...to, ...cc, ...bcc];

  if (audience.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'At least one recipient is required', 400);
  }
  if (audience.length > MAX_RECIPIENTS) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `A single send is limited to ${MAX_RECIPIENTS} recipients`,
      400,
    );
  }

  // Per-operator rate limit. Counts sends, not recipients, and applies to
  // test sends too — a test loop is still traffic against the provider.
  const rl = await checkRateLimit(ctx.rateLimitStore, `admin-email:${staffId}`, {
    max: SEND_RATE_LIMIT,
    windowMs: SEND_RATE_WINDOW_SECONDS * 1000,
    keyPrefix: 'admin-email',
  });
  if (!rl.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many sends. Try again later.', 429);
  }

  const emails = emailStoreFor(ctx);
  const driver = ctx.config.EMAIL_DRIVER;
  const senderReady =
    (driver === 'resend' && Boolean(ctx.config.RESEND_API_KEY && ctx.config.RESEND_FROM)) ||
    (driver === 'smtp' && Boolean(ctx.config.SMTP_HOST && ctx.config.SMTP_FROM));

  if (!senderReady) {
    // Recorded as failed so the attempt is visible in Delivery Logs, then
    // reported honestly. Never written as sent.
    await emails.create({
      actorUserId: actor.id,
      actorEmail: actor.email,
      recipients: to,
      cc,
      bcc,
      subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      template: templateId,
      status: 'failed',
      provider: driver,
      providerId: null,
      error: `No email sender is configured (EMAIL_DRIVER=${driver}).`,
      isTest,
    });
    /**
     * 409, not 503. `toPublicError` replaces every 5xx message with
     * "Internal server error" so internals never leak — which would hide the
     * one thing the operator needs to read. A missing sender is not a
     * transient outage either: it is a precondition the operator can fix, so
     * it belongs in the 4xx range where its explanation survives.
     */
    throw new ApiError(
      'CONFLICT',
      `No email sender is configured (EMAIL_DRIVER=${driver}). Nothing was sent.`,
      409,
    );
  }

  const record = await emails.create({
    actorUserId: actor.id,
    actorEmail: actor.email,
    recipients: to,
    cc,
    bcc,
    subject,
    bodyHtml: rendered.html,
    bodyText: rendered.text,
    template: templateId,
    status: 'queued',
    provider: driver,
    providerId: null,
    error: null,
    isTest,
  });

  try {
    const receipt = await platformMailer(ctx).sendComposed({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
    });
    const sent = await emails.update(record.id, {
      status: 'sent',
      providerId: receipt.id,
      sentAt: new Date().toISOString(),
    });
    await ctx.registry.recordAudit('admin.email_sent', { userId: staffId });
    logger.info('admin.email_sent', {
      actor: staffId,
      recipients: audience.length,
      provider: driver,
      providerId: receipt.id,
      isTest,
    });
    return finish(202, ok({ email: sent ?? record }, requestId));
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'Send failed';
    const failed = await emails.update(record.id, { status: 'failed', error: message });
    logger.warn('admin.email_failed', { actor: staffId, provider: driver, error: message });
    // 502: the provider refused, not the operator's mistake. The row holds
    // the provider's own words so the failure is diagnosable.
    return finish(
      502,
      ok({ email: failed ?? record, error: message }, requestId),
    );
  }
}
