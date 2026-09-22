import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, isUniqueViolation, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import {
  projectSecrets,
  projectBranches,
  projectEnvironments,
  type Database,
} from '@cloudnivo/database';
import { eq } from 'drizzle-orm';
import {
  EXTENSION_ALLOWLIST,
  assertExtensionAllowed,
  assertVaultName,
  assessMigrationSource,
  generateTypescriptTypes,
  importFromPostgres,
  listExtensions,
  listFunctions,
  listTriggers,
  listViews,
  planRestore,
  renderMigrationPreview,
  replicationStatus,
  runAllAdvisors,
  vaultDecrypt,
  vaultEncrypt,
  vaultKeyFromSecret,
  MemoryVaultStore,
  type DiffSchema,
  type VaultStore,
} from '@cloudnivo/db-tools';
import {
  BranchService,
  MemoryBranchStore,
  runLifecycleJob,
  type BranchRecord,
  type BranchStore,
} from '@cloudnivo/provisioning';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { AgentToken } from '@cloudnivo/agents';
import type { ApiContext } from './v1.js';
import type { ProjectRecord } from './registry.js';
import { generateDbPassword } from './registry.js';
import { auditAgent } from './agents.js';
import { mapInfraError, sendJson } from './projects.js';
import { requireSpendAllowed } from './billing.js';
import { handleMigrationRoutes, isMigrationRoute } from './migrations.js';

/**
 * Database power-tools: extensions, advisors, generated types, schema diff,
 * guarded restore, vault, branches, and environments. All routes live under
 * /api/v1/projects/:id/database/* (membership-checked by the caller) so
 * tenant isolation holds by construction.
 */

export interface DbToolsDeps {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: ApiContext;
  config: AppConfig;
  logger: Logger;
  baseHeaders: Record<string, string>;
  requestId: string;
  session: { sub: string; email: string; org?: string; agent?: AgentToken };
  project: ProjectRecord;
  gate: (opts: {
    scope: string;
    organizationId?: string;
    projectId?: string;
    action: string;
    resource?: string;
  }) => Promise<void>;
  creds: { host: string; port: number; database: string; user: string; password: string };
  query: URLSearchParams;
  readJson: () => Promise<unknown>;
}

function fail(deps: DbToolsDeps, err: unknown): true {
  const { status, body } = toPublicError(mapInfraErrorCaught(err), deps.requestId);
  sendJson(deps.res, status, body, deps.baseHeaders);
  return true;
}

function mapInfraErrorCaught(err: unknown): ApiError | unknown {
  try {
    return mapInfraError(err);
  } catch {
    return err;
  }
}

/** Human role gate: destructive database operations require admin/owner.
 *  Agents are gated separately via scopes; this closes viewer/member escalation. */
export async function requireDbManager(
  ctx: ApiContext,
  sessionSub: string,
  project: ProjectRecord,
): Promise<void> {
  const role =
    (await ctx.registry.membershipsFor(sessionSub)).find(
      m => m.organizationId === project.organizationId,
    )?.role ?? 'viewer';
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Database management requires admin', 403);
  }
}

/** Runner adapter: advisor/introspection SQL through the project gateway. */
function runnerFor(deps: DbToolsDeps): (text: string, params: unknown[]) => Promise<Record<string, unknown>[]> {
  return async (text: string, params: unknown[]) => {
    const result = await deps.ctx.gateway.query(deps.creds, text, {
      maxStatementMs: 15_000,
      maxRows: 500,
      maxLength: 20_000,
    }, params);
    return result.rows;
  };
}

// ── Branch + environment + vault stores (memory vs drizzle) ──

export function branchServiceFor(ctx: ApiContext): BranchService {
  const existing = (ctx as unknown as { __branches?: BranchService }).__branches;
  if (existing) return existing;
  const store: BranchStore =
    ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb
      ? new DrizzleBranchStore(ctx.controlDb.db)
      : new MemoryBranchStore();
  const svc = new BranchService(store, ctx.provider);
  (ctx as unknown as { __branches?: BranchService }).__branches = svc;
  return svc;
}

