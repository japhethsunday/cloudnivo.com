import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import {
  bearerFromHeader,
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from '@cloudnivo/auth';
import { organizationInvites, users, type Database } from '@cloudnivo/database';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';

/**
 * Platform control-plane auth: developer signup/login, session identity
 * (`GET /me`), and org invites. Customer (per-project application-user) auth
 * lives in customer-auth.ts against project databases; THIS module is the
 * CloudNivo developer account plane backed by the control `users` table
 * (drizzle) or an in-memory store (dev/test default).
 *
 * Passwords are scrypt-hashed (per-user salt); sessions are short-lived
 * signed JWTs delivered as JSON AND an httpOnly `cn_session` cookie.
 * Invite tokens are opaque random values — only sha256 is stored, the raw
 * token is shown once at creation (same pattern as API keys).
 */

export interface PlatformUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

interface StoredPlatformUser extends PlatformUser {
  passwordHash: string;
}

export interface PlatformUserStore {
  createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser>;
  findByEmail(email: string): Promise<StoredPlatformUser | null>;
  findById(id: string): Promise<StoredPlatformUser | null>;
  /** Update display name and/or password hash. Returns null when unknown. */
  updateUser(
    id: string,
    patch: { displayName?: string | null; passwordHash?: string },
  ): Promise<StoredPlatformUser | null>;
}

export class MemoryPlatformUsers implements PlatformUserStore {
  private readonly users = new Map<string, StoredPlatformUser>();

  async createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser> {
    const email = input.email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email === email) {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
    }
    const { randomUUID } = await import('node:crypto');
    const user: StoredPlatformUser = {
      id: randomUUID(),
      email,
      displayName: input.displayName,
      createdAt: new Date().toISOString(),
      passwordHash: input.passwordHash,
    };
    this.users.set(user.id, user);
    return { ...user };
  }

  async findByEmail(email: string): Promise<StoredPlatformUser | null> {
    const want = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email === want) return { ...u };
    }
    return null;
  }

  async findById(id: string): Promise<StoredPlatformUser | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async updateUser(
    id: string,
    patch: { displayName?: string | null; passwordHash?: string },
  ): Promise<StoredPlatformUser | null> {
    const u = this.users.get(id);
    if (!u) return null;
    const next: StoredPlatformUser = {
      ...u,
      displayName: patch.displayName !== undefined ? patch.displayName : u.displayName,
      passwordHash: patch.passwordHash ?? u.passwordHash,
    };
    this.users.set(id, next);
    return { ...next };
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class DrizzlePlatformUsers implements PlatformUserStore {
  constructor(private readonly db: Database) {}

  async createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser> {
    try {
      const rows = await this.db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        })
        .returning();
      const row = rows[0];
      if (!row || !row.passwordHash) throw new Error('User insert failed');
      return {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        createdAt: iso(row.createdAt),
        passwordHash: row.passwordHash,
      };
    } catch (err) {
      if (String((err as { code?: unknown }).code) === '23505') {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
      throw err;
    }
  }

  async findByEmail(email: string): Promise<StoredPlatformUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    const row = rows[0];
    if (!row || !row.passwordHash) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: iso(row.createdAt),
      passwordHash: row.passwordHash,
    };
  }

  async findById(id: string): Promise<StoredPlatformUser | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row || !row.passwordHash) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: iso(row.createdAt),
      passwordHash: row.passwordHash,
    };
  }

  async updateUser(
    id: string,
    patch: { displayName?: string | null; passwordHash?: string },
  ): Promise<StoredPlatformUser | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const set: { displayName?: string | null; passwordHash?: string } = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.passwordHash !== undefined) set.passwordHash = patch.passwordHash;
    if (Object.keys(set).length === 0) return this.findById(id);
    const rows = await this.db.update(users).set(set).where(eq(users.id, id)).returning();
    const row = rows[0];
    if (!row || !row.passwordHash) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: iso(row.createdAt),
      passwordHash: row.passwordHash,
    };
  }
}

// ── Invites ─────────────────────────────────────────────────────────

export interface Invite {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface InviteStore {
  create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite>;
  findByTokenHash(hash: string): Promise<Invite | null>;
  markAccepted(id: string): Promise<void>;
}

export class MemoryInvites implements InviteStore {
  private readonly invites = new Map<string, Invite & { tokenHash: string }>();

  async create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite> {
    const { randomUUID } = await import('node:crypto');
    const invite: Invite & { tokenHash: string } = {
      id: randomUUID(),
      organizationId: input.organizationId,
      email: input.email.toLowerCase(),
      role: input.role,
      expiresAt: input.expiresAt.toISOString(),
      acceptedAt: null,
      createdAt: new Date().toISOString(),
      tokenHash: input.tokenHash,
    };
    void input.createdBy;
    this.invites.set(invite.id, invite);
    const { tokenHash: _drop, ...rest } = invite;
    void _drop;
    return rest;
  }

