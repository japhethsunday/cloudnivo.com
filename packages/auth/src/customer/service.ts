import { AuthError, hashPassword, verifyPassword } from '../index.js';
import type { EmailService } from './email.js';
import { sanitizeAppMetadata, sanitizeUserMetadata } from './metadata.js';
import type { CustomerAuthStore } from './store.js';
import { hashToken, newOpaqueToken, signCustomerAccessToken } from './tokens.js';
import type {
  AuthTokens,
  CustomerAuditEvent,
  CustomerAuthConfig,
  CustomerRole,
  CustomerSession,
  CustomerUser,
  ExposedCustomerUser,
} from './types.js';
import { exposeUser } from './types.js';

/**
 * Customer authentication service — email/password today, provider-ready
 * tomorrow (OAuth/Magic Link plug in as new `signInWith*` methods + the same
 * session/token primitives; no core rewrite).
 *
 * Security posture:
 * - scrypt password hashing, opaque hashed tokens, single-use reset/verify.
 * - Refresh rotation + reuse detection (reused refresh ⇒ whole session dies).
 * - Enumeration-neutral login/reset responses + constant-time-ish dummy verify.
 * - Audit hook for every security event; secrets never reach logs.
 */

export class CustomerAuthError extends AuthError {
  readonly status: number;
  constructor(code: string, message: string, status = 401) {
    super(code, message);
    this.name = 'CustomerAuthError';
    this.status = status;
  }
}

export interface CustomerAuthDeps {
  store: CustomerAuthStore;
  email: EmailService;
  config: CustomerAuthConfig;
  audit: (event: CustomerAuditEvent, fields: Record<string, unknown>) => void;
  /** Base URL for emailed links (dashboard/app origin, never localhost in prod). */
  appUrl: string;
}

const DUMMY_HASH =
  'scrypt:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

function assertPasswordStrength(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new CustomerAuthError('WEAK_PASSWORD', 'Password must be 8–128 characters', 400);
  }
}

export class CustomerAuthService {
  constructor(private readonly deps: CustomerAuthDeps) {}

  private get store(): CustomerAuthStore {
    return this.deps.store;
  }

  private get config(): CustomerAuthConfig {
    return this.deps.config;
  }

  private audit(event: CustomerAuditEvent, fields: Record<string, unknown>): void {
    this.deps.audit(event, fields);
  }