function rowToBranch(row: {
  id: string;
  projectId: string;
  organizationId: string;
  name: string;
  databaseId: string | null;
  dbName: string | null;
  dbUser: string | null;
  dbPassword: string | null;
  host: string | null;
  port: number | null;
  source: string | null;
  status: string | null;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): BranchRecord {
  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId,
    name: row.name,
    databaseId: row.databaseId ?? '',
    dbName: row.dbName ?? '',
    dbUser: row.dbUser ?? '',
    dbPassword: row.dbPassword,
    host: row.host ?? '',
    port: row.port ?? 5432,
    source: row.source ?? 'main',
    status: (row.status ?? 'creating') as BranchRecord['status'],
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class DrizzleBranchStore implements BranchStore {
  constructor(private readonly db: Database) {}
  async create(input: Omit<BranchRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<BranchRecord> {
    const { randomUUID } = await import('node:crypto');
    const rows = await this.db
      .insert(projectBranches)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        organizationId: input.organizationId,
        name: input.name,
        databaseId: input.databaseId,
        dbName: input.dbName,
        dbUser: input.dbUser,
        dbPassword: input.dbPassword,
        host: input.host,
        port: input.port,
        source: input.source,
        status: input.status,
        lastError: input.lastError,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Branch insert failed');
    return rowToBranch(row);
  }
  async get(id: string): Promise<BranchRecord | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      // Memory ids are uuids too — non-uuid can never match.
      const all = await this.db.select().from(projectBranches);
      const found = all.find(r => r.id === id);
      return found ? rowToBranch(found) : null;
    }
    const rows = await this.db.select().from(projectBranches).where(eq(projectBranches.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToBranch(row) : null;
  }
  async listByProject(projectId: string): Promise<BranchRecord[]> {
    const rows = await this.db
      .select()
      .from(projectBranches)
      .where(eq(projectBranches.projectId, projectId))
      .orderBy(projectBranches.createdAt);
    return rows.map(rowToBranch);
  }
  async update(
    id: string,
    patch: Partial<Pick<BranchRecord, 'status' | 'lastError' | 'databaseId' | 'dbName' | 'dbUser' | 'dbPassword' | 'host' | 'port'>>,
  ): Promise<BranchRecord | null> {
    const rows = await this.db
      .update(projectBranches)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(projectBranches.id, id))
      .returning();
    const row = rows[0];
    return row ? rowToBranch(row) : null;
  }
  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(projectBranches).where(eq(projectBranches.id, id)).returning();
    return rows.length > 0;
  }
}

export interface EnvRecord {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  branchId: string | null;
  isPreview: boolean;
  status: string;
  createdAt: string;
}

export function envServiceFor(ctx: ApiContext): {
  list(projectId: string): Promise<EnvRecord[]>;
  create(input: { projectId: string; name: string; slug: string; branchId?: string | null; isPreview?: boolean }): Promise<EnvRecord>;
  updateBranch(id: string, projectId: string, branchId: string | null): Promise<EnvRecord | null>;
  remove(id: string, projectId: string): Promise<boolean>;
} {
  const existing = (ctx as unknown as { __envs?: unknown }).__envs as ReturnType<typeof envServiceFor> | undefined;
  if (existing) return existing;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const db = durable && ctx.controlDb ? ctx.controlDb.db : null;
  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
  const svc = {
    async list(projectId: string): Promise<EnvRecord[]> {
      if (!db) return memoryEnvs(ctx, projectId);
      const rows = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));
      return rows.map(r => ({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        slug: r.slug,
        branchId: r.branchId,
        isPreview: r.isPreview ?? false,
        status: r.status ?? 'active',
        createdAt: iso(r.createdAt),
      }));
    },
    async create(input: { projectId: string; name: string; slug: string; branchId?: string | null; isPreview?: boolean }): Promise<EnvRecord> {
      if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(input.slug)) {
        throw new ApiError('VALIDATION_ERROR', 'Invalid environment slug', 400);
      }
      if (!db) {
        const { randomUUID } = await import('node:crypto');
        const rec: EnvRecord = {
          id: randomUUID(),
          projectId: input.projectId,
          name: input.name,
          slug: input.slug,
          branchId: input.branchId ?? null,
          isPreview: input.isPreview ?? false,
          status: 'active',
          createdAt: new Date().toISOString(),
        };
        envMemory(ctx, input.projectId).set(rec.id, rec);
        return rec;
      }
      try {
        const rows = await db
          .insert(projectEnvironments)
          .values({
            projectId: input.projectId,
            name: input.name,
            slug: input.slug,
            branchId: input.branchId ?? null,
            isPreview: input.isPreview ?? false,
          })
          .returning();
        const row = rows[0];
        if (!row) throw new Error('Environment insert failed');
        return {
          id: row.id,
          projectId: row.projectId,
          name: row.name,
          slug: row.slug,
          branchId: row.branchId,
          isPreview: row.isPreview ?? false,
          status: row.status ?? 'active',
          createdAt: iso(row.createdAt),
        };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError('CONFLICT', 'Environment slug taken', 409);
        }
        throw err;
      }
    },
    async updateBranch(id: string, projectId: string, branchId: string | null): Promise<EnvRecord | null> {
      if (!db) {
        const rec = envMemory(ctx, projectId).get(id) ?? null;
        if (!rec || rec.projectId !== projectId) return null;
        rec.branchId = branchId;
        return { ...rec };
      }
      const rows = await db
        .update(projectEnvironments)
        .set({ branchId })
        .where(eq(projectEnvironments.id, id))
        .returning();
      const row = rows[0];
      if (!row || row.projectId !== projectId) return null;
      return {
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        slug: row.slug,
        branchId: row.branchId,
        isPreview: row.isPreview ?? false,
        status: row.status ?? 'active',
        createdAt: iso(row.createdAt),
      };
    },
    async remove(id: string, projectId: string): Promise<boolean> {
      if (!db) {
        const rec = envMemory(ctx, projectId).get(id) ?? null;
        if (!rec || rec.projectId !== projectId) return false;
        return envMemory(ctx, projectId).delete(id);
      }
      const rows = await db.delete(projectEnvironments).where(eq(projectEnvironments.id, id)).returning();
      const row = rows[0];
      return !!row && row.projectId === projectId;
    },
  };
  (ctx as unknown as { __envs?: unknown }).__envs = svc;
  return svc;
}

