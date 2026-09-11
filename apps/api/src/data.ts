import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import { decodeCustomerToken } from '@cloudnivo/auth';
import {
  can,
  inspectProjectSchema,
  queryProjectDb,
  type ProjectConnectionInfo,
  type SchemaInfo,
} from '@cloudnivo/database';
import {
  CachingIntrospectionService,
  DataEngine,
  KeyError,
  buildOpenApiDoc,
  issueKey,
  keyCanWrite,
  verifyKey,
  type IssuedKey,
  type KeyRole,
  type ProjectApiKey,
} from '@cloudnivo/api-engine';
import { storageOpenApiPaths } from '@cloudnivo/storage';
import { realtimeOpenApiPaths } from '@cloudnivo/realtime';
import { functionsOpenApiPaths } from '@cloudnivo/functions';
import { aiOpenApiPaths } from '@cloudnivo/ai';
import { billingOpenApiPaths } from '@cloudnivo/billing';
import { agentsOpenApiPaths } from '@cloudnivo/agents';
import type { AgentToken } from '@cloudnivo/agents';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import type { ProjectRecord } from './registry.js';
import { mustOwnProject } from './registry.js';
import { verifyCustomerCaller } from './customer-auth.js';
import { agentFromRequest, auditAgent, requireAgentScope, verifyAgentAccess } from './agents.js';
import { sendJson } from './projects.js';

/**
 * Customer data plane: dynamic per-table REST over provisioned Postgres.
 *
 * URL shape (spec): /api/v1/projects/:projectId/:table[/:rowId]
 * Reserved second segments (`database`, `jobs`) stay with the control
 * handlers; `keys` + `openapi.json` and everything else table-shaped lands
 * here. Auth is session JWT (member) OR project `apikey` header — resolved
 * per request, always server-side.
 */

// ── Backend seam (real SQL vs test/dev fake) ───────────────────────────

export interface DataBackend {
  readSchema(creds: ProjectConnectionInfo): Promise<SchemaInfo>;
  exec(
    creds: ProjectConnectionInfo,
    text: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]>;
}

export const RealDataBackend: DataBackend = {
  readSchema: creds => inspectProjectSchema(creds),
  exec: (creds, text, params) => queryProjectDb(creds, text, params),
};

/**
 * TEST/DEV-ONLY in-memory backend (used when PROVISION_DRIVER=fake).
 * Interprets exactly the query shapes the builder emits. Production paths
 * NEVER select this backend (see v1.ts createContext).
 */
export class FakeDataBackend implements DataBackend {
  private readonly store = new Map<string, Map<string, Record<string, unknown>[]>>();

  seed(projectId: string, table: string, rows: Record<string, unknown>[]): void {
    let tables = this.store.get(projectId);
    if (!tables) {
      tables = new Map();
      this.store.set(projectId, tables);
    }
    tables.set(
      table,
      rows.map(r => ({ ...r })),
    );
  }

