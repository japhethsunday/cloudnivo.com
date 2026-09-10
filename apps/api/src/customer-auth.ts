import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader, verifySession } from '@cloudnivo/auth';
import {
  CustomerAuthService,
  MemoryCustomerAuthStore,
  MemoryEmailService,
  PostgresCustomerAuthStore,
  ensureAuthSchema,
  verifyCustomerAccessToken,
  decodeCustomerToken,
  type CustomerAuditEvent,
  type CustomerAuthConfig,
  type CustomerAuthStore,
  type CustomerRole,
  type CustomerSession,
  type CustomerUser,
  type ExposedCustomerUser,
  type OneTimeToken,
} from '@cloudnivo/auth';
import { queryProjectDb } from '@cloudnivo/database';
import { FakeDatabaseProvider } from '@cloudnivo/provisioning';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import type { ProjectRecord } from './registry.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';

/**
 * Customer authentication routes: /api/v1/projects/:id/auth/*.
 *
 * This is the `/auth/v1` namespace, mounted per project so isolation holds by
 * construction — a top-level /auth/v1 could never know which project's users
 * it serves. Public endpoints (signup/login/reset) need no prior credential;
 * everything else is customer-JWT or platform-session authenticated.
 */

// ── Store selector (memory vs per-project Postgres) ───────────────────

class PgCustomerAuthAdapter implements CustomerAuthStore {
  constructor(
    private readonly inner: PostgresCustomerAuthStore,
    private readonly projectId: string,
  ) {}

  createUser(input: {
    projectId: string;
    email: string;
    passwordHash: string | null;
    userMetadata: Record<string, unknown>;
  }): Promise<CustomerUser> {
    void input.projectId;
    return this.inner.createUser(input);
  }
  findUserByEmail(_projectId: string, email: string) {
    void _projectId;
    return this.inner.findUserByEmail(email);
  }
  findUserById(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.findUserById(userId);
  }
  updateUser(_projectId: string, userId: string, patch: Partial<CustomerUser>) {
    void _projectId;
    return this.inner.updateUser(userId, patch as Record<string, unknown>);
  }
  deleteUser(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.deleteUser(userId);
  }
  async listUsers() {
    return this.inner.listUsers();
  }
  createSession(session: Omit<CustomerSession, 'id' | 'createdAt' | 'updatedAt'>) {
    return this.inner.createSession(session);
  }
  findSession(_projectId: string, sessionId: string) {
    void _projectId;
    return this.inner.findSession(sessionId);
  }
  findSessionByRefreshHash(_projectId: string, hash: string) {
    void _projectId;
    return this.inner.findSessionByRefreshHash(hash);
  }
  touchSession(_projectId: string, sessionId: string, hash: string) {
    void _projectId;
    return this.inner.touchSession(sessionId, hash);
  }
  markRefreshUsed(_projectId: string, sessionId: string, hash: string) {
    void _projectId;
    return this.inner.markRefreshUsed(sessionId, hash);
  }
  revokeSession(_projectId: string, sessionId: string) {
    void _projectId;
    return this.inner.revokeSession(sessionId);
  }
  revokeUserSessions(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.revokeUserSessions(userId);
  }
  listSessions(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.listSessions(userId);
  }
  saveToken(token: Omit<OneTimeToken, 'createdAt'>) {
    return this.inner.saveToken(token);
  }
  findToken(_projectId: string, hash: string, kind: 'verify' | 'reset') {
    void _projectId;
    return this.inner.findToken(hash, kind);
  }
  consumeToken(_projectId: string, hash: string) {
    void _projectId;
    return this.inner.consumeToken(hash);
  }
  deleteUserTokens(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.deleteUserTokens(userId);
  }
}

export interface CustomerAuthHandle {
  service: CustomerAuthService;
  email: MemoryEmailService;
}

async function runnerFor(ctx: ApiContext, project: ProjectRecord) {
  const db = await ctx.registry.getDatabaseByProject(project.id);
  const cred = await ctx.registry.getCredential(project.id);
  if (!db || !cred) throw new ApiError('NOT_FOUND', 'Database not provisioned yet', 404);
  const conn = {
    host: db.host,
    port: db.port,
    database: db.dbName,
    user: cred.dbUser,
    password: cred.password,
  };
  return (text: string, params: unknown[]) => queryProjectDb(conn, text, params);
}

