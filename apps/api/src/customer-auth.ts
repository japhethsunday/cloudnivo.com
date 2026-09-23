import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, checkRateLimit, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { bearerFromHeader } from '@cloudnivo/auth';
import {
  CustomerAuthService,
  HttpSmsService,
  MemoryCustomerAuthStore,
  MemoryEmailService,
  MemorySmsService,
  OtpService,
  PostgresCustomerAuthStore,
  type PasskeyChallenge,
  type PasskeyCredential,
  ResendEmailService,
  SmtpEmailService,
  ensureAuthSchema,
  mergePasswordPolicy,
  verifyCaptcha,
  verifyCustomerAccessToken,
  decodeCustomerToken,
  type CustomerAuditEvent,
  type CustomerAuthConfig,
  type CustomerAuthStore,
  type CustomerRole,
  type CustomerSession,
  type CustomerUser,
  type EmailService,
  type ExposedCustomerUser,
  type OneTimeToken,
  type SmsService,
} from '@cloudnivo/auth';
import { queryProjectDb } from '@cloudnivo/database';
import { FakeDatabaseProvider } from '@cloudnivo/provisioning';
import type { Logger } from '@cloudnivo/logging';
import type { AppConfig } from '@cloudnivo/config';
import type { ApiContext } from './v1.js';
import type { ProjectRecord } from './registry.js';
import { mustOwnProject } from './registry.js';
import { sendJson } from './projects.js';
import { verifyPlatformSession } from './sessions.js';
import { emitAutomationEvent } from './automation.js';
import { meterUsage } from './billing.js';
import { clientIpOf } from './client-ip.js';