  async readSchema(_creds: ProjectConnectionInfo): Promise<SchemaInfo> {
    return {
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
            { name: 'email', dataType: 'character varying', nullable: false, defaultValue: null },
            { name: 'age', dataType: 'integer', nullable: true, defaultValue: null },
          ],
          primaryKeys: ['id'],
          indexes: [],
        },
        {
          schema: 'public',
          name: 'posts',
          columns: [
            { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
            { name: 'user_id', dataType: 'uuid', nullable: false, defaultValue: null },
            { name: 'title', dataType: 'text', nullable: false, defaultValue: null },
          ],
          primaryKeys: ['id'],
          indexes: [],
        },
      ],
      foreignKeys: [
        { table: 'public.posts', column: 'user_id', foreignTable: 'users', foreignColumn: 'id' },
      ],
    };
  }

  async exec(
    _creds: ProjectConnectionInfo,
    text: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    // Project scope is enforced by the caller (tables map keyed per project).
    const pid = FakeDataBackend.currentProject;
    const tables = this.store.get(pid) ?? new Map<string, Record<string, unknown>[]>();
    if (text.startsWith('SELECT')) return this.select(tables, text, params);
    if (text.startsWith('INSERT')) return this.insert(tables, pid, text, params);
    if (text.startsWith('UPDATE')) return this.update(tables, text, params);
    if (text.startsWith('DELETE')) return this.remove(tables, text, params);
    throw new Error(`unsupported: ${text.slice(0, 40)}`);
  }

  /** Set by the route layer per request (single-threaded test/dev only). */
  static currentProject = '';

  private tableOf(tables: Map<string, Record<string, unknown>[]>, text: string): string {
    const m = /"public"\."(\w+)"/.exec(text);
    if (!m?.[1]) throw new Error('no table');
    return m[1];
  }

  private select(
    tables: Map<string, Record<string, unknown>[]>,
    text: string,
    params: unknown[],
  ): Record<string, unknown>[] {
    const table = this.tableOf(tables, text);
    let out = [...(tables.get(table) ?? [])];
    const where = /WHERE (.+?)( ORDER BY| LIMIT|$)/s.exec(text)?.[1];
    if (where) {
      for (const clause of where.split(' AND ')) {
        const m = /^"(\w+)" (=|<>|>|>=|<|<=|LIKE|ILIKE) \$(\d+)$/.exec(clause.trim());
        const isNull = /^"(\w+)" IS (NOT NULL|NULL)$/.exec(clause.trim());
        const isBool = /^"(\w+)" IS (TRUE|FALSE)$/.exec(clause.trim());
        const inList = /^"(\w+)" IN \((.+)\)$/.exec(clause.trim());
        if (m?.[1] && m[2] && m[3]) {
          const col = m[1];
          const val = params[Number(m[3]) - 1];
          out = out.filter(r => cmp(r[col], m[2] as string, val));
        } else if (isNull?.[1]) {
          const col = isNull[1];
          out = out.filter(r => (isNull[2] === 'NULL' ? r[col] == null : r[col] != null));
        } else if (isBool?.[1]) {
          const want = isBool[2] === 'TRUE';
          out = out.filter(r => Boolean(r[isBool[1] as string]) === want);
        } else if (inList?.[1] && inList[2]) {
          const col = inList[1];
          const idx = [...inList[2].matchAll(/\$(\d+)/g)].map(x => params[Number(x[1]) - 1]);
          out = out.filter(r => idx.some(v => looseEq(r[col], v)));
        }
      }
    }
    const order = /ORDER BY (.+?) LIMIT/.exec(text)?.[1];
    if (order) {
      const keys = order.split(',').map(k => {
        const mm = /^"(\w+)" (ASC|DESC)$/.exec(k.trim());
        return { col: mm?.[1] ?? '', desc: mm?.[2] === 'DESC' };
      });
      out.sort((a, b) => {
        for (const k of keys) {
          const av = a[k.col] as number | string | null;
          const bv = b[k.col] as number | string | null;
          if (av === bv) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (av < bv) return k.desc ? 1 : -1;
          return k.desc ? -1 : 1;
        }
        return 0;
      });
    }
    const lim = /LIMIT \$(\d+) OFFSET \$(\d+)$/.exec(text);
    const limit = lim?.[1] ? Number(params[Number(lim[1]) - 1]) : out.length;
    const offset = lim?.[2] ? Number(params[Number(lim[2]) - 1]) : 0;
    out = out.slice(offset, offset + limit);
    // Honor explicit column projection like real Postgres does.
    const proj = /^SELECT (.+?) FROM /s.exec(text)?.[1]?.trim();
    if (proj && proj !== '*') {
      const wanted = proj.split(',').map(s => s.replace(/"/g, '').trim());
      out = out.map(r => Object.fromEntries(wanted.map(c => [c, r[c]])));
    }
    return out;
  }

  private insert(
    tables: Map<string, Record<string, unknown>[]>,
    pid: string,
    text: string,
    params: unknown[],
  ): Record<string, unknown>[] {
    const m = /INTO "public"\."(\w+)" \(([^)]+)\)/.exec(text);
    const cols = (m?.[2] ?? '').split(',').map(s => s.replace(/"/g, '').trim());
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      row[c] = params[i];
    });
    let arr = tables.get(m?.[1] ?? '');
    if (!arr) {
      arr = [];
      tables.set(m?.[1] ?? '', arr);
      this.store.set(pid, tables);
    }
    arr.push(row);
    return [row];
  }

  private update(
    tables: Map<string, Record<string, unknown>[]>,
    text: string,
    params: unknown[],
  ): Record<string, unknown>[] {
    const table = this.tableOf(tables, text);
    const sets = [...text.matchAll(/"(\w+)" = \$(\d+)/g)].map(x => ({
      col: x[1] as string,
      idx: Number(x[2]) - 1,
    }));
    // Last placeholder belongs to the WHERE pk clause; the rest are SETs.
    const whereIdx = params.length - 1;
    const id = params[whereIdx];
    const row = tables.get(table)?.find(r => looseEq(r['id'], id));
    if (!row) return [];
    for (const s of sets) {
      if (s.idx === whereIdx) continue;
      row[s.col] = params[s.idx];
    }
    return [{ ...row }];
  }

  private remove(
    tables: Map<string, Record<string, unknown>[]>,
    text: string,
    params: unknown[],
  ): Record<string, unknown>[] {
    const table = this.tableOf(tables, text);
    const arr = tables.get(table) ?? [];
    // DELETE ... WHERE "pk" = $1  (builder shape)
    const id = params[0];
    const i = arr.findIndex(r => looseEq(r['id'], id));
    if (i === -1) return [];
    arr.splice(i, 1);
    return [{ deleted: true }];
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  return a == b;
}

function cmp(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case '=':
      return looseEq(a, b);
    case '<>':
      return a != b;
    case '>':
      return (a as number) > (b as number);
    case '>=':
      return (a as number) >= (b as number);
    case '<':
      return (a as number) < (b as number);
    case '<=':
      return (a as number) <= (b as number);
    case 'LIKE':
    case 'ILIKE': {
      const re = new RegExp(`^${String(b).replace(/%/g, '.*')}$`, op === 'ILIKE' ? 'i' : '');
      return re.test(String(a ?? ''));
    }
    default:
      return false;
  }
}