export async function authServiceFor(
  ctx: ApiContext,
  project: ProjectRecord,
): Promise<CustomerAuthHandle> {
  const cached = ctx.customerAuth.get(project.id);
  if (cached) return cached;
  const email = new MemoryEmailService();
  const config: CustomerAuthConfig = {
    accessTtlSeconds: ctx.config.AUTH_ACCESS_TTL_S,
    refreshTtlSeconds: ctx.config.AUTH_REFRESH_TTL_S,
    resetTtlSeconds: ctx.config.AUTH_RESET_TTL_S,
    verifyTtlSeconds: ctx.config.AUTH_VERIFY_TTL_S,
    emailDriver: 'memory',
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  };
  const audit = (event: CustomerAuditEvent, fields: Record<string, unknown>): void => {
    void ctx.registry
      .recordAudit(event, {
        projectId: project.id,
        organizationId: project.organizationId,
        userId: typeof fields['userId'] === 'string' ? fields['userId'] : undefined,
      })
      .catch(err => ctx.logger.warn('audit failed', { error: String(err).slice(0, 120) }));
    ctx.logger.info('audit', { event, project: project.id });
  };
  let store: CustomerAuthStore;
  if (ctx.provider instanceof FakeDatabaseProvider) {
    store = new MemoryCustomerAuthStore();
  } else {
    const run = await runnerFor(ctx, project);
    await ensureAuthSchema({ query: run });
    store = new PgCustomerAuthAdapter(
      new PostgresCustomerAuthStore({ query: run }, project.id),
      project.id,
    );
  }
  const service = new CustomerAuthService({
    store,
    email,
    config,
    audit,
    appUrl: ctx.config.APP_URL,
  });
  const handle = { service, email };
  ctx.customerAuth.set(project.id, handle);
  return handle;
}

/** Verify a customer access token for THIS project (null when not one). */
export async function verifyCustomerCaller(
  ctx: ApiContext,
  project: ProjectRecord,
  token: string,
): Promise<{
  user: ExposedCustomerUser;
  sessionId: string;
  role: 'admin' | 'authenticated';
} | null> {
  let claims;
  try {
    claims = await verifyCustomerAccessToken(token, {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
      projectId: project.id,
    });
  } catch {
    return null;
  }
  const { service } = await authServiceFor(ctx, project);
  // Session liveness: revoked/expired sessions invalidate access tokens.
  try {
    await service.requireLiveSession(project.id, claims.sessionId);
  } catch {
    return null;
  }
  // Session liveness + user status are enforced through the service surface:
  const user = await service.getUser(project.id, claims.sub).catch(() => null);
  if (!user) return null;
  return {
    user,
    sessionId: claims.sessionId,
    role: claims.role === 'admin' ? 'admin' : 'authenticated',
  };
}

// ── Routing ───────────────────────────────────────────────────────────

export function isCustomerAuthRoute(rest: string[], method: string): boolean {
  if (rest.length < 2 || !rest[0] || rest[1] !== 'auth') return false;
  void method;
  return true;
}

/** Project CORS override: project allowlist wins over global when set. */
export async function projectCorsHeaders(
  ctx: ApiContext,
  projectId: string,
  origin: string | null,
  base: Record<string, string>,
): Promise<Record<string, string>> {
  if (!origin) return base;
  try {
    const cfg = await ctx.registry.getAuthConfig(projectId);
    if (cfg && cfg.allowedOrigins.length > 0 && cfg.allowedOrigins.includes(origin)) {
      return { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
  } catch {
    // Registry miss → keep global headers.
  }
  return base;
}

const SignupBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(8).max(128),
  userMetadata: z.record(z.unknown()).optional(),
});
const TokenBody = z.object({
  email: z.string().min(3).max(320).optional(),
  password: z.string().min(8).max(128).optional(),
  grant_type: z.enum(['password', 'refresh_token']).optional(),
  refresh_token: z.string().min(10).max(500).optional(),
});
const RefreshBody = z.object({ refresh_token: z.string().min(10).max(500) });
const ResetRequestBody = z.object({ email: z.string().min(3).max(320) });
const ResetBody = z.object({
  token: z.string().min(10).max(500),
  password: z.string().min(8).max(128),
});
const VerifyBody = z.object({ token: z.string().min(10).max(500) });
const ChangeBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});
const UpdateUserBody = z.object({ userMetadata: z.record(z.unknown()) });
const ConfigBody = z.object({ allowedOrigins: z.array(z.string().max(200)).max(20) });

function clientMeta(req: IncomingMessage): { ip: string | null; agent: string | null } {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const agent = req.headers['user-agent'];
  return { ip, agent: typeof agent === 'string' ? agent.slice(0, 300) : null };
}

function emailKey(v: string): string {
  return createHash('sha256').update(v.toLowerCase()).digest('hex').slice(0, 32);
}

async function authLimit(ctx: ApiContext, key: string): Promise<void> {
  const r = await checkRateLimit(ctx.rateLimitStore, key, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.AUTH_RATE_MAX,
    keyPrefix: 'auth',
  });
  if (!r.allowed) throw new ApiError('RATE_LIMITED', 'Too many authentication attempts', 429);
}