/** Auth hook: fan out to project webhooks (never breaks auth on failure). */
function emitAuthHook(
  ctx: ApiContext,
  project: ProjectRecord,
  type: 'user.created' | 'user.signed_in',
  userId: string,
): void {
  void emitAutomationEvent(ctx, {
    type,
    organizationId: project.organizationId,
    projectId: project.id,
    payload: { userId },
  }).catch(() => undefined);
}

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
    isAnonymous?: boolean;
    phone?: string | null;
  }): Promise<CustomerUser> {
    void input.projectId;
    return this.inner.createUser(input);
  }
  findUserByEmail(_projectId: string, email: string) {
    void _projectId;
    return this.inner.findUserByEmail(email);
  }
  findUserByPhone(_projectId: string, phone: string) {
    void _projectId;
    return this.inner.findUserByPhone(phone);
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
  findToken(_projectId: string, hash: string, kind: 'verify' | 'reset' | 'magic' | 'mfa') {
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

  // ── Passkeys (the inner store is already scoped to one project) ──
  savePasskey(cred: PasskeyCredential) {
    return this.inner.savePasskey(cred);
  }
  findPasskey(_projectId: string, credentialId: string) {
    void _projectId;
    return this.inner.findPasskey(credentialId);
  }
  listPasskeys(_projectId: string, userId: string) {
    void _projectId;
    return this.inner.listPasskeys(userId);
  }
  touchPasskey(_projectId: string, credentialId: string, signCount: number) {
    void _projectId;
    return this.inner.touchPasskey(credentialId, signCount);
  }
  deletePasskey(_projectId: string, userId: string, credentialId: string) {
    void _projectId;
    return this.inner.deletePasskey(userId, credentialId);
  }
  savePasskeyChallenge(challenge: PasskeyChallenge) {
    return this.inner.savePasskeyChallenge(challenge);
  }
  consumePasskeyChallenge(
    _projectId: string,
    challenge: string,
    kind: 'register' | 'authenticate',
  ) {
    void _projectId;
    return this.inner.consumePasskeyChallenge(challenge, kind);
  }
}

export interface CustomerAuthHandle {
  service: CustomerAuthService;
  /** Active email driver (memory in dev/test — the only one with an outbox). */
  email: EmailService;
}

/** Email driver factory: memory default, resend/smtp when configured. */
function emailServiceFor(ctx: ApiContext): EmailService {
  const c = ctx.config;
  if (c.EMAIL_DRIVER === 'resend' && c.RESEND_API_KEY && c.RESEND_FROM) {
    return new ResendEmailService({ apiKey: c.RESEND_API_KEY, from: c.RESEND_FROM });
  }
  if (c.EMAIL_DRIVER === 'smtp' && c.SMTP_HOST && c.SMTP_FROM) {
    return new SmtpEmailService({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      username: c.SMTP_USERNAME,
      password: c.SMTP_PASSWORD,
      from: c.SMTP_FROM,
      secure: c.SMTP_SECURE,
    });
  }
  if (c.EMAIL_DRIVER !== 'memory') {
    ctx.logger.warn('auth.email_driver_fallback', {
      driver: c.EMAIL_DRIVER,
      note: 'Email driver misconfigured (missing key/host) — falling back to memory outbox; delivery NOT happening',
    });
  }
  return new MemoryEmailService();
}

function smsServiceFor(ctx: ApiContext): SmsService {
  const c = ctx.config;
  if (c.SMS_DRIVER === 'http' && c.SMS_HTTP_ENDPOINT && c.SMS_HTTP_API_KEY) {
    return new HttpSmsService({ endpoint: c.SMS_HTTP_ENDPOINT, apiKey: c.SMS_HTTP_API_KEY });
  }
  if (c.SMS_DRIVER !== 'memory') {
    ctx.logger.warn('auth.sms_driver_fallback', {
      note: 'SMS driver misconfigured — falling back to memory outbox; delivery NOT happening',
    });
  }
  return new MemorySmsService();
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
  const email = emailServiceFor(ctx);
  const sms = smsServiceFor(ctx);
  // OTP codes live in the shared cache (cross-instance) with memory fallback.
  const otp = new OtpService(ctx.cache, { ttlSeconds: 600, maxAttempts: 5 });
  const config: CustomerAuthConfig = {
    accessTtlSeconds: ctx.config.AUTH_ACCESS_TTL_S,
    refreshTtlSeconds: ctx.config.AUTH_REFRESH_TTL_S,
    resetTtlSeconds: ctx.config.AUTH_RESET_TTL_S,
    verifyTtlSeconds: ctx.config.AUTH_VERIFY_TTL_S,
    emailDriver: 'memory',
    jwtSecret: ctx.config.JWT_SECRET,
    issuer: ctx.config.JWT_ISSUER,
    passwordPolicy:
      // Legacy back-compat default (length-only). Raising either knob opts
      // the project into the full configurable policy (classes, denylist).
      ctx.config.AUTH_PASSWORD_MIN_LENGTH <= 8 && ctx.config.AUTH_PASSWORD_MIN_CLASSES === 0
        ? null
        : mergePasswordPolicy({
            minLength: ctx.config.AUTH_PASSWORD_MIN_LENGTH,
            minClasses: ctx.config.AUTH_PASSWORD_MIN_CLASSES,
          }),
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
    otp,
    sms,
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

/** Base64url, bounded: these are parsed by the WebAuthn verifier. */
const b64u = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+=*$/, 'must be base64url');

const PasskeyRegisterBody = z.object({
  challenge: z.string().min(16).max(256),
  attestationObject: b64u,
  clientDataJSON: b64u,
  label: z.string().max(80).optional(),
});

const PasskeyLoginBody = z.object({
  challenge: z.string().min(16).max(256),
  credentialId: b64u,
  authenticatorData: b64u,
  clientDataJSON: b64u,
  signature: b64u,
});

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
const OtpRequestBody = z.object({
  email: z.string().min(3).max(320),
  purpose: z.enum(['login', 'verify']).default('login'),
});
const OtpVerifyBody = z.object({
  email: z.string().min(3).max(320),
  code: z.string().min(4).max(10),
  purpose: z.enum(['login', 'verify']).default('login'),
});
const MagicRequestBody = z.object({ email: z.string().min(3).max(320) });
const MagicConsumeBody = z.object({ token: z.string().min(10).max(500) });
const MfaCodeBody = z.object({ code: z.string().min(4).max(32) });
const MfaVerifyBody = z.object({
  mfaTicket: z.string().min(10).max(500),
  code: z.string().min(4).max(32),
});
const ConvertBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(8).max(128),
});
const PhoneBody = z.object({ phone: z.string().min(7).max(20) });
const PhoneVerifyBody = z.object({ code: z.string().min(4).max(10) });