// ── Routing ───────────────────────────────────────────────────────────

const PROJECT_RESERVED = new Set(['database', 'jobs', 'auth', 'storage', 'functions']);

/** True when /projects/:id/<seg>... belongs to the data plane. */
export function isDataRoute(rest: string[], method: string): boolean {
  if (rest.length < 2 || !rest[0] || !rest[1]) return false;
  const seg = rest[1];
  if (seg === 'keys' || seg === 'openapi.json') return true;
  if (PROJECT_RESERVED.has(seg)) return false;
  return ['GET', 'POST', 'PATCH', 'DELETE'].includes(method);
}

export type DataCaller =
  | { kind: 'session'; userId: string; role: string; project: ProjectRecord }
  | { kind: 'key'; key: ProjectApiKey; project: ProjectRecord }
  | { kind: 'customer'; userId: string; role: 'admin' | 'authenticated'; project: ProjectRecord }
  | { kind: 'agent'; agent: AgentToken; project: ProjectRecord };

async function credsForProject(
  ctx: ApiContext,
  project: ProjectRecord,
): Promise<ProjectConnectionInfo> {
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

export async function resolveCaller(
  ctx: ApiContext,
  req: IncomingMessage,
  projectId: string,
): Promise<DataCaller> {
  const rawKey = req.headers['apikey'];
  if (typeof rawKey === 'string' && rawKey.length > 0) {
    const key = await verifyKey(ctx.keys, rawKey).catch(err => {
      throw toKeyError(err);
    });
    if (key.projectId !== projectId) {
      throw new ApiError('TENANT_FORBIDDEN', 'API key is not scoped to this project', 403);
    }
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    return { kind: 'key', key, project };
  }
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing credentials (Bearer or apikey)', 401);
  const project = await ctx.registry.getProject(projectId);
  if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
  // Agent tokens route by prefix before any JWT handling (they are opaque).
  const maybeAgent = await agentFromRequest(ctx, req);
  if (maybeAgent) {
    return {
      kind: 'agent',
      agent: await verifyAgentAccess(ctx, req, maybeAgent, {
        organizationId: project.organizationId,
        projectId: project.id,
        action: 'data.access',
      }),
      project,
    };
  }
  // Customer access tokens are audience-bound: a structurally valid customer
  // credential for ANOTHER project is forbidden (403); an unusable one falls
  // through to the platform session check (401 when that fails too).
  const asCustomer = await decodeCustomerToken(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  }).catch(() => null);
  if (asCustomer) {
    if (asCustomer.projectId !== projectId) {
      throw new ApiError('TENANT_FORBIDDEN', 'Token is not scoped to this project', 403);
    }
    const customer = await verifyCustomerCaller(ctx, project, token);
    if (!customer) throw new ApiError('UNAUTHORIZED', 'Invalid or expired credentials', 401);
    return { kind: 'customer', userId: customer.user.id, role: customer.role, project };
  }
  let session: { sub: string } | null = null;
  try {
    session = await verifySession(token, {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
    });
  } catch {
    session = null;
  }
  if (!session) throw new ApiError('UNAUTHORIZED', 'Invalid or expired credentials', 401);
  const owned = await mustOwnProject(ctx.registry, session.sub, projectId);
  const role =
    (await ctx.registry.membershipsFor(session.sub)).find(
      m => m.organizationId === owned.organizationId,
    )?.role ?? 'viewer';
  return { kind: 'session', userId: session.sub, role, project: owned };
}