function envMemory(ctx: ApiContext, _projectId: string): Map<string, EnvRecord> {
  const root = (ctx as unknown as { __envMemory?: Map<string, Map<string, EnvRecord>> }).__envMemory ?? new Map();
  (ctx as unknown as { __envMemory?: Map<string, Map<string, EnvRecord>> }).__envMemory = root;
  void _projectId;
  let all = root.get('all');
  if (!all) {
    all = new Map();
    root.set('all', all);
  }
  return all;
}

function memoryEnvs(ctx: ApiContext, projectId: string): EnvRecord[] {
  return [...envMemory(ctx, projectId).values()].filter(e => e.projectId === projectId);
}

export function vaultServiceFor(ctx: ApiContext): VaultStore {
  const existing = (ctx as unknown as { __vault?: VaultStore }).__vault;
  if (existing) return existing;
  let store: VaultStore;
  if (ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb) {
    const db = ctx.controlDb.db;
    store = {
      async put(record) {
        await db
          .insert(projectSecrets)
          .values({
            projectId: record.projectId,
            name: record.name,
            ciphertext: record.ciphertext,
          })
          .onConflictDoUpdate({
            target: [projectSecrets.projectId, projectSecrets.name],
            set: { ciphertext: record.ciphertext, updatedAt: new Date() },
          });
      },
      async get(projectId, name) {
        const rows = await db.select().from(projectSecrets);
        const row = rows.find(r => r.projectId === projectId && r.name === name);
        if (!row) return null;
        return {
          projectId: row.projectId,
          name: row.name,
          ciphertext: row.ciphertext,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
        };
      },
      async list(projectId) {
        const rows = await db.select().from(projectSecrets);
        return rows
          .filter(r => r.projectId === projectId)
          .map(r => ({
            name: r.name,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
            updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async remove(projectId, name) {
        const rows = await db.delete(projectSecrets).returning();
        return rows.some(r => r.projectId === projectId && r.name === name);
      },
    };
  } else {
    store = new MemoryVaultStore();
  }
  (ctx as unknown as { __vault?: VaultStore }).__vault = store;
  return store;
}

function vaultKey(ctx: ApiContext): Buffer {
  if (!ctx.config.VAULT_KEY) {
    throw new ApiError(
      'VAULT_UNCONFIGURED',
      'Vault requires VAULT_KEY (32+ chars) in the server environment',
      503,
    );
  }
  try {
    return vaultKeyFromSecret(ctx.config.VAULT_KEY);
  } catch {
    throw new ApiError('VAULT_UNCONFIGURED', 'VAULT_KEY must be at least 32 characters', 503);
  }
}

function maskBranch(branch: BranchRecord): Omit<BranchRecord, 'dbPassword'> & { dbPassword: string } {
  const { dbPassword: _drop, ...rest } = branch;
  void _drop;
  return { ...rest, dbPassword: branch.dbPassword ? '••••••••' : '' };
}

function branchConn(branch: BranchRecord): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  if (!branch.databaseId || !branch.dbPassword) {
    throw new ApiError('CONFLICT', 'Branch database is not ready yet', 409);
  }
  return {
    host: branch.host,
    port: branch.port,
    database: branch.dbName,
    user: branch.dbUser,
    password: branch.dbPassword,
  };
}

const ExtensionBody = z.object({ name: z.string().min(1).max(64) });
const RestoreBody = z.object({ sql: z.string().min(1).max(2_000_000) });
const BranchBody = z.object({
  name: z.string().min(1).max(40),
  source: z.string().min(1).max(100).optional(),
});
const DiffBody = z.object({
  base: z.string().min(1).max(100).default('main'),
  compare: z.string().min(1).max(100).default('main'),
  includeDrops: z.boolean().default(false),
});
const VaultPutBody = z.object({ value: z.string().min(1).max(65_536) });
const EnvBody = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(63),
  branchId: z.string().uuid().nullable().optional(),
  preview: z.boolean().default(false),
});

/** Resolve 'main' or a branch id to live connection info. */
async function resolveDbConn(
  deps: DbToolsDeps,
  branches: BranchService,
  which: string,
): Promise<{ host: string; port: number; database: string; user: string; password: string }> {
  if (which === 'main') return deps.creds;
  const branch = await branches.storeRef.get(which);
  if (!branch || branch.projectId !== deps.project.id) {
    throw new ApiError('NOT_FOUND', 'Branch not found', 404);
  }
  return branchConn(branch);
}

export async function handleDbToolsRoutes(deps: DbToolsDeps): Promise<boolean> {
  const { req, res, ctx, logger, baseHeaders, requestId, session, project, gate, query, readJson } = deps;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const agent = session.agent ?? null;
  const seg = (n: number): string | null => {
    const m = new RegExp(`^/api/v1/projects/[^/]+/database/([^/]+)(?:/([^/]+)(?:/([^/]+))?)?/?$`).exec(path);
    if (!m) return null;
    return (m[n] ?? null) as string | null;
  };
  const head = seg(1);
  // Migrations own a deeper path shape than seg() matches, so they are
  // dispatched from the raw path before the single-segment table below.
  if (isMigrationRoute(path)) {
    try {
      return await handleMigrationRoutes(deps);
    } catch (err) {
      return fail(deps, err);
    }
  }
  if (!head) return false;

  try {
    // ── Extensions ──
    if (head === 'extensions' && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.extensions' });
      const run = runnerFor(deps);
      const installed = await listExtensions(run).catch(() => []);
      return sendJson(res, 200, ok({ installed, allowlisted: [...EXTENSION_ALLOWLIST] }, requestId), baseHeaders), true;
    }
    if (head === 'extensions' && method === 'POST') {
      const parsed = parseBody(ExtensionBody, await readJson());
      const name = assertExtensionAllowed(parsed.name);
      if (agent) {
        await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.extension.install', resource: name });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      await ctx.gateway.query(deps.creds, `CREATE EXTENSION IF NOT EXISTS "${name}"`, {
        maxStatementMs: 30_000,
        maxRows: 10,
        maxLength: 200,
      });
      await ctx.registry.recordAudit('database.extension.installed', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.extension.installed', { project: project.id, extension: name });
      return sendJson(res, 201, ok({ installed: name }, requestId), baseHeaders), true;
    }

    // ── Advisors / replication / routines / types ──
    if (head === 'advisors' && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.advisors' });
      const findings = await runAllAdvisors(runnerFor(deps));
      return sendJson(res, 200, ok({ findings }, requestId), baseHeaders), true;
    }
    if (head === 'replication' && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.replication' });
      const status = await replicationStatus(runnerFor(deps));
      return sendJson(res, 200, ok(status, requestId), baseHeaders), true;
    }
    if (head === 'routines' && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.routines' });
      const run = runnerFor(deps);
      const [functions, triggers, views] = await Promise.all([
        listFunctions(run).catch(() => []),
        listTriggers(run).catch(() => []),
        listViews(run).catch(() => []),
      ]);
      return sendJson(res, 200, ok({ functions, triggers, views }, requestId), baseHeaders), true;
    }
    if (head === 'types' && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.types' });
      const schema = await ctx.gateway.inspect(deps.creds);
      const prefix = query.get('schemaPrefix') === 'true';
      const types = generateTypescriptTypes({ tables: schema.tables }, { schemaPrefix: prefix });
      return sendJson(res, 200, ok({ types }, requestId), baseHeaders), true;
    }

    // ── Schema diff ──
    if (head === 'diff' && method === 'POST') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.diff' });
      const parsed = parseBody(DiffBody, await readJson());
      const branches = branchServiceFor(ctx);
      const baseName = parsed.base ?? 'main';
      const compareName = parsed.compare ?? 'main';
      const [baseConn, compareConn] = await Promise.all([
        resolveDbConn(deps, branches, baseName),
        resolveDbConn(deps, branches, compareName),
      ]);
      const [baseSchema, compareSchema] = await Promise.all([
        ctx.gateway.inspect(baseConn),
        ctx.gateway.inspect(compareConn),
      ]);
      const toDiff = (s: { tables: { schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean; defaultValue: string | null }[]; primaryKeys: string[] }[] }): DiffSchema => ({
        tables: s.tables.map(t => ({
          schema: t.schema,
          name: t.name,
          columns: t.columns.map(c => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue })),
          primaryKeys: [...t.primaryKeys],
        })),
      });
      const { statements, diff } = renderMigrationPreview(toDiff(baseSchema), toDiff(compareSchema), {
        includeDrops: parsed.includeDrops ?? false,
      });
      return sendJson(res, 200, ok({ base: baseName, compare: compareName, diff, statements }, requestId), baseHeaders), true;
    }

    // ── Guarded restore ──
    if (head === 'restore' && method === 'POST') {      if (agent) {
        await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.restore', resource: 'restore' });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const parsed = parseBody(RestoreBody, await readJson());
      const { statements } = planRestore(parsed.sql);
      const result = await ctx.gateway.execTransaction(deps.creds, statements);
      await ctx.registry.recordAudit('database.restored', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.restored', { project: project.id, statements: result.executed });
      return sendJson(res, 200, ok({ restored: true, ...result }, requestId), baseHeaders), true;
    }

    // ── RLS simulator (EXPLAIN under explicit caller settings) ──
    if (head === 'rls-simulate' && method === 'POST') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.rls.simulate' });
      const parsed = parseBody(
        z.object({
          sql: z.string().min(1).max(20_000),
          userId: z.string().uuid(),
          role: z.enum(['authenticated', 'admin', 'service_role', 'anonymous']),
        }),
        await readJson(),
      );
      const simulation = await ctx.gateway.simulate(deps.creds, {
        sql: parsed.sql,
        userId: parsed.userId,
        role: parsed.role,
      });
      return sendJson(res, 200, ok({ simulation }, requestId), baseHeaders), true;
    }

    // ── Migration assessment (Supabase/RDS/self-hosted compatibility) ──
    if (head === 'migration-assess' && method === 'POST') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.migration.assess' });
      const parsed = parseBody(
        z.object({ sourceUrl: z.string().min(12).max(2000) }),
        await readJson(),
      );
      const report = await assessMigrationSource(parsed.sourceUrl);
      return sendJson(res, 200, ok({ assessment: report }, requestId), baseHeaders), true;
    }

    // ── PostgreSQL import (external URL → project database) ──
    if (head === 'import' && method === 'POST') {      if (agent) {
        await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.import', resource: 'postgres-import' });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const parsed = parseBody(
        z.object({ sourceUrl: z.string().min(12).max(2000) }),
        await readJson(),
      );
      const report = await importFromPostgres({ sourceUrl: parsed.sourceUrl, target: deps.creds });
      await ctx.registry.recordAudit('database.imported', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.imported', {
        project: project.id,
        sourceHost: report.sourceHost,
        tables: report.tables,
        statements: report.executedStatements,
      });
      return sendJson(res, 200, ok({ imported: true, ...report }, requestId), baseHeaders), true;
    }

    // ── Pause / resume (operator states over lifecycle stop/start) ──
    if ((head === 'pause' || head === 'resume') && method === 'POST') {
      if (agent) {
        await gate({ scope: 'projects.update', organizationId: project.organizationId, projectId: project.id, action: `database.${head}`, resource: head });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const main = await ctx.registry.getDatabaseByProject(project.id);
      if (!main) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
      const jobId = await runLifecycleJob(ctx.provider, ctx.jobs, ctx.audit, {
        kind: head === 'pause' ? 'stop' : 'start',
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
        databaseId: main.databaseId,
      });
      await ctx.registry.updateDatabaseStatus(project.id, head === 'pause' ? 'stopped' : 'running');
      await ctx.registry.recordAudit(head === 'pause' ? 'database.paused' : 'database.resumed', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      return sendJson(res, 200, ok({ jobId, status: head === 'pause' ? 'stopped' : 'running' }, requestId), baseHeaders), true;
    }

    // ── Vault (write-only values, metadata lists) ──
    if (head === 'vault' && seg(2) === null && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.vault.list' });
      const items = await vaultServiceFor(ctx).list(project.id);
      return sendJson(res, 200, ok({ secrets: items }, requestId), baseHeaders), true;
    }
    const vaultMatch = /^\/api\/v1\/projects\/[^/]+\/database\/vault\/([^/]+)(\/reveal)?\/?$/.exec(path);
    if (vaultMatch?.[1] && (method === 'PUT' || method === 'DELETE' || (method === 'POST' && vaultMatch[2] === '/reveal'))) {
      const secretName = decodeURIComponent(vaultMatch[1]);
      assertVaultName(secretName);
      if (agent) {
        await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.vault.write', resource: secretName });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const vault = vaultServiceFor(ctx);
      if (method === 'PUT') {
        const parsed = parseBody(VaultPutBody, await readJson());
        const key = vaultKey(ctx);
        const stamp = new Date().toISOString();
        await vault.put({ projectId: project.id, name: secretName, ciphertext: vaultEncrypt(parsed.value, key), createdAt: stamp, updatedAt: stamp });
        await ctx.registry.recordAudit('database.vault.stored', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        return sendJson(res, 200, ok({ stored: secretName }, requestId), baseHeaders), true;
      }
      if (method === 'DELETE') {
        const removed = await vault.remove(project.id, secretName);
        if (!removed) throw new ApiError('NOT_FOUND', 'Secret not found', 404);
        await ctx.registry.recordAudit('database.vault.deleted', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        return sendJson(res, 200, ok({ deleted: secretName }, requestId), baseHeaders), true;
      }
      // POST .../reveal — value returned once, always audited. Agents are
      // denied BEFORE any secret material is touched.
      if (agent) {
        auditAgent(ctx, req, {
          token: agent,
          userId: agent.userId,
          organizationId: project.organizationId,
          projectId: project.id,
          action: 'database.vault.revealed',
          result: 'denied',
          reason: 'FORBIDDEN: agents cannot reveal vault secrets',
        });
        throw new ApiError('FORBIDDEN', 'Agents cannot reveal vault secrets', 403);
      }
      const record = await vault.get(project.id, secretName);
      if (!record) throw new ApiError('NOT_FOUND', 'Secret not found', 404);
      const key = vaultKey(ctx);
      await ctx.registry.recordAudit('database.vault.revealed', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.vault.revealed', { project: project.id });
      return sendJson(res, 200, ok({ name: secretName, value: vaultDecrypt(record.ciphertext, key) }, requestId), baseHeaders), true;
    }

    // ── Branches ──
    if (head === 'branches' && seg(2) === null && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.branches' });
      const branches = await branchServiceFor(ctx).storeRef.listByProject(project.id);
      return sendJson(res, 200, ok({ branches: branches.map(maskBranch) }, requestId), baseHeaders), true;
    }
    if (head === 'branches' && seg(2) === null && method === 'POST') {
      if (agent) {
        await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.branch.create', resource: 'branch' });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const parsed = parseBody(BranchBody, await readJson());
      await requireSpendAllowed(ctx, project.organizationId);
      const branches = branchServiceFor(ctx);
      const main = await ctx.registry.getDatabaseByProject(project.id);
      const cred = await ctx.registry.getCredential(project.id);
      if (!main || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
      let sourceDatabaseId: string | null = null;
      if (parsed.source && parsed.source !== 'main') {
        const src = await branches.storeRef.get(parsed.source);
        if (!src || src.projectId !== project.id || !src.databaseId) {
          throw new ApiError('NOT_FOUND', 'Source branch not found', 404);
        }
        sourceDatabaseId = src.databaseId;
      }
      const projectRec = await ctx.registry.getProject(project.id);
      const { branch, database } = await branches.createBranch({
        projectId: project.id,
        organizationId: project.organizationId,
        name: parsed.name,
        sourceDatabaseId,
        main: {
          databaseId: main.databaseId,
          password: cred.password,
          version: '16',
          region: 'local',
          slug: projectRec?.slug ?? project.id.slice(0, 8),
        },
      });
      void database;
      await ctx.registry.recordAudit('database.branch.created', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.branch.created', { project: project.id, branch: branch.name });
      return sendJson(res, 201, ok({ branch: maskBranch(branch) }, requestId), baseHeaders), true;
    }
    const branchMatch = /^\/api\/v1\/projects\/[^/]+\/database\/branches\/([^/]+)(\/([^/]+))?\/?$/.exec(path);
    if (branchMatch?.[1]) {
      const branches = branchServiceFor(ctx);
      const branchId = decodeURIComponent(branchMatch[1]);
      const verb = branchMatch[3] ?? null;
      const branch = await branches.storeRef.get(branchId);
      if (!branch || branch.projectId !== project.id) {
        throw new ApiError('NOT_FOUND', 'Branch not found', 404);
      }
      if (!verb && method === 'GET') {
        await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.branch' });
        return sendJson(res, 200, ok({ branch: maskBranch(branch) }, requestId), baseHeaders), true;
      }
      if (!verb && method === 'DELETE') {
        if (agent) {
          await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.branch.delete', resource: branch.name });
        } else {
          await requireDbManager(ctx, session.sub, project);
        }
        await branches.deleteBranch(project.id, branchId);
        await ctx.registry.recordAudit('database.branch.deleted', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        return sendJson(res, 200, ok({ deleted: branch.name }, requestId), baseHeaders), true;
      }
      if (verb === 'reset' && method === 'POST') {
        if (agent) {
          await gate({ scope: 'database.destructive', organizationId: project.organizationId, projectId: project.id, action: 'database.branch.reset', resource: branch.name });
        } else {
          await requireDbManager(ctx, session.sub, project);
        }
        const parsed = parseBody(z.object({ password: z.string().min(12).max(128).optional() }), await readJson());
        const main = await ctx.registry.getDatabaseByProject(project.id);
        const cred = await ctx.registry.getCredential(project.id);
        if (!main || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
        const projectRec = await ctx.registry.getProject(project.id);
        const { branch: reset } = await branches.resetBranch(project.id, branchId, {
          password: parsed.password ?? generateDbPassword(),
          main: {
            databaseId: main.databaseId,
            password: cred.password,
            version: '16',
            region: 'local',
            slug: projectRec?.slug ?? project.id.slice(0, 8),
          },
        });
        await ctx.registry.recordAudit('database.branch.reset', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        return sendJson(res, 200, ok({ branch: maskBranch(reset) }, requestId), baseHeaders), true;
      }
      if (verb === 'connection' && method === 'GET') {
        await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.branch.connection' });
        const conn = branchConn(branch);
        if (query.get('reveal') === 'true') {
          if (agent) throw new ApiError('FORBIDDEN', 'Agents cannot reveal database credentials', 403);
          if (!agent) await requireDbManager(ctx, session.sub, project);
          await ctx.registry.recordAudit('database.credentials.accessed', {
            projectId: project.id,
            organizationId: project.organizationId,
            userId: session.sub,
          });
          return sendJson(res, 200, ok({ ...conn, password: conn.password }, requestId), baseHeaders), true;
        }
        return sendJson(res, 200, ok({ ...conn, password: '••••••••' }, requestId), baseHeaders), true;
      }
    }

    // ── Environments ──
    if (head === 'environments' && seg(2) === null && method === 'GET') {
      await gate({ scope: 'database.read', organizationId: project.organizationId, projectId: project.id, action: 'database.environments' });
      const envs = await envServiceFor(ctx).list(project.id);
      return sendJson(res, 200, ok({ environments: envs }, requestId), baseHeaders), true;
    }
    if (head === 'environments' && seg(2) === null && method === 'POST') {
      if (agent) {
        await gate({ scope: 'projects.update', organizationId: project.organizationId, projectId: project.id, action: 'database.environment.create', resource: 'environment' });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      const parsed = parseBody(EnvBody, await readJson());
      let branchId: string | null = parsed.branchId ?? null;
      if (branchId) {
        const branch = await branchServiceFor(ctx).storeRef.get(branchId);
        if (!branch || branch.projectId !== project.id) {
          throw new ApiError('NOT_FOUND', 'Branch not found', 404);
        }
      }
      // Preview environments auto-branch main so they are isolated by default.
      if (parsed.preview && !branchId) {
        const branches = branchServiceFor(ctx);
        const main = await ctx.registry.getDatabaseByProject(project.id);
        const cred = await ctx.registry.getCredential(project.id);
        if (!main || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
        const projectRec = await ctx.registry.getProject(project.id);
        const created = await branches.createBranch({
          projectId: project.id,
          organizationId: project.organizationId,
          name: `preview-${parsed.slug}`.slice(0, 40),
          sourceDatabaseId: null,
          main: {
            databaseId: main.databaseId,
            password: cred.password,
            version: '16',
            region: 'local',
            slug: projectRec?.slug ?? project.id.slice(0, 8),
          },
        });
        branchId = created.branch.id;
      }
      const env = await envServiceFor(ctx).create({
        projectId: project.id,
        name: parsed.name,
        slug: parsed.slug,
        branchId,
        isPreview: parsed.preview,
      });
      await ctx.registry.recordAudit('database.environment.created', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      return sendJson(res, 201, ok({ environment: env }, requestId), baseHeaders), true;
    }
    const envMatch = /^\/api\/v1\/projects\/[^/]+\/database\/environments\/([^/]+)\/?$/.exec(path);
    if (envMatch?.[1] && (method === 'PATCH' || method === 'DELETE')) {
      const envId = decodeURIComponent(envMatch[1]);
      if (agent) {
        await gate({ scope: 'projects.update', organizationId: project.organizationId, projectId: project.id, action: 'database.environment.write', resource: envId.slice(0, 24) });
      } else {
        await requireDbManager(ctx, session.sub, project);
      }
      if (method === 'DELETE') {
        const removed = await envServiceFor(ctx).remove(envId, project.id);
        if (!removed) throw new ApiError('NOT_FOUND', 'Environment not found', 404);
        return sendJson(res, 200, ok({ deleted: true }, requestId), baseHeaders), true;
      }
      const parsed = parseBody(z.object({ branchId: z.string().uuid().nullable() }), await readJson());
      if (parsed.branchId) {
        const branch = await branchServiceFor(ctx).storeRef.get(parsed.branchId);
        if (!branch || branch.projectId !== project.id) {
          throw new ApiError('NOT_FOUND', 'Branch not found', 404);
        }
      }
      const updated = await envServiceFor(ctx).updateBranch(envId, project.id, parsed.branchId);
      if (!updated) throw new ApiError('NOT_FOUND', 'Environment not found', 404);
      return sendJson(res, 200, ok({ environment: updated }, requestId), baseHeaders), true;
    }

    return false;
  } catch (err) {
    return fail(deps, err);
  }
}