  private async issueSession(
    projectId: string,
    user: CustomerUser,
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ sessionId: string; tokens: AuthTokens }> {
    const refreshRaw = newOpaqueToken();
    const session = await this.store.createSession({
      userId: user.id,
      projectId,
      refreshTokenHash: hashToken(refreshRaw),
      usedRefreshHashes: [],
      ipAddress: opts.ip,
      userAgent: opts.agent,
      expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1000).toISOString(),
      lastActiveAt: new Date().toISOString(),
      revokedAt: null,
    });
    const role = (user.appMetadata['role'] === 'admin' ? 'admin' : 'authenticated') as CustomerRole;
    const accessToken = await signCustomerAccessToken(
      { sub: user.id, email: user.email, sessionId: session.id, role },
      {
        jwtSecret: this.config.jwtSecret,
        issuer: this.config.issuer,
        projectId,
        accessTtlSeconds: this.config.accessTtlSeconds,
      },
    );
    await this.store.updateUser(projectId, user.id, { lastSignInAt: new Date().toISOString() });
    this.audit('user.session_created', { projectId, userId: user.id, sessionId: session.id });
    return {
      sessionId: session.id,
      tokens: {
        accessToken,
        refreshToken: refreshRaw,
        expiresIn: this.config.accessTtlSeconds,
        tokenType: 'bearer',
      },
    };
  }

  async signUp(
    projectId: string,
    input: { email: string; password: string; userMetadata?: unknown },
  ): Promise<{ user: ExposedCustomerUser; verificationSent: boolean }> {
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new CustomerAuthError('INVALID_EMAIL', 'Invalid email address', 400);
    }
    assertPasswordStrength(String(input.password ?? ''));
    const metadata =
      input.userMetadata === undefined ? {} : sanitizeUserMetadata(input.userMetadata);
    let user: CustomerUser;
    try {
      user = await this.store.createUser({
        projectId,
        email,
        passwordHash: await hashPassword(input.password),
        userMetadata: metadata,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'EMAIL_TAKEN') {
        throw new CustomerAuthError('EMAIL_TAKEN', 'Email already registered', 409);
      }
      throw err;
    }
    const raw = newOpaqueToken();
    await this.store.saveToken({
      tokenHash: hashToken(raw),
      userId: user.id,
      projectId,
      kind: 'verify',
      expiresAt: new Date(Date.now() + this.config.verifyTtlSeconds * 1000).toISOString(),
      consumedAt: null,
    });
    await this.deps.email.sendVerificationEmail(
      email,
      `${this.deps.appUrl}/verify?token=${raw}&project=${projectId}`,
    );
    this.audit('user.signup', { projectId, userId: user.id });
    return { user: exposeUser(user), verificationSent: true };
  }

  async signIn(
    projectId: string,
    input: { email: string; password: string },
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    const user = await this.store.findUserByEmail(projectId, email);
    // Dummy verify keeps timing ~constant whether the account exists or not.
    const ok = await verifyPassword(String(input.password ?? ''), user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      this.audit('user.login_failed', { projectId });
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }
    if (user.status !== 'active') {
      this.audit('user.login_failed', { projectId, userId: user.id });
      throw new CustomerAuthError('USER_DISABLED', 'Account is disabled', 403);
    }
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.login', { projectId, userId: user.id, sessionId });
    const fresh = await this.store.findUserById(projectId, user.id);
    return { user: exposeUser(fresh ?? user), tokens, sessionId };
  }

  async signOut(projectId: string, sessionId: string, userId: string): Promise<void> {
    await this.store.revokeSession(projectId, sessionId);
    this.audit('user.logout', { projectId, userId, sessionId });
  }

  /** Logout with a refresh token (no access token required). Always succeeds. */
  async signOutByRefresh(projectId: string, refreshToken: string): Promise<void> {
    const session = await this.store.findSessionByRefreshHash(
      projectId,
      hashToken(String(refreshToken ?? '')),
    );
    if (!session) return;
    await this.store.revokeSession(projectId, session.id);
    this.audit('user.logout', { projectId, userId: session.userId, sessionId: session.id });
  }

  async refreshSession(
    projectId: string,
    refreshToken: string,
    _opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const hash = hashToken(String(refreshToken ?? ''));
    const session = await this.store.findSessionByRefreshHash(projectId, hash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) {
      throw new CustomerAuthError('INVALID_REFRESH', 'Invalid or expired refresh token', 401);
    }
    if (session.refreshTokenHash !== hash) {
      // Reuse of an already-rotated token ⇒ probable theft: kill the session.
      await this.store.revokeSession(projectId, session.id);
      this.audit('user.session_revoked', {
        projectId,
        userId: session.userId,
        sessionId: session.id,
      });
      throw new CustomerAuthError('REFRESH_REUSED', 'Refresh token reuse detected', 401);
    }
    const user = await this.store.findUserById(projectId, session.userId);
    if (!user || user.status !== 'active') {
      throw new CustomerAuthError('USER_DISABLED', 'Account is disabled', 403);
    }
    // Rotate in place: retire the presented token, activate the next one.
    const nextRaw = newOpaqueToken();
    await this.store.markRefreshUsed(projectId, session.id, hash);
    await this.store.touchSession(projectId, session.id, hashToken(nextRaw));
    const role = (user.appMetadata['role'] === 'admin' ? 'admin' : 'authenticated') as CustomerRole;
    const accessToken = await signCustomerAccessToken(
      { sub: user.id, email: user.email, sessionId: session.id, role },
      {
        jwtSecret: this.config.jwtSecret,
        issuer: this.config.issuer,
        projectId,
        accessTtlSeconds: this.config.accessTtlSeconds,
      },
    );
    return {
      user: exposeUser(user),
      tokens: {
        accessToken,
        refreshToken: nextRaw,
        expiresIn: this.config.accessTtlSeconds,
        tokenType: 'bearer',
      },
      sessionId: session.id,
    };
  }

  async getUser(projectId: string, userId: string): Promise<ExposedCustomerUser> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    return exposeUser(user);
  }

  /** Session liveness gate: revoked/expired sessions invalidate access tokens. */
  async requireLiveSession(projectId: string, sessionId: string): Promise<CustomerSession> {
    const session = await this.store.findSession(projectId, sessionId);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) {
      throw new CustomerAuthError('SESSION_REVOKED', 'Session is no longer valid', 401);
    }
    return session;
  }

  async updateUser(
    projectId: string,
    userId: string,
    patch: { userMetadata?: unknown },
  ): Promise<ExposedCustomerUser> {
    const metadata =
      patch.userMetadata === undefined ? undefined : sanitizeUserMetadata(patch.userMetadata);
    const updated = await this.store.updateUser(
      projectId,
      userId,
      metadata === undefined ? {} : { userMetadata: metadata },
    );
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    return exposeUser(updated);
  }

  /** Admin-only: disable/enable + set server-side app metadata (roles). */
  async adminUpdateUser(
    projectId: string,
    userId: string,
    patch: { status?: 'active' | 'disabled'; appMetadata?: unknown },
  ): Promise<ExposedCustomerUser> {
    const update: {
      status?: 'active' | 'disabled';
      appMetadata?: Record<string, unknown>;
    } = {};
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'disabled') {
        throw new CustomerAuthError('INVALID_STATUS', 'Invalid status', 400);
      }
      update.status = patch.status;
    }
    if (patch.appMetadata !== undefined)
      update.appMetadata = sanitizeAppMetadata(patch.appMetadata);
    const updated = await this.store.updateUser(projectId, userId, update);
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    if (patch.status === 'disabled') {
      await this.store.revokeUserSessions(projectId, userId);
      this.audit('user.disabled', { projectId, userId });
    }
    return exposeUser(updated);
  }

  async deleteUser(projectId: string, userId: string): Promise<void> {
    const ok = await this.store.deleteUser(projectId, userId);
    if (!ok) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    await this.store.revokeUserSessions(projectId, userId);
    await this.store.deleteUserTokens(projectId, userId);
    this.audit('user.deleted', { projectId, userId });
  }

  async verifyEmail(projectId: string, token: string): Promise<ExposedCustomerUser> {
    const rec = await this.store.findToken(projectId, hashToken(String(token ?? '')), 'verify');
    if (!rec)
      throw new CustomerAuthError('INVALID_TOKEN', 'Invalid or expired verification token', 400);
    await this.store.consumeToken(projectId, rec.tokenHash);
    const updated = await this.store.updateUser(projectId, rec.userId, { emailVerified: true });
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    this.audit('user.email_verified', { projectId, userId: rec.userId });
    return exposeUser(updated);
  }

  /** Always succeeds from the caller's view — never reveals account existence. */
  async requestPasswordReset(projectId: string, email: string): Promise<{ sent: boolean }> {
    const user = await this.store.findUserByEmail(
      projectId,
      String(email ?? '')
        .trim()
        .toLowerCase(),
    );
    if (user && user.status === 'active') {
      const raw = newOpaqueToken();
      await this.store.saveToken({
        tokenHash: hashToken(raw),
        userId: user.id,
        projectId,
        kind: 'reset',
        expiresAt: new Date(Date.now() + this.config.resetTtlSeconds * 1000).toISOString(),
        consumedAt: null,
      });
      await this.deps.email.sendPasswordResetEmail(
        user.email,
        `${this.deps.appUrl}/reset?token=${raw}&project=${projectId}`,
      );
    }
    this.audit('user.password_reset_requested', { projectId });
    return { sent: true };
  }

  async completePasswordReset(projectId: string, token: string, password: string): Promise<void> {
    assertPasswordStrength(String(password ?? ''));
    const rec = await this.store.findToken(projectId, hashToken(String(token ?? '')), 'reset');
    if (!rec) throw new CustomerAuthError('INVALID_TOKEN', 'Invalid or expired reset token', 400);
    await this.store.consumeToken(projectId, rec.tokenHash);
    const updated = await this.store.updateUser(projectId, rec.userId, {
      passwordHash: await hashPassword(password),
    });
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    await this.store.revokeUserSessions(projectId, rec.userId);
    await this.store.deleteUserTokens(projectId, rec.userId);
    this.audit('user.password_reset_completed', { projectId, userId: rec.userId });
  }

  async changePassword(
    projectId: string,
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user || !user.passwordHash) {
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
    }
    const ok = await verifyPassword(String(currentPassword ?? ''), user.passwordHash);
    if (!ok)
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
    assertPasswordStrength(String(newPassword ?? ''));
    await this.store.updateUser(projectId, userId, {
      passwordHash: await hashPassword(newPassword),
    });
    await this.store.deleteUserTokens(projectId, userId);
    this.audit('user.password_changed', { projectId, userId });
  }

  async revokeSession(projectId: string, userId: string, sessionId: string): Promise<void> {
    const session = await this.store.findSession(projectId, sessionId);
    if (!session || session.userId !== userId) {
      throw new CustomerAuthError('SESSION_NOT_FOUND', 'Session not found', 404);
    }
    await this.store.revokeSession(projectId, sessionId);
    this.audit('user.session_revoked', { projectId, userId, sessionId });
  }

  async revokeAllSessions(projectId: string, userId: string): Promise<{ revoked: number }> {
    const revoked = await this.store.revokeUserSessions(projectId, userId);
    this.audit('user.session_revoked', { projectId, userId });
    return { revoked };
  }

  async listSessions(projectId: string, userId: string): Promise<CustomerSession[]> {
    return this.store.listSessions(projectId, userId);
  }

  async listUsers(projectId: string): Promise<ExposedCustomerUser[]> {
    const users = await this.store.listUsers(projectId);
    return users.map(exposeUser);
  }
}