function toKeyError(err: unknown): ApiError {
  if (err instanceof KeyError) return new ApiError(err.code, err.message, err.status);
  throw err;
}

function requireWrite(caller: DataCaller): void {
  // Agents are scope-gated per method at the top of handleDataRoutes.
  if (caller.kind === 'agent') return;
  if (caller.kind === 'key') {
    if (!keyCanWrite(caller.key.role)) {
      throw new ApiError('KEY_READONLY', 'This API key is read-only', 403);
    }
    return;
  }
  // Customer users write their own rows (owner-scoped below); platform
  // viewers cannot mutate.
  if (caller.kind === 'customer') return;
  if (!can(caller.role, 'projects:update')) {
    throw new ApiError('FORBIDDEN', 'Viewers cannot mutate data', 403);
  }
}

function requireKeysPerm(
  caller: DataCaller,
  perm: 'keys:read' | 'keys:create' | 'keys:revoke',
): void {
  // Project keys and customer tokens can never manage keys (no escalation).
  if (caller.kind !== 'session') {
    throw new ApiError('FORBIDDEN', 'API keys cannot manage keys', 403);
  }
  if (!can(caller.role, perm)) throw new ApiError('FORBIDDEN', 'Insufficient role', 403);
}

async function rateLimitData(ctx: ApiContext, caller: DataCaller): Promise<ApiError | null> {
  const windowMs = ctx.config.RATE_LIMIT_WINDOW_MS;
  if (caller.kind === 'key') {
    const rk = await checkRateLimit(ctx.rateLimitStore, caller.key.id, {
      windowMs,
      max: ctx.config.DATA_API_KEY_MAX,
      keyPrefix: 'data-key',
    });
    if (!rk.allowed) return new ApiError('RATE_LIMITED', 'API key rate limit exceeded', 429);
  }
  if (caller.kind === 'customer') {
    const rc = await checkRateLimit(ctx.rateLimitStore, caller.userId, {
      windowMs,
      max: ctx.config.DATA_API_KEY_MAX,
      keyPrefix: 'data-cust',
    });
    if (!rc.allowed) return new ApiError('RATE_LIMITED', 'Rate limit exceeded', 429);
  }
  const rp = await checkRateLimit(ctx.rateLimitStore, caller.project.id, {
    windowMs,
    max: ctx.config.DATA_API_PROJECT_MAX,
    keyPrefix: 'data-proj',
  });
  if (!rp.allowed) return new ApiError('RATE_LIMITED', 'Project rate limit exceeded', 429);
  return null;
}