  async findByTokenHash(hash: string): Promise<Invite | null> {
    for (const inv of this.invites.values()) {
      if (inv.tokenHash === hash) {
        const { tokenHash: _drop, ...rest } = inv;
        void _drop;
        return rest;
      }
    }
    return null;
  }

  async markAccepted(id: string): Promise<void> {
    const inv = this.invites.get(id);
    if (inv) inv.acceptedAt = new Date().toISOString();
  }
}

export class DrizzleInvites implements InviteStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite> {
    const rows = await this.db
      .insert(organizationInvites)
      .values({
        organizationId: input.organizationId,
        email: input.email.toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Invite insert failed');
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      expiresAt: iso(row.expiresAt),
      acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null,
      createdAt: iso(row.createdAt),
    };
  }

  async findByTokenHash(hash: string): Promise<Invite | null> {
    const rows = await this.db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.tokenHash, hash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      expiresAt: iso(row.expiresAt),
      acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null,
      createdAt: iso(row.createdAt),
    };
  }

  async markAccepted(id: string): Promise<void> {
    await this.db
      .update(organizationInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(organizationInvites.id, id));
  }
}

// ── Service wiring ──────────────────────────────────────────────────

export interface PlatformAuth {
  users: PlatformUserStore;
  invites: InviteStore;
}

export function platformAuthFor(ctx: ApiContext): PlatformAuth {
  const existing = (ctx as unknown as { __platform?: PlatformAuth }).__platform;
  if (existing) return existing;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const controlDb = ctx.controlDb;
  const auth: PlatformAuth =
    durable && controlDb
      ? { users: new DrizzlePlatformUsers(controlDb.db), invites: new DrizzleInvites(controlDb.db) }
      : { users: new MemoryPlatformUsers(), invites: new MemoryInvites() };
  (ctx as unknown as { __platform?: PlatformAuth }).__platform = auth;
  return auth;
}

function expose(user: StoredPlatformUser): PlatformUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `cn_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

async function issueSession(
  ctx: ApiContext,
  user: StoredPlatformUser,
): Promise<{ token: string; cookie: string }> {
  const token = await signSession(
    { sub: user.id, email: user.email },
    {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
      expiresInSeconds: ctx.config.JWT_EXPIRES_IN,
    },
  );
  const secure = ctx.config.APP_URL.startsWith('https://');
  return { token, cookie: sessionCookie(token, ctx.config.JWT_EXPIRES_IN, secure) };
}

// ── Routes ──────────────────────────────────────────────────────────

const SignupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

const InviteBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
});

const UpdateMeBody = z.object({
  displayName: z.string().trim().min(1).max(120).nullable(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

const INVITE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

function newInviteToken(): { raw: string; hash: string } {
  const raw = `inv_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

export function isPlatformAuthRoute(pathname: string, method: string): boolean {
  void method;
  return (
    pathname === '/api/v1/auth/signup' ||
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/password' ||
    pathname === '/api/v1/me' ||
    pathname.startsWith('/api/v1/invites/') ||
    /^\/api\/v1\/organizations\/[^/]+\/invites\/?$/.test(pathname)
  );
}