/** Bot gate: enforced only when CAPTCHA_PROVIDER is keyed (dev stays open). */
async function checkCaptcha(ctx: ApiContext, req: IncomingMessage, token: unknown): Promise<void> {
  const ip = clientIpOf(req, ctx.config.TRUSTED_PROXY_HOPS);
  let result: { ok: boolean; enforced: boolean };
  try {
    result = await verifyCaptcha(
      { provider: ctx.config.CAPTCHA_PROVIDER, secretKey: ctx.config.CAPTCHA_SECRET_KEY },
      typeof token === 'string' ? token : null,
      ip,
    );
  } catch (err) {
    throw new ApiError(
      'CAPTCHA_UNAVAILABLE',
      err instanceof Error ? err.message : 'Try again',
      503,
    );
  }
  if (result.enforced && !result.ok) {
    throw new ApiError('CAPTCHA_FAILED', 'Bot verification failed', 403);
  }
}

function clientMeta(
  req: IncomingMessage,
  trustedProxyHops = 1,
): { ip: string | null; agent: string | null } {
  const ip = clientIpOf(req, trustedProxyHops);
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

// MFA setup endpoints share a separate, roomier bucket so legit enroll/
// confirm flows cannot starve the login brute-force budget (and vice versa).
async function mfaLimit(ctx: ApiContext, key: string): Promise<void> {
  const r = await checkRateLimit(ctx.rateLimitStore, key, {
    windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
    max: ctx.config.AUTH_RATE_MAX * 3,
    keyPrefix: 'auth-mfa',
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
  const session = await verifyPlatformSession(ctx, token);
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
    const meta = clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS);
    const [head, tail] = action;

    // ── Public endpoints (strict rate limits) ──
    if (head === 'signup' && req.method === 'POST') {
      await authLimit(ctx, key(`signup:${meta.ip ?? 'unknown'}`));
      const raw = await readJson();
      const parsed = parseBody(SignupBody, raw);
      await checkCaptcha(ctx, req, (raw as { captcha_token?: unknown } | undefined)?.captcha_token);
      const out = await service.signUp(project.id, {
        email: parsed.email,
        password: parsed.password,
        userMetadata: parsed.userMetadata,
      });
      const body: Record<string, unknown> = { user: out.user };
      if (config.isTest && email instanceof MemoryEmailService) {
        const last = email.lastTo(parsed.email.toLowerCase());
        const m = /token=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
        if (m?.[1]) body['verificationToken'] = m[1];
      }
      emitAuthHook(ctx, project, 'user.created', out.user.id);
      meterUsage(ctx, project.organizationId, project.id, 'api', 'api_requests', 1);
      return finish(201, ok(body, requestId));
    }

    if (head === 'token' && req.method === 'POST') {
      const raw = await readJson();
      const parsed = parseBody(TokenBody, raw);
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
      await checkCaptcha(ctx, req, (raw as { captcha_token?: unknown } | undefined)?.captcha_token);
      const out = await service.signIn(
        project.id,
        { email: parsed.email, password: parsed.password },
        meta,
      );
      if (!('mfaRequired' in out)) {
        emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
      }
      meterUsage(ctx, project.organizationId, project.id, 'api', 'api_requests', 1);
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
      if (config.isTest && email instanceof MemoryEmailService) {
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

    // ── Anonymous auth + identity linking ──
    if (head === 'anonymous' && req.method === 'POST') {
      await authLimit(ctx, key(`anon:${meta.ip ?? 'unknown'}`));
      const body = (await readJson().catch(() => undefined)) as
        { userMetadata?: unknown } | undefined;
      const out = await service.signInAnonymously(
        project.id,
        { userMetadata: body?.userMetadata },
        meta,
      );
      return finish(200, ok(out, requestId));
    }
    if (head === 'convert' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      await authLimit(ctx, key(`convert:${caller.user.id}`));
      const parsed = parseBody(ConvertBody, await readJson());
      const out = await service.convertAnonymous(project.id, caller.user.id, {
        email: parsed.email,
        password: parsed.password,
      });
      return finish(200, ok(out, requestId));
    }

    // ── Email OTP + magic links ──
    if (head === 'otp-request' && req.method === 'POST') {
      await authLimit(ctx, key(`otp:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(OtpRequestBody, await readJson());
      const out = await service.requestEmailOtp(project.id, parsed.email, parsed.purpose);
      const body: Record<string, unknown> = { sent: out.sent };
      if (config.isTest && email instanceof MemoryEmailService) {
        const last = email.lastTo(parsed.email.toLowerCase());
        const m = /(\d{4,10})/.exec(last?.text ?? '');
        if (m?.[1]) body['code'] = m[1];
      }
      return finish(200, ok(body, requestId));
    }
    if (head === 'otp-verify' && req.method === 'POST') {
      await authLimit(ctx, key(`otp:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(OtpVerifyBody, await readJson());
      const out = await service.verifyEmailOtp(
        project.id,
        parsed.email,
        parsed.code,
        meta,
        parsed.purpose,
      );
      emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
      return finish(200, ok(out, requestId));
    }
    if (head === 'magic-request' && req.method === 'POST') {
      await authLimit(ctx, key(`magic:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(MagicRequestBody, await readJson());
      const out = await service.requestMagicLink(project.id, parsed.email);
      const body: Record<string, unknown> = { sent: out.sent };
      if (config.isTest && email instanceof MemoryEmailService) {
        const last = email.lastTo(parsed.email.toLowerCase());
        const m = /token=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
        if (m?.[1]) body['magicToken'] = m[1];
      }
      return finish(200, ok(body, requestId));
    }
    if (head === 'magic-consume' && req.method === 'POST') {
      await authLimit(ctx, key(`magic:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(MagicConsumeBody, await readJson());
      const out = await service.consumeMagicLink(project.id, parsed.token, meta);
      emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
      return finish(200, ok(out, requestId));
    }

    // ── TOTP MFA ──
    if (head === 'mfa-enroll' && req.method === 'POST') {
      await mfaLimit(ctx, key(`mfa:${meta.ip ?? 'unknown'}`));
      const caller = await customerBearer(ctx, req, project);
      const out = await service.enrollTotp(project.id, caller.user.id);
      // Secret shown ONCE — never logged, never stored raw elsewhere.
      return finish(200, ok(out, requestId));
    }
    if (head === 'mfa-confirm' && req.method === 'POST') {
      await mfaLimit(ctx, key(`mfa:${meta.ip ?? 'unknown'}`));
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(MfaCodeBody, await readJson());
      const out = await service.confirmTotp(project.id, caller.user.id, parsed.code);
      return finish(200, ok(out, requestId));
    }
    if (head === 'mfa-disable' && req.method === 'POST') {
      await mfaLimit(ctx, key(`mfa:${meta.ip ?? 'unknown'}`));
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(MfaCodeBody, await readJson());
      await service.disableTotp(project.id, caller.user.id, parsed.code);
      return finish(200, ok({ disabled: true }, requestId));
    }
    if (head === 'mfa-verify' && req.method === 'POST') {
      await authLimit(ctx, key(`mfa:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(MfaVerifyBody, await readJson());
      const out = await service.verifyMfa(project.id, parsed.mfaTicket, parsed.code, meta);
      emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
      return finish(200, ok(out, requestId));
    }

    // ── Phone OTP ──
    if (head === 'phone' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(PhoneBody, await readJson());
      const user = await service.updatePhone(project.id, caller.user.id, parsed.phone);
      return finish(200, ok({ user }, requestId));
    }
    if (head === 'phone-otp-request' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      await authLimit(ctx, key(`phone:${caller.user.id}`));
      const out = await service.requestPhoneOtp(project.id, caller.user.id);
      return finish(200, ok(out, requestId));
    }
    if (head === 'phone-otp-verify' && req.method === 'POST') {
      const caller = await customerBearer(ctx, req, project);
      const parsed = parseBody(PhoneVerifyBody, await readJson());
      const user = await service.verifyPhoneOtp(project.id, caller.user.id, parsed.code);
      return finish(200, ok({ user }, requestId));
    }
    if (head === 'phone-login-request' && req.method === 'POST') {
      await authLimit(ctx, key(`phonelogin:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(PhoneBody, await readJson());
      const out = await service.requestLoginOtp(project.id, parsed.phone);
      return finish(200, ok(out, requestId));
    }
    if (head === 'phone-login-verify' && req.method === 'POST') {
      await authLimit(ctx, key(`phonelogin:${meta.ip ?? 'unknown'}`));
      const parsed = parseBody(
        PhoneVerifyBody.extend({ phone: z.string().min(7).max(20) }),
        await readJson(),
      );
      const out = await service.verifyLoginOtp(project.id, parsed.phone, parsed.code, meta);
      emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
      return finish(200, ok(out, requestId));
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
    // ── Passkeys (WebAuthn) ──────────────────────────────────────────
    if (head === 'passkeys') {
      /**
       * A passkey is bound to an origin and an rpId, and the binding is what
       * makes it unphishable. Both come from the project's configured
       * origins - never from the request - so a caller cannot nominate the
       * origin their credential will be accepted for.
       */
      const cfg = await ctx.registry.getAuthConfig(project.id);
      const origins = (cfg?.allowedOrigins ?? []).length
        ? (cfg?.allowedOrigins as string[])
        : [ctx.config.APP_URL];
      const rpId = (() => {
        try {
          return new URL(origins[0] as string).hostname;
        } catch {
          throw new ApiError(
            'CONFIG_INVALID',
            'Configure a valid allowed origin before using passkeys',
            400,
          );
        }
      })();

      const sub = action[2];

      if (tail === 'register' && sub === 'begin' && req.method === 'POST') {
        const caller = await customerBearer(ctx, req, project);
        const out = await service.beginPasskeyRegistration(project.id, caller.user.id);
        return finish(200, ok({ ...out, rpId, origin: origins[0] }, requestId));
      }

      if (tail === 'register' && sub === 'finish' && req.method === 'POST') {
        const caller = await customerBearer(ctx, req, project);
        const parsed = parseBody(PasskeyRegisterBody, await readJson());
        const out = await service.finishPasskeyRegistration(project.id, caller.user.id, {
          ...parsed,
          origins,
          rpId,
        });
        return finish(201, ok({ passkey: out }, requestId));
      }

      if (tail === 'authenticate' && sub === 'begin' && req.method === 'POST') {
        // Public and deliberately uninformative: it takes no identifier and
        // answers identically whether or not any account exists.
        await authLimit(ctx, key(`passkey-begin:${meta.ip ?? 'unknown'}`));
        const out = await service.beginPasskeyAuthentication(project.id);
        return finish(200, ok({ ...out, rpId }, requestId));
      }

      if (tail === 'authenticate' && sub === 'finish' && req.method === 'POST') {
        await authLimit(ctx, key(`passkey-finish:${meta.ip ?? 'unknown'}`));
        const parsed = parseBody(PasskeyLoginBody, await readJson());
        const out = await service.finishPasskeyAuthentication(
          project.id,
          { ...parsed, origins, rpId },
          meta,
        );
        emitAuthHook(ctx, project, 'user.signed_in', out.user.id);
        meterUsage(ctx, project.organizationId, project.id, 'api', 'api_requests', 1);
        return finish(200, ok(out, requestId));
      }

      if (!tail && req.method === 'GET') {
        const caller = await customerBearer(ctx, req, project);
        const passkeys = await service.listPasskeys(project.id, caller.user.id);
        return finish(200, ok({ passkeys }, requestId));
      }

      if (tail && req.method === 'DELETE') {
        const caller = await customerBearer(ctx, req, project);
        const removed = await service.removePasskey(project.id, caller.user.id, tail);
        if (!removed) throw new ApiError('NOT_FOUND', 'Passkey not found', 404);
        return finish(200, ok({ deleted: true }, requestId));
      }
    }

    if (head === 'config' && req.method === 'GET') {
      await platformAdmin(ctx, req, project).catch(async () => {
        // Members may read; admins may write.
        const token = bearerFromHeader(req.headers.authorization);
        if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
        const session = await verifyPlatformSession(ctx, token);
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
        ok(
          {
            driver: email.driver,
            queued: email instanceof MemoryEmailService ? email.outbox.length : null,
            delivered: false,
          },
          requestId,
        ),
      );
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    const { status, body } = toPublicError(err, requestId);
    return finish(status, body);
  }
}
