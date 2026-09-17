import type { IncomingMessage, ServerResponse } from 'node:http';
import { count, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ApiError, ok, toPublicError } from '@cloudnivo/api-core';
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
 * 3. Reads only. Nothing here mutates a tenant's data, so a mistake in this
 *    module cannot corrupt a customer's project — it can only over-share,
 *    which rule 1 and 2 are there to prevent.
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
    return (await this.userStore.listAll(limit)).map(u => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      isPlatformAdmin: u.isPlatformAdmin,
      createdAt: u.createdAt,
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

  async users(limit: number): Promise<AdminUser[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isPlatformAdmin: users.isPlatformAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit);
    return rows.map(r => ({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      isPlatformAdmin: r.isPlatformAdmin,
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
  const route = url.pathname.replace('/api/v1/admin', '') || '/';
  const finish = (status: number, body: unknown): true => {
    logger.info('admin.request', { route, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };

  try {
    if ((req.method ?? 'GET') !== 'GET') throw new ApiError('NOT_FOUND', 'Not found', 404);
    const staffId = await requireStaff(req, ctx);
    const store = adminStoreFor(ctx);
    const limit = limitFrom(url);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

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
      return finish(
        200,
        ok(
          {
            totals,
            recent,
            growth,
            databases,
            provisioning: { failed: failedJobs.length },
            generatedAt: now.toISOString(),
          },
          requestId,
        ),
      );
    }

    if (route === '/organizations') {
      return finish(200, ok({ organizations: await store.organizations(limit) }, requestId));
    }
    if (route === '/users') {
      return finish(200, ok({ users: await store.users(limit) }, requestId));
    }
    if (route === '/projects') {
      return finish(200, ok({ projects: await store.projects(limit) }, requestId));
    }
    if (route === '/audit') {
      return finish(200, ok({ audit: await store.audit(limit) }, requestId));
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
    void staffId;
    throw new ApiError('NOT_FOUND', 'Not found', 404);
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    logger.info('admin.request', { route, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  }
}

