import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import {
  assertSafeSql,
  executeProjectSql,
  inspectProjectSchema,
  maskConnectionInfo,
  SqlRejectedError,
  toConnectionString,
} from '@cloudnivo/database';
import type { DatabaseStatus, SchemaInfo, SqlResult } from '@cloudnivo/database';
import {
  InvalidProvisionInputError,
  ProvisionerError,
  ProviderUnavailableError,
  provisionProjectDatabase,
  runLifecycleJob,
} from '@cloudnivo/provisioning';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import type { ProjectRecord } from './registry.js';
import { generateDbPassword, mustOwnProject, toTenantError } from './registry.js';
import { storageFor } from './storage.js';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

/**
 * Project-database data gateway. Production uses real SQL against the
 * provisioned database; tests inject `FakeGateway` (deterministic samples).
 * The gateway is always called with server-resolved credentials after
 * membership checks — never with client-supplied connection info.
 */
export interface ProjectDbGateway {
  inspect(conn: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }): Promise<SchemaInfo>;
  query(
    conn: { host: string; port: number; database: string; user: string; password: string },
    sql: string,
    guards: { maxStatementMs: number; maxRows: number; maxLength: number },
    params?: unknown[],
  ): Promise<SqlResult>;
}

export const RealProjectDbGateway: ProjectDbGateway = {
  inspect: conn => inspectProjectSchema(conn),
  query: (conn, sql, guards, params) => executeProjectSql(conn, sql, guards, params ?? []),
};

export class FakeProjectDbGateway implements ProjectDbGateway {
  async inspect(): Promise<SchemaInfo> {
    return {
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
            { name: 'email', dataType: 'character varying', nullable: false, defaultValue: null },
          ],
          primaryKeys: ['id'],
          indexes: [{ name: 'users_pkey', definition: 'PRIMARY KEY (id)' }],
        },
      ],
      foreignKeys: [],
    };
  }

  async query(
    _conn: { host: string; port: number; database: string; user: string; password: string },
    sql: string,
  ): Promise<SqlResult> {
    const start = Date.now();
    if (/^\s*select/i.test(sql)) {
      return {
        columns: ['id'],
        rows: [{ id: 1 }],
        rowCount: 1,
        truncated: false,
        durationMs: Date.now() - start,
      };
    }
    return { columns: [], rows: [], rowCount: 1, truncated: false, durationMs: Date.now() - start };
  }
}

const CreateProjectBody = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  organizationId: z.string().uuid(),
  region: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default('local'),
  password: z.string().min(12).max(128).optional(),
});

const CreateOrgBody = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

const ActionBody = z.object({ action: z.enum(['start', 'stop', 'restart']) });
const QueryBody = z.object({ sql: z.string().min(1).max(20_000) });

function mapInfraError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof InvalidProvisionInputError || err instanceof SqlRejectedError) {
    return new ApiError('VALIDATION_ERROR', err.message, 400);
  }
  if (err instanceof ProviderUnavailableError) {
    return new ApiError('INFRA_UNAVAILABLE', 'Database infrastructure is unavailable', 503);
  }
  if (err instanceof ProvisionerError) {
    return new ApiError('PROVISION_FAILED', 'Database operation failed', 502);
  }
  const tenant = toTenantError(err);
  if (tenant) return tenant;
  throw err;
}

function idempotencyKey(header: string | string[] | undefined, fallback: string): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw && /^[A-Za-z0-9_-]{1,128}$/.test(raw)) return raw;
  return fallback;
}