/**
 * Owner scoping for customer callers (engine-level RLS enforcement).
 * Admins and tables without a `user_id` column are unaffected.
 */
function ownerFilterFor(schema: SchemaInfo, table: string, caller: DataCaller): string | null {
  if (caller.kind !== 'customer' || caller.role === 'admin') return null;
  const t = schema.tables.find(x => x.name === table);
  if (!t || !t.columns.some(c => c.name === 'user_id')) return null;
  return `user_id=eq.${caller.userId}`;
}

function assertRowOwner(row: Record<string, unknown>, caller: DataCaller): void {
  if (caller.kind !== 'customer' || caller.role === 'admin') return;
  if (!('user_id' in row)) return;
  if (String(row['user_id'] ?? '') !== caller.userId) {
    // 404, not 403 — no existence oracle for other owners' rows.
    const err = new ApiError('NOT_FOUND', 'Row not found', 404);
    (err as { code: string }).code = 'ROW_NOT_FOUND';
    throw err;
  }
}

/**
 * Ownership on write: non-admin customers get `user_id` forced to their id
 * (absent → set; conflicting → 403). Admins/service may set freely.
 */
function forceOwnerInsert(
  schema: SchemaInfo,
  table: string,
  caller: DataCaller,
  body: Record<string, unknown>,
  isUpdate = false,
): Record<string, unknown> {
  if (caller.kind !== 'customer' || caller.role === 'admin') return body;
  const t = schema.tables.find(x => x.name === table);
  if (!t || !t.columns.some(c => c.name === 'user_id')) return body;
  if (isUpdate) {
    if ('user_id' in body && String(body['user_id'] ?? '') !== caller.userId) {
      throw new ApiError('FORBIDDEN', 'Cannot reassign row ownership', 403);
    }
    const { user_id: _drop, ...rest } = body;
    void _drop;
    return rest;
  }
  if ('user_id' in body && String(body['user_id'] ?? '') !== caller.userId) {
    throw new ApiError('FORBIDDEN', 'Cannot create rows for another user', 403);
  }
  return { ...body, user_id: caller.userId };
}

const CreateKeyBody = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['public', 'service', 'admin']),
  expiresAt: z.string().datetime().optional(),
});

const MAX_DATA_BODY = 262_144;

