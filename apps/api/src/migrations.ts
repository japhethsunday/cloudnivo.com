import { z } from 'zod';
import { ApiError, ok, parseBody } from '@cloudnivo/api-core';
import { projectMigrations } from '@cloudnivo/database';
import { and, eq } from 'drizzle-orm';
import {
  assertMigrationName,
  migrationChecksum,
  planMigration,
  schemaFingerprint,
  type MigrationFinding,
} from '@cloudnivo/db-tools';
import { requireDbManager, type DbToolsDeps } from './db-tools.js';
import { sendJson } from './projects.js';
import { gateDestructive, sendApprovalRequired } from './agents.js';

/**
 * Migration workflow (`/api/v1/projects/:id/database/migrations`).
 *
 * The professional loop an agent is expected to run:
 *
 *   create  → statements validated, destructive operations detected,
 *             checksum pinned. NOTHING is executed.
 *   preview → what the migration would do against the live schema, still
 *             without executing.
 *   apply   → one transaction, checksum re-verified, destructive work held
 *             for human approval (428) unless the token carries the
 *             destructive scope. State recorded either way.
 *
 * Human callers are gated by organization role (owner/admin), the same rule
 * the rest of the database plane uses — `gate()` is a no-op for sessions, so
 * without this a viewer-role member could apply schema changes.
 *
 * Production is protected twice: a destructive migration targeting a
 * production environment ALWAYS needs an approval, even for a token holding
 * `database.destructive`, because "the token was over-granted" is exactly
 * the failure this gate exists to survive.
 */

export const MIGRATION_ENVIRONMENTS = ['development', 'staging', 'preview', 'production'] as const;
export type MigrationEnvironment = (typeof MIGRATION_ENVIRONMENTS)[number];

interface MigrationRow {
  id: string;
  projectId: string;
  organizationId: string;
  version: number;
  name: string;
  environment: string;
  target: string;
  statements: string[];
  checksum: string;
  status: string;
  destructive: boolean;
  findings: MigrationFinding[];
  appliedBy: string | null;
  appliedByTokenId: string | null;
  appliedAt: string | null;
  schemaAfter: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Store. Drizzle when the control plane is durable, memory otherwise —
 * the same pattern every other plane in this API uses, so tests and the
 * fake driver need no database.
 */
export interface MigrationStore {
  list(projectId: string): Promise<MigrationRow[]>;
  get(projectId: string, id: string): Promise<MigrationRow | null>;
  nextVersion(projectId: string): Promise<number>;
  insert(row: Omit<MigrationRow, 'createdAt' | 'updatedAt'>): Promise<MigrationRow>;
  update(id: string, patch: Partial<MigrationRow>): Promise<MigrationRow | null>;
  remove(projectId: string, id: string): Promise<boolean>;
}

class MemoryMigrationStore implements MigrationStore {
  private readonly rows = new Map<string, MigrationRow>();

  async list(projectId: string): Promise<MigrationRow[]> {
    return [...this.rows.values()]
      .filter(r => r.projectId === projectId)
      .sort((a, b) => a.version - b.version);
  }
  async get(projectId: string, id: string): Promise<MigrationRow | null> {
    const row = this.rows.get(id);
    return row && row.projectId === projectId ? row : null;
  }
  async nextVersion(projectId: string): Promise<number> {
    const rows = await this.list(projectId);
    return (rows.at(-1)?.version ?? 0) + 1;
  }
  async insert(row: Omit<MigrationRow, 'createdAt' | 'updatedAt'>): Promise<MigrationRow> {
    const stamp = new Date().toISOString();
    const full: MigrationRow = { ...row, createdAt: stamp, updatedAt: stamp };
    this.rows.set(full.id, full);
    return full;
  }
  async update(id: string, patch: Partial<MigrationRow>): Promise<MigrationRow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return next;
  }
  async remove(projectId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.projectId !== projectId) return false;
    this.rows.delete(id);
    return true;
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

type DrizzleDb = NonNullable<DbToolsDeps['ctx']['controlDb']>['db'];

class DrizzleMigrationStore implements MigrationStore {
  constructor(private readonly db: DrizzleDb) {}