async function credsFor(
  ctx: ApiContext,
  project: ProjectRecord,
): Promise<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}> {
  const db = await ctx.registry.getDatabaseByProject(project.id);
  const cred = await ctx.registry.getCredential(project.id);
  if (!db || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
  return {
    host: db.host,
    port: db.port,
    database: db.dbName,
    user: cred.dbUser,
    password: cred.password,
  };
}

function statementType(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? 'UNKNOWN';
}

export async function handleProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  config: AppConfig,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  session: { sub: string; email: string; org?: string },
  parts: string[],
  query: URLSearchParams,
  readJson: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, ...rest] = parts;

  // POST /api/v1/projects — create project + enqueue provisioning (202).
  if (parts.length === 0 && req.method === 'POST') {
    try {
      const body = parseBody(CreateProjectBody, await readJson());
      if ((await ctx.registry.countDatabases()) >= config.PROVISION_MAX_DATABASES) {
        throw new ApiError('LIMIT_EXCEEDED', 'Maximum number of databases reached', 403);
      }
      // Plan quota: project count is a gauge limit (free=3, pro=15, ...).
      // Enforced here so the plan catalog is real — upgrade to raise it.
      try {
        const owned = await ctx.registry.listProjects(session.sub);
        const used = owned.filter(p => p.organizationId === body.organizationId).length;
        const quota = await ctx.billing.checkLimit(
          body.organizationId,
          'api',
          'projects',
          used,
          1,
          'hard',
        );
        if (!quota.allowed) {
          throw new ApiError(
            'LIMIT_EXCEEDED',
            `Project limit reached for this plan (used ${quota.check?.used ?? used} of ${quota.check?.limit ?? '?'}). Upgrade to create more.`,
            403,
          );
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'LIMIT_EXCEEDED') throw err;
        // Billing must never wedge provisioning on transient errors — log and allow.
        logger.warn('projects.billing_check_failed', {
          error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
        });
      }
      const key = idempotencyKey(
        req.headers['idempotency-key'],
        `create-project:${body.organizationId}:${body.slug}`,
      );
      // Double submit with the same key returns the live job — checked BEFORE
      // any writes, so no duplicate project or database can ever be created.
      const preexisting = await ctx.jobs.findByKey(body.organizationId, key);
      if (preexisting && preexisting.status !== 'failed') {
        const peer = await ctx.registry.getProject(preexisting.projectId);
        if (peer) {
          try {
            await mustOwnProject(ctx.registry, session.sub, peer.id);
            logger.info('projects.create.deduplicated', { project: peer.id });
            sendJson(
              res,
              202,
              ok({ project: peer, jobId: preexisting.id, database: null }, requestId),
              baseHeaders,
            );
            return true;
          } catch {
            // Not a member of the key's org: fall through to the normal path,
            // which 403s on membership without revealing anything.
          }
        }
      }
      const project = await ctx.registry.createProject({
        userId: session.sub,
        organizationId: body.organizationId,
        name: body.name,
        slug: body.slug,
        region: body.region ?? 'local',
      });
      await ctx.registry.recordAudit('project.created', {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
      });
      const password = body.password ?? generateDbPassword();
      const provisionInput = {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: session.sub,
        slug: project.slug,
        password,
        version: '16',
        region: project.region,
        idempotencyKey: key,
      };
      // Job-based: respond 202 immediately, process in background.
      const job = await ctx.jobs.create({
        projectId: project.id,
        organizationId: project.organizationId,
        kind: 'provision',
        status: 'pending',
        idempotencyKey: key,
        attempts: 0,
        maxAttempts: config.PROVISION_MAX_ATTEMPTS,
        lastError: null,
        logs: [],
      });
      void (async () => {
        try {
          const result = await provisionProjectDatabase(
            ctx.provider,
            ctx.jobs,
            ctx.audit,
            provisionInput,
            {
              maxAttempts: config.PROVISION_MAX_ATTEMPTS,
              sleep: () => Promise.resolve(),
              resumeJobId: job.id,
            },
          );
          if (result.database) {
            await ctx.registry.saveDatabase({
              projectId: project.id,
              organizationId: project.organizationId,
              databaseId: result.database.databaseId,
              host: result.database.host,
              port: result.database.port,
              dbName: result.database.dbName,
              dbUser: result.database.dbUser,
              version: result.database.version,
              region: project.region,
              status: 'ready',
            });
            await ctx.registry.saveCredential(project.id, result.database.dbUser, password);
          }
        } catch {
          // Job record + audit already reflect the failure; never leak here.
        }
      })();
      logger.info('projects.create.accepted', { project: project.id });
      sendJson(res, 202, ok({ project, jobId: job.id, database: null }, requestId), baseHeaders);
    } catch (err) {
      const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
      sendJson(res, status, body, baseHeaders);
    }
    return true;
  }

  // GET /api/v1/projects — tenant-scoped list with live database state.
  if (parts.length === 0 && req.method === 'GET') {
    const projects = await ctx.registry.listProjects(session.sub);
    // Single batched read (2 queries on durable stores, not 2N).
    const stored = await ctx.registry.listProjectDatabases(projects.map(p => p.id));
    const byProject = new Map(stored.map(s => [s.projectId, s]));
    const items = await Promise.all(
      projects.map(async p => {
        const entry = byProject.get(p.id);
        const db = entry?.db ?? null;
        if (!db) return { ...p, database: null };
        try {
          const cred = entry?.cred ?? null;
          const live = cred
            ? await ctx.provider.getStatus(db.databaseId, {
                host: db.host,
                port: db.port,
                database: db.dbName,
                user: cred.dbUser,
                password: cred.password,
              })
            : null;
          return { ...p, database: { ...db, health: live?.health ?? 'unavailable' } };
        } catch {
          return { ...p, database: { ...db, health: 'unavailable' as const } };
        }
      }),
    );
    logger.info('projects.list', { user: session.sub });
    sendJson(res, 200, ok({ projects: items, user: session.sub }, requestId), baseHeaders);
    return true;
  }

  if (!projectId || projectId === '') return false;

  try {
    const project = await mustOwnProject(ctx.registry, session.sub, projectId);

    // GET /api/v1/projects/:id
    if (rest.length === 0 && req.method === 'GET') {
      const db = await ctx.registry.getDatabaseByProject(project.id);
      const jobs = await ctx.jobs.listByProject(project.id);
      sendJson(
        res,
        200,
        ok({ project, database: db, job: jobs[0] ?? null }, requestId),
        baseHeaders,
      );
      return true;
    }

    // DELETE /api/v1/projects/:id — delete infra first, then metadata.
    if (rest.length === 0 && req.method === 'DELETE') {
      const db = await ctx.registry.getDatabaseByProject(project.id);
      let jobId: string | null = null;
      if (db && db.status !== 'deleted') {
        try {
          jobId = await runLifecycleJob(ctx.provider, ctx.jobs, ctx.audit, {
            kind: 'delete',
            projectId: project.id,
            organizationId: project.organizationId,
            userId: session.sub,
            databaseId: db.databaseId,
          });
        } catch (err) {
          const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
          logger.warn('projects.delete.infra_failed', { project: project.id });
          sendJson(res, status, body, baseHeaders);
          return true;
        }
      }
      await ctx.registry.deleteProject(project.id);
      try {
        await storageFor(ctx).deleteProjectData(project.id);
      } catch (err) {
        logger.warn('projects.delete.storage_cleanup_failed', {
          project: project.id,
          error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
        });
      }
      logger.info('projects.delete', { project: project.id });
      sendJson(res, 200, ok({ deleted: true, jobId }, requestId), baseHeaders);
      return true;
    }

    // GET /:id/jobs, GET /:id/jobs/:jobId
    if (rest[0] === 'jobs' && req.method === 'GET') {
      if (rest.length === 1) {
        sendJson(
          res,
          200,
          ok({ jobs: await ctx.jobs.listByProject(project.id) }, requestId),
          baseHeaders,
        );
        return true;
      }
      if (rest.length === 2 && rest[1]) {
        const job = await ctx.jobs.findById(rest[1]);
        if (!job || job.projectId !== project.id) {
          throw new ApiError('NOT_FOUND', 'Job not found', 404);
        }
        sendJson(res, 200, ok({ job }, requestId), baseHeaders);
        return true;
      }
      return false;
    }

    if (rest[0] !== 'database') return false;
    const db = await ctx.registry.getDatabaseByProject(project.id);
    if (!db) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);

    // GET /:id/database — overview with REAL live status.
    if (rest.length === 1 && req.method === 'GET') {
      try {
        const cred = await ctx.registry.getCredential(project.id);
        const live = cred
          ? await ctx.provider.getStatus(db.databaseId, {
              host: db.host,
              port: db.port,
              database: db.dbName,
              user: cred.dbUser,
              password: cred.password,
            })
          : null;
        if (live && live.status !== db.status) {
          await ctx.registry.updateDatabaseStatus(project.id, live.status as DatabaseStatus);
        }
        sendJson(
          res,
          200,
          ok(
            {
              database: {
                ...(live && live.status !== db.status ? { ...db, status: live.status } : db),
              },
              health: live?.health ?? 'unavailable',
            },
            requestId,
          ),
          baseHeaders,
        );
      } catch (err) {
        const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
        sendJson(res, status, body, baseHeaders);
      }
      return true;
    }

    // GET /:id/database/connection[?reveal=true] — masked by default.
    if (rest.length === 2 && rest[1] === 'connection' && req.method === 'GET') {
      const creds = await credsFor(ctx, project);
      if (query.get('reveal') === 'true') {
        await ctx.registry.recordAudit('database.credentials.accessed', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        ctx.audit.record('database.credentials.accessed', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        logger.info('database.credentials.revealed', { project: project.id });
        sendJson(
          res,
          200,
          ok(
            {
              host: creds.host,
              port: creds.port,
              database: creds.database,
              user: creds.user,
              password: creds.password,
              connectionString: toConnectionString(creds),
            },
            requestId,
          ),
          baseHeaders,
        );
      } else {
        const masked = maskConnectionInfo(creds);
        sendJson(
          res,
          200,
          ok(
            {
              ...masked,
              connectionString: `postgres://${encodeURIComponent(creds.user)}:•••@${creds.host}:${creds.port}/${encodeURIComponent(creds.database)}`,
            },
            requestId,
          ),
          baseHeaders,
        );
      }
      return true;
    }

    // POST /:id/database/actions { action: start|stop|restart }
    if (rest.length === 2 && rest[1] === 'actions' && req.method === 'POST') {
      try {
        const body = parseBody(ActionBody, await readJson());
        const jobId = await runLifecycleJob(ctx.provider, ctx.jobs, ctx.audit, {
          kind: body.action,
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
          databaseId: db.databaseId,
        });
        const next: DatabaseStatus =
          body.action === 'stop' ? 'stopped' : body.action === 'start' ? 'running' : 'ready';
        await ctx.registry.updateDatabaseStatus(project.id, next);
        sendJson(res, 200, ok({ jobId, status: next }, requestId), baseHeaders);
      } catch (err) {
        const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
        sendJson(res, status, body, baseHeaders);
      }
      return true;
    }

    // GET /:id/database/schema — real information_schema inspection.
    if (rest.length === 2 && rest[1] === 'schema' && req.method === 'GET') {
      try {
        const schema = await ctx.gateway.inspect(await credsFor(ctx, project));
        sendJson(res, 200, ok(schema, requestId), baseHeaders);
      } catch (err) {
        const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
        sendJson(res, status, body, baseHeaders);
      }
      return true;
    }

    // POST /:id/database/query — guarded SQL execution.
    if (rest.length === 2 && rest[1] === 'query' && req.method === 'POST') {
      try {
        const body = parseBody(QueryBody, await readJson());
        // Guards enforced at the boundary for every gateway (defense in depth).
        assertSafeSql(body.sql, 20_000);
        const result = await ctx.gateway.query(await credsFor(ctx, project), body.sql, {
          maxStatementMs: config.PROVISION_MAX_SQL_MS,
          maxRows: config.PROVISION_MAX_SQL_ROWS,
          maxLength: 20_000,
        });
        await ctx.registry.recordAudit('database.query.executed', {
          projectId: project.id,
          organizationId: project.organizationId,
          userId: session.sub,
        });
        logger.info('database.query', {
          project: project.id,
          type: statementType(body.sql),
          durationMs: result.durationMs,
          rows: result.rowCount,
        });
        sendJson(res, 200, ok(result, requestId), baseHeaders);
      } catch (err) {
        const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
        sendJson(res, status, body, baseHeaders);
      }
      return true;
    }

    // GET /:id/database/metrics — real pg statistics.
    if (rest.length === 2 && rest[1] === 'metrics' && req.method === 'GET') {
      try {
        const metrics = await ctx.provider.getMetrics(await credsFor(ctx, project));
        sendJson(res, 200, ok(metrics, requestId), baseHeaders);
      } catch (err) {
        const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
        sendJson(res, status, body, baseHeaders);
      }
      return true;
    }

    return false;
  } catch (err) {
    const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
    sendJson(res, status, body, baseHeaders);
    return true;
  }
}

/** Organization endpoints (E2E chain: account → org → project). */
export async function handleOrgRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  session: { sub: string; email: string; org?: string },
  readJson: () => Promise<unknown>,
): Promise<boolean> {
  if (req.method === 'POST') {
    try {
      const body = parseBody(CreateOrgBody, await readJson());
      const { org } = await ctx.registry.createOrganization(session.sub, body.name, body.slug);
      logger.info('orgs.create', { org: org.id });
      sendJson(res, 201, ok({ organization: org }, requestId), baseHeaders);
    } catch (err) {
      const { status, body } = toPublicError(mapInfraErrorCaught(err), requestId);
      sendJson(res, status, body, baseHeaders);
    }
    return true;
  }
  if (req.method === 'GET') {
    sendJson(
      res,
      200,
      ok({ organizations: await ctx.registry.listOrganizations(session.sub) }, requestId),
      baseHeaders,
    );
    return true;
  }
  return false;
}

function mapInfraErrorCaught(err: unknown): ApiError | unknown {
  try {
    return mapInfraError(err);
  } catch {
    return err;
  }
}