export async function handlePlatformAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const start = Date.now();
  const finish = (status: number, body: unknown, extra?: Record<string, string>): true => {
    logger.info('platform.request', {
      route: url.pathname,
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, { ...baseHeaders, ...extra });
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toPublicError(err, requestId);
    logger.info('platform.request', {
      route: url.pathname,
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const strictLimit = async (): Promise<void> => {
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const rl = await checkRateLimit(ctx.rateLimitStore, `platform-auth:${ip}`, {
      windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
      max: ctx.config.AUTH_RATE_MAX,
      keyPrefix: 'platform-auth',
    });
    if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many attempts', 429);
  };
  const readJson = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
    }
  };
  try {
    const store = platformAuthFor(ctx);

    if (url.pathname === '/api/v1/auth/signup' && req.method === 'POST') {
      await strictLimit();
      const parsed = parseBody(SignupBody, await readJson());
      const passwordHash = await hashPassword(parsed.password);
      const user = await store.users.createUser({
        email: parsed.email,
        passwordHash,
        displayName: parsed.displayName ?? null,
      });
      const { token, cookie } = await issueSession(ctx, user);
      await ctx.registry.recordAudit('platform.signup', { userId: user.id });
      return finish(201, ok({ user: expose(user), token }, requestId), { 'Set-Cookie': cookie });
    }

    if (url.pathname === '/api/v1/auth/login' && req.method === 'POST') {
      await strictLimit();
      const parsed = parseBody(LoginBody, await readJson());
      const user = await store.users.findByEmail(parsed.email);
      if (!user) {
        // Timing equalization: do equivalent scrypt work for unknown emails.
        await hashPassword(`dummy:${randomBytes(8).toString('hex')}:long-enough`);
        throw new ApiError('UNAUTHORIZED', 'Invalid email or password', 401);
      }
      if (!(await verifyPassword(parsed.password, user.passwordHash))) {
        await ctx.registry.recordAudit('platform.login_failed', { userId: user.id });
        throw new ApiError('UNAUTHORIZED', 'Invalid email or password', 401);
      }
      const { token, cookie } = await issueSession(ctx, user);
      await ctx.registry.recordAudit('platform.login', { userId: user.id });
      return finish(200, ok({ user: expose(user), token }, requestId), { 'Set-Cookie': cookie });
    }

    if (url.pathname === '/api/v1/me' && req.method === 'GET') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      const memberships = await ctx.registry.membershipsFor(user.id);
      const orgs = await ctx.registry.listOrganizations(user.id);
      const roleOf = new Map(memberships.map(m => [m.organizationId, m.role]));
      return finish(
        200,
        ok(
          {
            user: expose(user),
            organizations: orgs.map(o => ({ ...o, role: roleOf.get(o.id) ?? 'member' })),
          },
          requestId,
        ),
      );
    }

    if (url.pathname === '/api/v1/auth/password' && req.method === 'POST') {
      await strictLimit();
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      const parsed = parseBody(PasswordBody, await readJson());
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      if (!(await verifyPassword(parsed.currentPassword, user.passwordHash))) {
        await ctx.registry.recordAudit('platform.password.failed', { userId: user.id });
        throw new ApiError('UNAUTHORIZED', 'Current password is incorrect', 401);
      }
      const updated = await store.users.updateUser(user.id, {
        passwordHash: await hashPassword(parsed.newPassword),
      });
      if (!updated) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      await ctx.registry.recordAudit('platform.password.changed', { userId: user.id });
      return finish(200, ok({ changed: true }, requestId));
    }

    if (url.pathname === '/api/v1/me' && req.method === 'PATCH') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      const parsed = parseBody(UpdateMeBody, await readJson());
      const updated = await store.users.updateUser(session.sub, {
        displayName: parsed.displayName,
      });
      if (!updated) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      await ctx.registry.recordAudit('platform.profile.updated', { userId: updated.id });
      return finish(200, ok({ user: expose(updated) }, requestId));
    }

    const orgInviteMatch = /^\/api\/v1\/organizations\/([^/]+)\/invites\/?$/.exec(url.pathname);
    if (orgInviteMatch?.[1] && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      const orgId = orgInviteMatch[1];
      const memberships = await ctx.registry.membershipsFor(session.sub);
      const mine = memberships.find(m => m.organizationId === orgId);
      if (!mine || (mine.role !== 'owner' && mine.role !== 'admin')) {
        throw new ApiError('FORBIDDEN', 'Only org owners/admins can invite', 403);
      }
      const parsed = parseBody(InviteBody, await readJson());
      const role = parsed.role ?? 'member';
      if (!INVITE_ROLES.includes(role)) throw new ApiError('VALIDATION_ERROR', 'Bad role', 400);
      if (role === 'owner' && mine.role !== 'owner') {
        throw new ApiError('FORBIDDEN', 'Only owners can invite owners', 403);
      }
      const { raw: inviteToken, hash } = newInviteToken();
      const invite = await store.invites.create({
        organizationId: orgId,
        email: parsed.email,
        role,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        createdBy: session.sub,
      });
      await ctx.registry.recordAudit('org.invite.created', {
        organizationId: orgId,
        userId: session.sub,
      });
      return finish(201, ok({ invite, token: inviteToken }, requestId));
    }

    const inviteMatch = /^\/api\/v1\/invites\/([^/]+)\/?$/.exec(url.pathname);
    if (inviteMatch?.[1] && req.method === 'GET') {
      const invite = await store.invites.findByTokenHash(
        createHash('sha256').update(inviteMatch[1]).digest('hex'),
      );
      if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now()) {
        throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      }
      return finish(200, ok({ invite }, requestId));
    }

    const acceptMatch = /^\/api\/v1\/invites\/([^/]+)\/accept\/?$/.exec(url.pathname);
    if (acceptMatch?.[1] && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifySession(token, {
        jwtSecret: ctx.config.JWT_SECRET,
        issuer: ctx.config.JWT_ISSUER,
      });
      const invite = await store.invites.findByTokenHash(
        createHash('sha256').update(acceptMatch[1]).digest('hex'),
      );
      if (!invite) throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      if (invite.acceptedAt) throw new ApiError('CONFLICT', 'Invite already accepted', 409);
      if (Date.parse(invite.expiresAt) <= Date.now())
        throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      await ctx.registry.addMembership(invite.organizationId, session.sub, invite.role);
      await store.invites.markAccepted(invite.id);
      await ctx.registry.recordAudit('org.invite.accepted', {
        organizationId: invite.organizationId,
        userId: session.sub,
      });
      return finish(
        200,
        ok({ organizationId: invite.organizationId, role: invite.role }, requestId),
      );
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