async function platformAdmin(
  ctx: ApiContext,
  req: IncomingMessage,
  project: ProjectRecord,
): Promise<{ userId: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifySession(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  });
  await mustOwnProject(ctx.registry, session.sub, project.id);
  const role =
    (await ctx.registry.membershipsFor(session.sub)).find(
      m => m.organizationId === project.organizationId,
    )?.role ?? 'viewer';
  if (role !== 'owner' && role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Project admin required', 403);
  }
  return { userId: session.sub };
}

async function customerBearer(
  ctx: ApiContext,
  req: IncomingMessage,
  project: ProjectRecord,
): Promise<{ user: ExposedCustomerUser; sessionId: string; role: CustomerRole }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  // Audience mismatch ⇒ valid credential, wrong project (403, not 401).
  const shaped = await decodeCustomerToken(token, {
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
  }).catch(() => null);
  if (shaped && shaped.projectId !== project.id) {
    throw new ApiError('TENANT_FORBIDDEN', 'Token is not scoped to this project', 403);
  }
  const caller = await verifyCustomerCaller(ctx, project, token);
  if (!caller) throw new ApiError('UNAUTHORIZED', 'Invalid or expired access token', 401);
  return caller;
}

export async function handleCustomerAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  config: AppConfig,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
  rest: string[],
  readJson: () => Promise<unknown>,
): Promise<boolean> {
  const [projectId, , ...action] = rest;
  if (!projectId) return false;
  const start = Date.now();
  const finish = (status: number, body: unknown): true => {
    logger.info('auth.request', {
      project: projectId,
      route: action.join('/') || '(root)',
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const key = (suffix: string): string => `p:${projectId}:${suffix}`;

  try {
    const project = await ctx.registry.getProject(projectId);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found', 404);
    const { service, email } = await authServiceFor(ctx, project);
    const meta = clientMeta(req);
    const [head, tail] = action;

    // ── Public endpoints (strict rate limits) ──
    if (head === 'signup' && req.method === 'POST') {
      await authLimit(ctx, key(`signup:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(SignupBody, await readJson());
      const out = await service.signUp(project.id, {
        email: parsed.email,
        password: parsed.password,
        userMetadata: parsed.userMetadata,
      });
      const body: Record<string, unknown> = { user: out.user };
      if (config.isTest) {
        const last = email.lastTo(parsed.email.toLowerCase());
        const m = /token=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
        if (m?.[1]) body['verificationToken'] = m[1];
      }
      return finish(201, ok(body, requestId));
    }

    if (head === 'token' && req.method === 'POST') {
      const parsed = parseBody(TokenBody, await readJson());
      if (parsed.grant_type === 'refresh_token') {
        if (!parsed.refresh_token)
          throw new ApiError('VALIDATION_ERROR', 'refresh_token required', 400);
        await authLimit(ctx, key(`refresh:${meta.ip ?? 'unknown'}`));
        const out = await service.refreshSession(project.id, parsed.refresh_token, meta);
        return finish(200, ok(out, requestId));
      }
      if (!parsed.email || !parsed.password) {
        throw new ApiError('VALIDATION_ERROR', 'email and password required', 400);
      }
      await authLimit(ctx, key(`login:${emailKey(parsed.email)}:${meta.ip ?? 'unknown'}`));
      const out = await service.signIn(
        project.id,
        { email: parsed.email, password: parsed.password },
        meta,
      );
      return finish(200, ok(out, requestId));
    }

    if (head === 'refresh' && req.method === 'POST') {
      await authLimit(ctx, key(`refresh:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(RefreshBody, await readJson());
      const out = await service.refreshSession(project.id, parsed.refresh_token, meta);
      return finish(200, ok(out, requestId));
    }

    if (head === 'logout' && req.method === 'POST') {
      const parsed = (await readJson().catch(() => undefined)) as
        { refresh_token?: string } | undefined;
      if (parsed?.refresh_token) {
        await service.signOutByRefresh(project.id, parsed.refresh_token);
      }
      const bearer = bearerFromHeader(req.headers.authorization);
      if (bearer) {
        const caller = await verifyCustomerCaller(ctx, project, bearer).catch(() => null);
        if (caller) await service.signOut(project.id, caller.sessionId, caller.user.id);
      }
      return finish(200, ok({ loggedOut: true }, requestId));
    }

    if (head === 'reset-request' && req.method === 'POST') {
      await authLimit(ctx, key(`reset:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(ResetRequestBody, await readJson());
      await service.requestPasswordReset(project.id, parsed.email);
      const body: Record<string, unknown> = { sent: true };
      if (config.isTest) {
        const last = email.lastTo(parsed.email.toLowerCase());
        const m = /token=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
        if (m?.[1]) body['resetToken'] = m[1];
      }
      return finish(200, ok(body, requestId));
    }

    if (head === 'reset' && req.method === 'POST') {
      await authLimit(ctx, key(`reset:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(ResetBody, await readJson());
      await service.completePasswordReset(project.id, parsed.token, parsed.password);
      return finish(200, ok({ reset: true }, requestId));
    }

    if (head === 'verify' && req.method === 'POST') {
      await authLimit(ctx, key(`verify:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(VerifyBody, await readJson());
      const user = await service.verifyEmail(project.id, parsed.token);
      return finish(200, ok({ user }, requestId));
    }

    // ── Customer-authenticated endpoints ──
    if (head === 'user' && req.method === 'GET') {
      const caller = await customerBearer(ctx, req, project);
      return finish(200, ok({ user: caller.user }, requestId));
    }
    if (head === 'user' && req.method === 'PATCH') {
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(UpdateUserBody, await readJson());
      const user = await service.updateUser(project.id, caller.user.id, {
        userMetadata: parsed.userMetadata,
      });
      return finish(200, ok({ user }, requestId));
    }
    if (head === 'change' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(ChangeBody, await readJson());
      await service.changePassword(
        project.id,
        caller.user.id,
        parsed.currentPassword,
        parsed.newPassword,
      );
      return finish(200, ok({ changed: true }, requestId));
    }
    if (head === 'sessions' && req.method === 'GET') {
      const caller = await customerBearer(ctx, req, project);
      const sessions = (await service.listSessions(project.id, caller.user.id)).map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastActiveAt: s.lastActiveAt,
        ipAddress: s.ipAddress,
      }));
      return finish(200, ok({ sessions }, requestId));
    }
    if (head === 'sessions' && tail === 'revoke-all' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      const out = await service.revokeAllSessions(project.id, caller.user.id);
      return finish(200, ok(out, requestId));
    }
    if (head === 'sessions' && tail && req.method === 'DELETE') {
      const caller = await customerBearer(ctx, req, project);
      await service.revokeSession(project.id, caller.user.id, tail);
      return finish(200, ok({ revoked: true }, requestId));
    }

    // ── Platform-admin endpoints ──
    if (head === 'admin' && tail === 'users' && req.method === 'GET') {
      await platformAdmin(ctx, req, project);
      const users = await service.listUsers(project.id);
      return finish(200, ok({ users }, requestId));
    }
    if (head === 'admin' && tail === 'users' && req.method === 'PATCH') {
      await platformAdmin(ctx, req, project);
      const parsed = parseBody(
        z.object({
          id: z.string().uuid(),
          status: z.enum(['active', 'disabled']).optional(),
          appMetadata: z.record(z.unknown()).optional(),
        }),
        await readJson(),
      );
      const user = await service.adminUpdateUser(project.id, parsed.id, {
        status: parsed.status,
        appMetadata: parsed.appMetadata,
      });
      return finish(200, ok({ user }, requestId));
    }
    if (head === 'admin' && tail === 'users' && req.method === 'DELETE') {
      await platformAdmin(ctx, req, project);
      const parsed = parseBody(z.object({ id: z.string().uuid() }), await readJson());
      await service.deleteUser(project.id, parsed.id);
      return finish(200, ok({ deleted: true }, requestId));
    }
    if (head === 'config' && req.method === 'GET') {
      await platformAdmin(ctx, req, project).catch(async () => {
        // Members may read; admins may write.
        const token = bearerFromHeader(req.headers.authorization);
        if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
        const session = await verifySession(token, {
          jwtSecret: ctx.config.JWT_SECRET,
          issuer: ctx.config.JWT_ISSUER,
        });
        await mustOwnProject(ctx.registry, session.sub, project.id);
      });
      const cfg = await ctx.registry.getAuthConfig(project.id);
      return finish(
        200,
        ok({ config: cfg ?? { projectId: project.id, allowedOrigins: [] } }, requestId),
      );
    }
    if (head === 'config' && (req.method === 'PATCH' || req.method === 'PUT')) {
      await platformAdmin(ctx, req, project);
      const parsed = parseBody(ConfigBody, await readJson());
      const cfg = await ctx.registry.setAuthConfig(project.id, parsed.allowedOrigins);
      return finish(200, ok({ config: cfg }, requestId));
    }

    // ── Email driver status (platform members; never message content) ──
    if (head === 'email' && tail === 'status' && req.method === 'GET') {
      await platformAdmin(ctx, req, project);
      return finish(
        200,
        ok({ driver: email.driver, queued: email.outbox.length, delivered: false }, requestId),
      );
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    return finish(status, body);
  }
}