export async function handleDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  config: AppConfig,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
  query: URLSearchParams,
  readJson: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, seg, rowId, ...extra] = rest;
  if (!projectId || !seg) return false;
  const start = Date.now();
  const finish = (status: number, body: unknown, fields: Record<string, unknown> = {}): true => {
    logger.info('data.request', {
      project: projectId,
      table: seg,
      method: req.method,
      status,
      latencyMs: Date.now() - start,
      ...fields,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const mapped = err instanceof ApiError ? err : toKeyErrorSafe(err);
    const { status, body } = toPublicError(mapped, requestId);
    return finish(status, body);
  };

  try {
    const caller = await resolveCaller(ctx, req, projectId);
    if (ctx.data instanceof FakeDataBackend) FakeDataBackend.currentProject = projectId;
    const limited = await rateLimitData(ctx, caller);
    if (limited) {
      const { status, body } = toPublicError(limited, requestId);
      return finish(status, body, { caller: caller.kind });
    }
    if (caller.kind === 'key') await ctx.keys.touch(caller.key.id);
    if (caller.kind === 'agent') {
      // Agents never manage keys (no escalation); audit the attempt.
      if (seg === 'keys') {
        auditAgent(ctx, req, {
          token: caller.agent,
          userId: caller.agent.userId,
          organizationId: caller.project.organizationId,
          projectId: caller.project.id,
          action: 'keys.manage',
          result: 'denied',
          reason: 'FORBIDDEN: agents cannot manage API keys',
        });
        throw new ApiError('FORBIDDEN', 'API keys cannot manage keys', 403);
      }
      await requireAgentScope(ctx, req, caller.agent, {
        scope: req.method === 'GET' ? 'database.read' : 'database.write',
        organizationId: caller.project.organizationId,
        projectId: caller.project.id,
        action: req.method === 'GET' ? 'data.read' : 'data.write',
        resource: `${req.method ?? 'GET'} ${seg}`,
      });
    }

    // ── API keys (session members only) ──
    if (seg === 'keys') {
      if (rest.length === 2 && req.method === 'GET') {
        requireKeysPerm(caller, 'keys:read');
        const keys = await ctx.keys.listByProject(projectId);
        return finish(200, ok({ keys }, requestId), { caller: caller.kind });
      }
      if (rest.length === 2 && req.method === 'POST') {
        requireKeysPerm(caller, 'keys:create');
        const parsed = parseBody(CreateKeyBody, await readJson());
        let issued: IssuedKey;
        try {
          issued = await issueKey(ctx.keys, {
            projectId,
            organizationId: caller.project.organizationId,
            name: parsed.name,
            role: parsed.role as KeyRole,
            expiresAt: parsed.expiresAt ?? null,
            createdBy: caller.kind === 'session' ? caller.userId : 'apikey',
          });
        } catch (e) {
          throw toKeyError(e);
        }
        await ctx.registry.recordAudit('api_key.created', {
          projectId,
          organizationId: caller.project.organizationId,
          userId: caller.kind === 'session' ? caller.userId : undefined,
        });
        return finish(201, ok({ key: issued.key, raw: issued.raw }, requestId), {
          caller: caller.kind,
        });
      }
      if (rest.length === 4 && rowId && extra[0] === 'revoke' && req.method === 'POST') {
        requireKeysPerm(caller, 'keys:revoke');
        const revoked = await ctx.keys.revoke(rowId);
        if (!revoked || revoked.projectId !== projectId) {
          throw new ApiError('NOT_FOUND', 'API key not found', 404);
        }
        await ctx.registry.recordAudit('api_key.revoked', {
          projectId,
          organizationId: caller.project.organizationId,
          userId: caller.kind === 'session' ? caller.userId : undefined,
        });
        return finish(200, ok({ key: revoked }, requestId), { caller: caller.kind });
      }
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    }

    // ── OpenAPI (any authorized caller) ──
    if (seg === 'openapi.json' && req.method === 'GET' && rest.length === 2) {
      const creds = await credsForProject(ctx, caller.project);
      const schema = await introspect(ctx, caller.project.id, creds);
      const doc = buildOpenApiDoc({
        baseUrl: config.PUBLIC_API_URL,
        projectId,
        schema,
        maxRows: config.PROVISION_MAX_SQL_ROWS,
      }) as { paths?: Record<string, unknown> };
      doc.paths = {
        ...(doc.paths ?? {}),
        ...storageOpenApiPaths(),
        ...realtimeOpenApiPaths(),
        ...functionsOpenApiPaths(),
        ...aiOpenApiPaths(),
        ...billingOpenApiPaths(),
        ...agentsOpenApiPaths(),
      };
      return finish(200, doc, { caller: caller.kind });
    }

    // ── Table routes ──
    if (extra.length > 0)
      return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
    const creds = await credsForProject(ctx, caller.project);
    const schema = await introspect(ctx, caller.project.id, creds);
    const engine = new DataEngine((text, params) => ctx.data.exec(creds, text, params));

    if (rowId === undefined) {
      if (req.method === 'GET') {
        const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
        const offset = query.get('offset') ? Number(query.get('offset')) : undefined;
        const filters: string[] = [];
        for (const [k, v] of query) {
          if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
          filters.push(`${k}=${v}`);
        }
        // Owner scoping: customers see only their rows (admins exempt).
        const scope = ownerFilterFor(schema, seg, caller);
        if (scope) filters.push(scope);
        const page = await engine.list(schema, seg, {
          select: query.get('select'),
          filters,
          order: query.get('order'),
          limit,
          offset,
          maxLimit: config.PROVISION_MAX_SQL_ROWS,
        });
        return finish(
          200,
          ok({ rows: page.rows, limit: page.limit, offset: page.offset }, requestId),
          {
            caller: caller.kind,
          },
        );
      }
      if (req.method === 'POST') {
        requireWrite(caller);
        const body = (await readJson()) as unknown;
        if (JSON.stringify(body ?? null).length > MAX_DATA_BODY) {
          throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new ApiError('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
        }
        const payload = forceOwnerInsert(schema, seg, caller, body as Record<string, unknown>);
        const row = await engine.create(schema, seg, payload);
        auditMutation(ctx, req, caller, 'data.created', seg);
        return finish(201, ok({ row }, requestId), { caller: caller.kind });
      }
      return finish(405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
      });
    }

    const id = decodeURIComponent(rowId);
    if (req.method === 'GET') {
      const row = await engine.get(schema, seg, id);
      assertRowOwner(row, caller);
      return finish(200, ok({ row }, requestId), { caller: caller.kind });
    }
    if (req.method === 'PATCH') {
      requireWrite(caller);
      const body = (await readJson()) as unknown;
      if (JSON.stringify(body ?? null).length > MAX_DATA_BODY) {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
      }
      const existing = await engine.get(schema, seg, id);
      assertRowOwner(existing, caller);
      const payload = forceOwnerInsert(schema, seg, caller, body as Record<string, unknown>, true);
      const row = await engine.update(schema, seg, id, payload);
      auditMutation(ctx, req, caller, 'data.updated', seg);
      return finish(200, ok({ row }, requestId), { caller: caller.kind });
    }
    if (req.method === 'DELETE') {
      requireWrite(caller);
      const existing = await engine.get(schema, seg, id);
      assertRowOwner(existing, caller);
      await engine.remove(schema, seg, id);
      auditMutation(ctx, req, caller, 'data.deleted', seg);
      return finish(200, ok({ deleted: true }, requestId), { caller: caller.kind });
    }
    return finish(405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', requestId },
    });
  } catch (err) {
    return fail(err);
  }
}