  private toRow(r: typeof projectMigrations.$inferSelect): MigrationRow {
    return {
      id: r.id,
      projectId: r.projectId,
      organizationId: r.organizationId,
      version: r.version,
      name: r.name,
      environment: r.environment,
      target: r.target,
      statements: r.statements ?? [],
      checksum: r.checksum,
      status: r.status,
      destructive: r.destructive,
      findings: (r.findings ?? []) as MigrationFinding[],
      appliedBy: r.appliedBy ?? null,
      appliedByTokenId: r.appliedByTokenId ?? null,
      appliedAt: isoOrNull(r.appliedAt),
      schemaAfter: r.schemaAfter ?? null,
      error: r.error ?? null,
      createdBy: r.createdBy ?? null,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  async list(projectId: string): Promise<MigrationRow[]> {
    const rows = await this.db
      .select()
      .from(projectMigrations)
      .where(eq(projectMigrations.projectId, projectId));
    return rows.map(r => this.toRow(r)).sort((a, b) => a.version - b.version);
  }
  async get(projectId: string, id: string): Promise<MigrationRow | null> {
    const rows = await this.db
      .select()
      .from(projectMigrations)
      .where(and(eq(projectMigrations.projectId, projectId), eq(projectMigrations.id, id)));
    const row = rows[0];
    return row ? this.toRow(row) : null;
  }
  async nextVersion(projectId: string): Promise<number> {
    const rows = await this.list(projectId);
    return (rows.at(-1)?.version ?? 0) + 1;
  }
  async insert(row: Omit<MigrationRow, 'createdAt' | 'updatedAt'>): Promise<MigrationRow> {
    const inserted = await this.db
      .insert(projectMigrations)
      .values({
        id: row.id,
        projectId: row.projectId,
        organizationId: row.organizationId,
        version: row.version,
        name: row.name,
        environment: row.environment,
        target: row.target,
        statements: row.statements,
        checksum: row.checksum,
        status: row.status,
        destructive: row.destructive,
        findings: row.findings,
        createdBy: row.createdBy,
      })
      .returning();
    const first = inserted[0];
    if (!first) throw new ApiError('INTERNAL', 'Migration was not recorded', 500);
    return this.toRow(first);
  }
  async update(id: string, patch: Partial<MigrationRow>): Promise<MigrationRow | null> {
    const updated = await this.db
      .update(projectMigrations)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.appliedBy !== undefined ? { appliedBy: patch.appliedBy } : {}),
        ...(patch.appliedByTokenId !== undefined ? { appliedByTokenId: patch.appliedByTokenId } : {}),
        ...(patch.appliedAt !== undefined
          ? { appliedAt: patch.appliedAt ? new Date(patch.appliedAt) : null }
          : {}),
        ...(patch.schemaAfter !== undefined ? { schemaAfter: patch.schemaAfter } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projectMigrations.id, id))
      .returning();
    const first = updated[0];
    return first ? this.toRow(first) : null;
  }
  async remove(projectId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(projectMigrations)
      .where(and(eq(projectMigrations.projectId, projectId), eq(projectMigrations.id, id)))
      .returning();
    return removed.length > 0;
  }
}

export function migrationStoreFor(ctx: DbToolsDeps['ctx']): MigrationStore {
  const holder = ctx as unknown as { __migrations?: MigrationStore };
  if (holder.__migrations) return holder.__migrations;
  const store =
    ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb
      ? new DrizzleMigrationStore(ctx.controlDb.db)
      : new MemoryMigrationStore();
  holder.__migrations = store;
  return store;
}

const CreateMigrationBody = z.object({
  name: z.string().min(2).max(120),
  sql: z.string().min(1).max(1_000_000),
  environment: z.enum(MIGRATION_ENVIRONMENTS).default('development'),
  target: z.string().min(1).max(100).default('main'),
});

const ApplyMigrationBody = z
  .object({
    /** Re-sent by the caller so a changed migration cannot be applied blind. */
    checksum: z.string().length(64).optional(),
  })
  .default({});

/**
 * Migration rows are already organization-scoped and the caller is already a
 * verified member, so the whole row is safe to serve — including who applied
 * it, which is the point of a migration trail. No SQL is withheld either:
 * the statements are what the caller is being asked to approve.
 */
function expose(row: MigrationRow): MigrationRow {
  return row;
}

export function isMigrationRoute(path: string): boolean {
  return /^\/api\/v1\/projects\/[^/]+\/database\/migrations(\/|$)/.test(path);
}

/**
 * Handles every `/database/migrations…` route. Returns false when the path
 * is not a migration route, so the caller can keep matching.
 */
export async function handleMigrationRoutes(deps: DbToolsDeps): Promise<boolean> {
  const { req, res, ctx, logger, baseHeaders, requestId, session, project, gate } = deps;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/api\/v1\/projects\/[^/]+\/database\/migrations(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const migrationId = match[1] ?? null;
  const verb = match[2] ?? null;
  const agent = session.agent ?? null;
  const store = migrationStoreFor(ctx);

  // ── List ──
  if (!migrationId && method === 'GET') {
    await gate({
      scope: 'database.read',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migrations.list',
    });
    const rows = await store.list(project.id);
    const applied = rows.filter(r => r.status === 'applied');
    sendJson(
      res,
      200,
      ok(
        {
          migrations: rows.map(expose),
          state: {
            appliedVersion: applied.at(-1)?.version ?? 0,
            pending: rows.filter(r => r.status === 'pending').length,
            failed: rows.filter(r => r.status === 'failed').length,
          },
        },
        requestId,
      ),
      baseHeaders,
    );
    return true;
  }

  // ── Create (validate only — never executes) ──
  if (!migrationId && method === 'POST') {
    if (!agent) await requireDbManager(ctx, session.sub, project);
    await gate({
      scope: 'database.migrate',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.create',
    });
    const parsed = parseBody(CreateMigrationBody, await deps.readJson());
    const name = assertMigrationName(parsed.name);
    const plan = planMigration(parsed.sql);
    const version = await store.nextVersion(project.id);
    const row = await store.insert({
      id: crypto.randomUUID(),
      projectId: project.id,
      organizationId: project.organizationId,
      version,
      name,
      environment: parsed.environment ?? 'development',
      target: parsed.target ?? 'main',
      statements: plan.statements,
      checksum: plan.checksum,
      status: 'pending',
      destructive: plan.destructive,
      findings: plan.findings,
      appliedBy: null,
      appliedByTokenId: null,
      appliedAt: null,
      schemaAfter: null,
      error: null,
      createdBy: agent ? null : session.sub,
    });
    await ctx.registry.recordAudit('database.migration.created', {
      projectId: project.id,
      organizationId: project.organizationId,
      userId: session.sub,
    });
    logger.info('database.migration.created', {
      project: project.id,
      version,
      destructive: plan.destructive,
      statements: plan.statements.length,
    });
    sendJson(
      res,
      201,
      ok(
        {
          migration: expose(row),
          nextStep: plan.destructive
            ? `Destructive migration. Preview it, then POST .../migrations/${row.id}/apply — a human approval is required in production.`
            : `POST .../migrations/${row.id}/apply to run it.`,
        },
        requestId,
      ),
      baseHeaders,
    );
    return true;
  }

  if (!migrationId) return false;

  const row = await store.get(project.id, migrationId);
  if (!row) throw new ApiError('NOT_FOUND', 'Migration not found', 404);

  // ── Detail ──
  if (!verb && method === 'GET') {
    await gate({
      scope: 'database.read',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.get',
    });
    sendJson(res, 200, ok({ migration: expose(row) }, requestId), baseHeaders);
    return true;
  }

  // ── Discard a pending migration ──
  if (!verb && method === 'DELETE') {
    if (!agent) await requireDbManager(ctx, session.sub, project);
    await gate({
      scope: 'database.migrate',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.discard',
      resource: row.name,
    });
    if (row.status === 'applied') {
      throw new ApiError(
        'CONFLICT',
        'An applied migration cannot be discarded — write a forward migration that reverses it',
        409,
      );
    }
    await store.remove(project.id, migrationId);
    await ctx.registry.recordAudit('database.migration.discarded', {
      projectId: project.id,
      organizationId: project.organizationId,
      userId: session.sub,
    });
    sendJson(res, 200, ok({ discarded: row.name }, requestId), baseHeaders);
    return true;
  }

  // ── Preview (reads the live schema; executes nothing) ──
  if (verb === 'preview' && method === 'POST') {
    await gate({
      scope: 'database.read',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.preview',
    });
    const before = await ctx.gateway.inspect(deps.creds);
    const tables = before.tables.map(t => ({ qualified: `${t.schema}.${t.name}`, name: t.name }));
    // Which EXISTING tables the statements name. Word-boundary matching, so
    // `posts` does not match `posts_archive`; a table the migration creates
    // is absent by definition and simply does not appear here.
    const sql = row.statements.join('\n').toLowerCase();
    const touched = tables
      .filter(t => new RegExp(`\\b${t.name.toLowerCase().replace(/[^a-z0-9_]/g, '')}\\b`).test(sql))
      .map(t => t.qualified);
    sendJson(
      res,
      200,
      ok(
        {
          migration: expose(row),
          preview: {
            statements: row.statements,
            destructive: row.destructive,
            findings: row.findings,
            existingTables: tables,
            tablesReferenced: [...new Set(touched)],
            schemaBefore: schemaFingerprint(before),
            approvalRequired: approvalNeeded(row, agent !== null),
          },
        },
        requestId,
      ),
      baseHeaders,
    );
    return true;
  }

  // ── Apply (one transaction, checksum verified, approval gated) ──
  if (verb === 'apply' && method === 'POST') {
      const parsed = parseBody(ApplyMigrationBody, await deps.readJson()) ?? {};
    if (!agent) await requireDbManager(ctx, session.sub, project);
    await gate({
      scope: 'database.migrate',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.apply',
      resource: row.name,
    });
    if (row.status === 'applied') {
      throw new ApiError('CONFLICT', `Migration ${row.version} is already applied`, 409);
    }
    if (row.status === 'discarded') {
      throw new ApiError('CONFLICT', 'This migration was discarded — create a new one', 409);
    }
    // Nothing may be applied out of order: an agent that skips a pending
    // migration leaves the recorded state describing a schema that never
    // existed.
    const all = await store.list(project.id);
    const earlierPending = all.find(
      m => m.version < row.version && m.status === 'pending' && m.id !== row.id,
    );
    if (earlierPending) {
      throw new ApiError(
        'CONFLICT',
        `Migration ${earlierPending.version} (${earlierPending.name}) is still pending — apply migrations in order`,
        409,
      );
    }
    // The reviewed SQL is the SQL that runs. A checksum mismatch means the
    // stored statements are not what the caller reviewed.
    const live = migrationChecksum(row.statements);
    if (live !== row.checksum || (parsed.checksum && parsed.checksum !== row.checksum)) {
      throw new ApiError(
        'CONFLICT',
        'Migration checksum does not match the reviewed version — re-read the migration before applying',
        409,
      );
    }

    // Destructive work, and ANY work against production, goes through the
    // approval gate for agents. A human session still needs org admin,
    // enforced by the caller's project membership check plus the scope gate.
    if (agent && approvalNeeded(row, true)) {
      const decision = await gateDestructive(ctx, req, {
        agent,
        scope: 'database.destructive',
        action: `database.migration.apply:${row.environment}`,
        organizationId: project.organizationId,
        projectId: project.id,
        method,
        path: url.pathname,
        body: { checksum: row.checksum },
        resource: `${row.version}_${row.name}`,
        // Production is never waved through on scope alone.
        alwaysApprove: row.environment === 'production',
      });
      if (!decision.proceed) {
        sendApprovalRequired(res, baseHeaders, requestId, decision.approval);
        return true;
      }
    }

    try {
      const result = await ctx.gateway.execTransaction(deps.creds, row.statements);
      const after = await ctx.gateway.inspect(deps.creds).catch(() => null);
      const applied = await store.update(row.id, {
        status: 'applied',
        appliedBy: agent ? null : session.sub,
        appliedByTokenId: agent ? agent.id : null,
        appliedAt: new Date().toISOString(),
        schemaAfter: after ? schemaFingerprint(after) : null,
        error: null,
      });
      await ctx.registry.recordAudit('database.migration.applied', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.info('database.migration.applied', {
        project: project.id,
        version: row.version,
        statements: result.executed,
        durationMs: result.durationMs,
      });
      sendJson(
        res,
        200,
        ok(
          {
            migration: applied ? expose(applied) : expose(row),
            applied: true,
            statements: result.executed,
            durationMs: result.durationMs,
            verified: after !== null,
          },
          requestId,
        ),
        baseHeaders,
      );
      return true;
    } catch (err) {
      // The transaction rolled back, so the database is unchanged — but the
      // attempt is recorded, because a failed migration an agent cannot see
      // is a migration it will retry forever.
      const message = err instanceof Error ? err.message.slice(0, 500) : 'Migration failed';
      await store.update(row.id, { status: 'failed', error: message });
      await ctx.registry.recordAudit('database.migration.failed', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      logger.warn('database.migration.failed', { project: project.id, version: row.version });
      throw new ApiError(
        'MIGRATION_FAILED',
        `Migration ${row.version} failed and rolled back: ${message}`,
        400,
      );
    }
  }

  // ── Retry a failed migration (back to pending) ──
  if (verb === 'reset' && method === 'POST') {
    if (!agent) await requireDbManager(ctx, session.sub, project);
    await gate({
      scope: 'database.migrate',
      organizationId: project.organizationId,
      projectId: project.id,
      action: 'database.migration.reset',
      resource: row.name,
    });
    if (row.status !== 'failed') {
      throw new ApiError('CONFLICT', 'Only a failed migration can be reset to pending', 409);
    }
    const reset = await store.update(row.id, { status: 'pending', error: null });
    sendJson(res, 200, ok({ migration: reset ? expose(reset) : expose(row) }, requestId), baseHeaders);
    return true;
  }

  return false;
}

/**
 * Production protection: destructive migrations always need approval, and
 * production needs it whether or not the migration is destructive. An
 * over-granted token is the case this exists to survive.
 */
export function approvalNeeded(
  row: { destructive: boolean; environment: string },
  isAgent: boolean,
): boolean {
  if (!isAgent) return false;
  return row.destructive || row.environment === 'production';
}