const introspectionCache = new Map<string, CachingIntrospectionService>();
export function clearIntrospectionCache(): void {
  introspectionCache.clear();
}

async function introspect(
  ctx: ApiContext,
  projectId: string,
  creds: ProjectConnectionInfo,
): Promise<SchemaInfo> {
  let svc = introspectionCache.get(projectId);
  if (!svc) {
    svc = new CachingIntrospectionService(
      { read: () => ctx.data.readSchema(creds) },
      ctx.config.INTROSPECTION_TTL_MS,
    );
    introspectionCache.set(projectId, svc);
  }
  return svc.getSchema();
}

function auditMutation(
  ctx: ApiContext,
  req: IncomingMessage,
  caller: DataCaller,
  event: string,
  table: string,
): void {
  void ctx.registry
    .recordAudit(event, {
      projectId: caller.project.id,
      organizationId: caller.project.organizationId,
      userId: caller.kind === 'key' ? undefined : caller.kind === 'agent' ? caller.agent.userId : caller.userId,
    })
    .catch(err => ctx.logger.warn('audit failed', { error: String(err).slice(0, 120) }));
  ctx.logger.info('audit', { event, project: caller.project.id, table });
  if (caller.kind === 'agent') {
    auditAgent(ctx, req, {
      token: caller.agent,
      userId: caller.agent.userId,
      organizationId: caller.project.organizationId,
      projectId: caller.project.id,
      action: event,
      resource: table,
      result: 'success',
    });
  }
}

function toKeyErrorSafe(err: unknown): unknown {
  try {
    return toKeyError(err);
  } catch {
    return err;
  }
}
