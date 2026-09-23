import { createHash, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../index.js';
import { AuthError } from '../errors.js';
import type { EmailService } from './email.js';
import { sanitizeAppMetadata, sanitizeUserMetadata } from './metadata.js';
import { generateBackupCodes, generateTotpSecret, totpProvisionUri, verifyTotp } from '../totp.js';
import { createChallenge, verifyAuthentication, verifyRegistration } from '../webauthn.js';
import { checkPasswordPolicy, LEGACY_PASSWORD_POLICY } from '../password-policy.js';
import type { OtpService } from '../otp.js';
import { isValidPhone, type SmsService } from '../sms.js';
import type { CustomerAuthStore } from './store.js';
import { toPublicPasskey } from './types.js';

/** How long a WebAuthn challenge stays usable. Short: it is a live ceremony. */
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
import {
  hashToken,
  newOpaqueToken,
  sanitizeCustomClaims,
  signCustomerAccessToken,
} from './tokens.js';
import type {
  AuthTokens,
  CustomerAuditEvent,
  CustomerAuthConfig,
  CustomerRole,
  CustomerSession,
  CustomerUser,
  ExposedCustomerUser,
} from './types.js';
import type { PasswordPolicy } from '../password-policy.js';
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
  /** Short-lived OTP codes (email/phone/MFA backup path). */
  otp: OtpService;
  /** SMS/WhatsApp delivery for phone OTP. */
  sms: SmsService;
}

const DUMMY_HASH =
  'scrypt:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

function assertPasswordStrength(password: string, policy?: PasswordPolicy | null): void {
  const active = policy ?? LEGACY_PASSWORD_POLICY;
  const { ok, reasons } = checkPasswordPolicy(password, active);
  if (!ok) {
    throw new CustomerAuthError('WEAK_PASSWORD', reasons[0] ?? 'Password too weak', 400);
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

  /**
   * The console's canonical origin, without a trailing slash.
   *
   * Only the email branding normalised APP_URL; the verify, reset and
   * magic-link builders used it raw, so an APP_URL ending in "/" produced
   * links like `https://cloudnivo.org//verify?token=…`. One accessor, used
   * everywhere a link is built.
   */
  private get appOrigin(): string {
    return this.deps.appUrl.replace(/\/+$/, '');
  }

  /** Branding for transactional emails (logo + real product links). */
  private brand(): { appUrl: string; logoUrl: string } {
    const appUrl = this.appOrigin;
    /**
     * PNG, not the app's SVG favicon: Gmail, Outlook and most mail clients
     * refuse to render SVG in an email, so /icon.svg arrived as a
     * broken-image box in the brand slot of every template.
     * apps/dashboard/public/email-logo.png is the same mark rasterised.
     */
    return { appUrl, logoUrl: `${appUrl}/email-logo.png` };
  }

  /**
   * Access token with custom claims: allowlisted scalars from app_metadata
   * (role stays canonical; anonymous sessions are labeled). Reserved names
   * and non-scalars are dropped by sanitizeCustomClaims — claims never
   * break sign-in.
   */
  private accessTokenFor(
    projectId: string,
    user: CustomerUser,
    sessionId: string,
  ): Promise<string> {
    const role = (user.appMetadata['role'] === 'admin' ? 'admin' : 'authenticated') as CustomerRole;
    const customClaims = sanitizeCustomClaims({
      ...(typeof user.appMetadata === 'object' && user.appMetadata !== null
        ? user.appMetadata
        : {}),
      ...(user.isAnonymous ? { anonymous: true } : {}),
    });
    return signCustomerAccessToken(
      {
        sub: user.id,
        email: user.email,
        sessionId,
        role: user.isAnonymous ? 'anonymous' : role,
      },
      {
        jwtSecret: this.config.jwtSecret,
        issuer: this.config.issuer,
        projectId,
        accessTtlSeconds: this.config.accessTtlSeconds,
      },
      customClaims,
    );
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
    const accessToken = await this.accessTokenFor(projectId, user, session.id);
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
    assertPasswordStrength(String(input.password ?? ''), this.config.passwordPolicy);
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
      `${this.appOrigin}/verify?token=${raw}&project=${projectId}`,
      this.brand(),
    );
    this.audit('user.signup', { projectId, userId: user.id });
    return { user: exposeUser(user), verificationSent: true };
  }

  async signIn(
    projectId: string,
    input: { email: string; password: string },
    opts: { ip: string | null; agent: string | null },
  ): Promise<
    | { user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }
    | { mfaRequired: true; mfaTicket: string; userId: string }
  > {
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    const user = await this.store.findUserByEmail(projectId, email);
    // Dummy verify keeps timing ~constant whether the account exists or not.
    const ok = await verifyPassword(String(input.password ?? ''), user?.passwordHash ?? DUMMY_HASH);
    // Anonymous addresses are unguessable; a distinct code is safe and honest.
    if (user && user.isAnonymous) {
      this.audit('user.login_failed', { projectId, userId: user.id });
      throw new CustomerAuthError(
        'ANONYMOUS_CONVERT_REQUIRED',
        'Anonymous account must be converted first',
        403,
      );
    }
    if (!user || !ok) {
      this.audit('user.login_failed', { projectId });
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }
    if (user.status !== 'active') {
      this.audit('user.login_failed', { projectId, userId: user.id });
      throw new CustomerAuthError('USER_DISABLED', 'Account is disabled', 403);
    }
    if (user.totpEnabled && user.totpSecret) {
      const ticket = newOpaqueToken();
      await this.store.saveToken({
        tokenHash: hashToken(ticket),
        userId: user.id,
        projectId,
        kind: 'mfa',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        consumedAt: null,
      });
      this.audit('user.mfa_challenged', { projectId, userId: user.id });
      return { mfaRequired: true, mfaTicket: ticket, userId: user.id };
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
    const accessToken = await this.accessTokenFor(projectId, user, session.id);
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
        `${this.appOrigin}/reset?token=${raw}&project=${projectId}`,
        this.brand(),
      );
    }
    this.audit('user.password_reset_requested', { projectId });
    return { sent: true };
  }

  async completePasswordReset(projectId: string, token: string, password: string): Promise<void> {
    assertPasswordStrength(String(password ?? ''), this.config.passwordPolicy);
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
    assertPasswordStrength(String(newPassword ?? ''), this.config.passwordPolicy);
    await this.store.updateUser(projectId, userId, {
      passwordHash: await hashPassword(newPassword),
    });
    await this.store.revokeUserSessions(projectId, userId);
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

  // ── Anonymous auth + identity linking ──────────────────────────

  /** Create a passwordless anonymous account (convert later via email). */
  async signInAnonymously(
    projectId: string,
    input: { userMetadata?: unknown },
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const metadata =
      input.userMetadata === undefined ? {} : sanitizeUserMetadata(input.userMetadata);
    const user = await this.store.createUser({
      projectId,
      email: `anon_${randomUUID().replace(/-/g, '').slice(0, 12)}@anonymous.local`,
      passwordHash: null,
      userMetadata: metadata,
      isAnonymous: true,
    });
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.anonymous_created', { projectId, userId: user.id, sessionId });
    return { user: exposeUser(user), tokens, sessionId };
  }

  /** Link an anonymous account to a real email+password identity. */
  async convertAnonymous(
    projectId: string,
    userId: string,
    input: { email: string; password: string },
  ): Promise<{ user: ExposedCustomerUser; verificationSent: boolean }> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    if (!user.isAnonymous) {
      throw new CustomerAuthError('NOT_ANONYMOUS', 'Only anonymous accounts can be converted', 400);
    }
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new CustomerAuthError('INVALID_EMAIL', 'Invalid email address', 400);
    }
    assertPasswordStrength(String(input.password ?? ''), this.config.passwordPolicy);
    const existing = await this.store.findUserByEmail(projectId, email);
    if (existing && existing.id !== user.id) {
      throw new CustomerAuthError('EMAIL_TAKEN', 'Email already registered', 409);
    }
    const updated = await this.store.updateUser(projectId, user.id, {
      email,
      passwordHash: await hashPassword(input.password),
      isAnonymous: false,
    });
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
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
      `${this.appOrigin}/verify?token=${raw}&project=${projectId}`,
      this.brand(),
    );
    this.audit('user.converted', { projectId, userId: user.id });
    return { user: exposeUser(updated), verificationSent: true };
  }

  // ── Email OTP + magic links ────────────────────────────────────

  /** Always {sent:true} — never reveals whether the account exists. */
  async requestEmailOtp(
    projectId: string,
    email: string,
    purpose: 'login' | 'verify' = 'login',
  ): Promise<{ sent: boolean }> {
    const normalized = String(email ?? '')
      .trim()
      .toLowerCase();
    const user = await this.store.findUserByEmail(projectId, normalized);
    if (user && user.status === 'active' && !user.isAnonymous) {
      const { code } = await this.deps.otp.issue(projectId, normalized, purpose);
      await this.deps.email.sendOtpEmail(normalized, code, purpose, this.brand());
    }
    this.audit('user.otp_requested', { projectId });
    return { sent: true };
  }

  async verifyEmailOtp(
    projectId: string,
    email: string,
    code: string,
    opts: { ip: string | null; agent: string | null },
    purpose: 'login' | 'verify' = 'login',
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const normalized = String(email ?? '')
      .trim()
      .toLowerCase();
    try {
      await this.deps.otp.verify(projectId, normalized, purpose, code);
    } catch (err) {
      this.audit('user.login_failed', { projectId });
      throw new CustomerAuthError(
        (err as { code?: string }).code ?? 'OTP_INVALID',
        err instanceof Error ? err.message : 'Invalid code',
        (err as { status?: number }).status ?? 401,
      );
    }
    const user = await this.store.findUserByEmail(projectId, normalized);
    if (!user || user.status !== 'active' || user.isAnonymous) {
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Invalid code', 401);
    }
    if (purpose === 'verify' && !user.emailVerified) {
      await this.store.updateUser(projectId, user.id, { emailVerified: true });
    }
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.otp_verified', { projectId, userId: user.id, sessionId });
    const fresh = await this.store.findUserById(projectId, user.id);
    return { user: exposeUser(fresh ?? user), tokens, sessionId };
  }

  /** Magic link (creates a passwordless account on first use — rate-limited at routes). */
  async requestMagicLink(projectId: string, email: string): Promise<{ sent: boolean }> {
    const normalized = String(email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
      return { sent: true };
    }
    let user = await this.store.findUserByEmail(projectId, normalized);
    if (!user) {
      try {
        user = await this.store.createUser({
          projectId,
          email: normalized,
          passwordHash: null,
          userMetadata: {},
        });
      } catch {
        return { sent: true };
      }
    }
    if (user.status !== 'active' || user.isAnonymous) return { sent: true };
    const raw = newOpaqueToken();
    await this.store.saveToken({
      tokenHash: hashToken(raw),
      userId: user.id,
      projectId,
      kind: 'magic',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      consumedAt: null,
    });
    await this.deps.email.sendMagicLink(
      normalized,
      `${this.appOrigin}/magic?token=${raw}&project=${projectId}`,
      this.brand(),
    );
    this.audit('user.magic_requested', { projectId });
    return { sent: true };
  }

  async consumeMagicLink(
    projectId: string,
    token: string,
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const rec = await this.store.findToken(projectId, hashToken(String(token ?? '')), 'magic');
    if (!rec) throw new CustomerAuthError('INVALID_TOKEN', 'Invalid or expired link', 400);
    await this.store.consumeToken(projectId, rec.tokenHash);
    const user = await this.store.findUserById(projectId, rec.userId);
    if (!user || user.status !== 'active' || user.isAnonymous) {
      throw new CustomerAuthError('INVALID_TOKEN', 'Invalid or expired link', 400);
    }
    if (!user.emailVerified) {
      await this.store.updateUser(projectId, user.id, { emailVerified: true });
    }
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.magic_consumed', { projectId, userId: user.id, sessionId });
    const fresh = await this.store.findUserById(projectId, user.id);
    return { user: exposeUser(fresh ?? user), tokens, sessionId };
  }

  // ── TOTP MFA ───────────────────────────────────────────────────

  /** Start MFA enrollment. Returns the secret + otpauth URI (show once as QR). */
  // ── Passkeys (WebAuthn) ──────────────────────────────────────────────

  /**
   * Begin registration. The challenge is stored server-side and spent on
   * verify, so the browser cannot choose or reuse it.
   */
  async beginPasskeyRegistration(
    projectId: string,
    userId: string,
  ): Promise<{ challenge: string; excludeCredentials: string[] }> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    if (user.isAnonymous) {
      throw new CustomerAuthError(
        'NOT_SUPPORTED',
        'Anonymous accounts cannot register a passkey',
        400,
      );
    }
    const challenge = createChallenge();
    await this.store.savePasskeyChallenge({
      projectId,
      challenge,
      userId,
      kind: 'register',
      expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_TTL_MS).toISOString(),
    });
    // Lets the browser refuse to enrol a key this user already has, instead
    // of creating a duplicate the user cannot tell apart.
    const existing = await this.store.listPasskeys(projectId, userId);
    return { challenge, excludeCredentials: existing.map(c => c.credentialId) };
  }

  async finishPasskeyRegistration(
    projectId: string,
    userId: string,
    input: {
      challenge: string;
      attestationObject: string;
      clientDataJSON: string;
      label?: string | null;
      origins: string[];
      rpId: string;
    },
  ): Promise<{ id: string; label: string | null }> {
    const pending = await this.store.consumePasskeyChallenge(
      projectId,
      input.challenge,
      'register',
    );
    if (!pending || pending.userId !== userId) {
      throw new CustomerAuthError('PASSKEY_CHALLENGE_INVALID', 'Challenge expired or unknown', 400);
    }
    const cred = verifyRegistration({
      attestationObject: input.attestationObject,
      clientDataJSON: input.clientDataJSON,
      expectedChallenge: input.challenge,
      expectedOrigins: input.origins,
      expectedRpId: input.rpId,
    });

    // A credential id is globally unique; if it is already registered - to
    // anyone - re-binding it would let one account capture another's key.
    const clash = await this.store.findPasskey(projectId, cred.credentialId);
    if (clash) {
      throw new CustomerAuthError('PASSKEY_EXISTS', 'This passkey is already registered', 409);
    }

    await this.store.savePasskey({
      projectId,
      credentialId: cred.credentialId,
      userId,
      publicKey: cred.publicKey,
      algorithm: cred.algorithm,
      signCount: cred.signCount,
      aaguid: cred.aaguid,
      fmt: cred.fmt,
      label: input.label?.slice(0, 80) ?? null,
      backedUp: cred.backedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    this.audit('user.passkey_registered', { projectId, userId });
    return { id: cred.credentialId.slice(0, 16), label: input.label ?? null };
  }

  /**
   * Begin authentication. Deliberately takes no user identifier and reveals
   * nothing: a challenge is issued whether or not any account exists, so this
   * endpoint cannot be used to enumerate users.
   */
  async beginPasskeyAuthentication(projectId: string): Promise<{ challenge: string }> {
    const challenge = createChallenge();
    await this.store.savePasskeyChallenge({
      projectId,
      challenge,
      userId: null,
      kind: 'authenticate',
      expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_TTL_MS).toISOString(),
    });
    return { challenge };
  }

  async finishPasskeyAuthentication(
    projectId: string,
    input: {
      challenge: string;
      credentialId: string;
      authenticatorData: string;
      clientDataJSON: string;
      signature: string;
      origins: string[];
      rpId: string;
    },
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens }> {
    const pending = await this.store.consumePasskeyChallenge(
      projectId,
      input.challenge,
      'authenticate',
    );
    if (!pending) {
      throw new CustomerAuthError('PASSKEY_CHALLENGE_INVALID', 'Challenge expired or unknown', 400);
    }

    const cred = await this.store.findPasskey(projectId, input.credentialId);
    /**
     * One message and one status for "no such credential", "bad signature"
     * and "disabled account". Telling them apart would turn this endpoint
     * into an oracle for which passkeys and which users exist.
     */
    if (!cred) {
      throw new CustomerAuthError('PASSKEY_INVALID', 'Passkey authentication failed', 401);
    }

    let result: ReturnType<typeof verifyAuthentication>;
    try {
      result = verifyAuthentication({
        credentialId: input.credentialId,
        authenticatorData: input.authenticatorData,
        clientDataJSON: input.clientDataJSON,
        signature: input.signature,
        storedPublicKey: cred.publicKey,
        storedAlgorithm: cred.algorithm,
        storedSignCount: cred.signCount,
        expectedChallenge: input.challenge,
        expectedOrigins: input.origins,
        expectedRpId: input.rpId,
      });
    } catch {
      throw new CustomerAuthError('PASSKEY_INVALID', 'Passkey authentication failed', 401);
    }

    const user = await this.store.findUserById(projectId, cred.userId);
    if (!user || user.status !== 'active') {
      throw new CustomerAuthError('PASSKEY_INVALID', 'Passkey authentication failed', 401);
    }

    /**
     * A counter that went backwards is the spec's clone signal. The
     * credential is kept but the login is refused: deleting it would let an
     * attacker with a stolen assertion lock the real owner out.
     */
    if (result.signCountSuspect) {
      this.audit('user.passkey_clone_suspected', { projectId, userId: user.id });
      throw new CustomerAuthError(
        'PASSKEY_COUNTER_REGRESSED',
        'This passkey may have been cloned. Sign in another way and remove it.',
        401,
      );
    }

    await this.store.touchPasskey(projectId, cred.credentialId, result.signCount);
    const { tokens } = await this.issueSession(projectId, user, opts);
    await this.store.updateUser(projectId, user.id, { lastSignInAt: new Date().toISOString() });
    this.audit('user.passkey_authenticated', { projectId, userId: user.id });
    return { user: exposeUser(user), tokens };
  }

  async listPasskeys(
    projectId: string,
    userId: string,
  ): Promise<ReturnType<typeof toPublicPasskey>[]> {
    const creds = await this.store.listPasskeys(projectId, userId);
    return creds.map(toPublicPasskey);
  }

  /** Removes a passkey by its public handle (the first 16 chars of the id). */
  async removePasskey(projectId: string, userId: string, handle: string): Promise<boolean> {
    const creds = await this.store.listPasskeys(projectId, userId);
    const match = creds.find(c => c.credentialId.slice(0, 16) === handle);
    if (!match) return false;
    const removed = await this.store.deletePasskey(projectId, userId, match.credentialId);
    if (removed) this.audit('user.passkey_removed', { projectId, userId });
    return removed;
  }

  async enrollTotp(projectId: string, userId: string): Promise<{ secret: string; uri: string }> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    if (user.isAnonymous)
      throw new CustomerAuthError('NOT_SUPPORTED', 'Anonymous accounts cannot use MFA', 400);
    const secret = generateTotpSecret();
    await this.store.updateUser(projectId, userId, { totpSecret: secret, totpEnabled: false });
    this.audit('user.mfa_enrolled', { projectId, userId });
    return { secret, uri: totpProvisionUri({ secret, account: user.email }) };
  }

  /** Confirm enrollment with a live code. Returns single-use backup codes (show once). */
  async confirmTotp(
    projectId: string,
    userId: string,
    code: string,
  ): Promise<{ enabled: boolean; backupCodes: string[] }> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user?.totpSecret)
      throw new CustomerAuthError('MFA_NOT_ENROLLED', 'MFA enrollment not started', 400);
    if (!verifyTotp(user.totpSecret, code)) {
      throw new CustomerAuthError('MFA_INVALID', 'Incorrect authenticator code', 401);
    }
    const { codes, hashes } = generateBackupCodes();
    await this.store.updateUser(projectId, userId, { totpEnabled: true, backupCodeHashes: hashes });
    return { enabled: true, backupCodes: codes };
  }

  async disableTotp(projectId: string, userId: string, code: string): Promise<void> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user?.totpSecret || !user.totpEnabled) {
      throw new CustomerAuthError('MFA_NOT_ENROLLED', 'MFA is not enabled', 400);
    }
    if (!verifyTotp(user.totpSecret, code)) {
      throw new CustomerAuthError('MFA_INVALID', 'Incorrect authenticator code', 401);
    }
    await this.store.updateUser(projectId, userId, {
      totpSecret: null,
      totpEnabled: false,
      backupCodeHashes: [],
    });
    this.audit('user.mfa_disabled', { projectId, userId });
  }

  /** Exchange an MFA ticket + TOTP/backup code for a session. */
  async verifyMfa(
    projectId: string,
    mfaTicket: string,
    code: string,
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const rec = await this.store.findToken(projectId, hashToken(String(mfaTicket ?? '')), 'mfa');
    if (!rec) throw new CustomerAuthError('MFA_EXPIRED', 'Challenge expired — sign in again', 401);
    await this.store.consumeToken(projectId, rec.tokenHash);
    const user = await this.store.findUserById(projectId, rec.userId);
    if (!user || user.status !== 'active' || !user.totpEnabled || !user.totpSecret) {
      throw new CustomerAuthError('MFA_INVALID', 'MFA verification failed', 401);
    }
    const presented = String(code ?? '').replace(/[\s-]/g, '');
    let ok = verifyTotp(user.totpSecret, presented);
    if (!ok) {
      // Single-use backup code fallback.
      const hash = createHash('sha256').update(presented).digest('hex');
      const remaining = user.backupCodeHashes.filter(h => h !== hash);
      if (remaining.length !== user.backupCodeHashes.length) {
        await this.store.updateUser(projectId, user.id, { backupCodeHashes: remaining });
        ok = true;
      }
    }
    if (!ok) {
      this.audit('user.login_failed', { projectId, userId: user.id });
      throw new CustomerAuthError('MFA_INVALID', 'Incorrect code', 401);
    }
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.mfa_verified', { projectId, userId: user.id, sessionId });
    const fresh = await this.store.findUserById(projectId, user.id);
    return { user: exposeUser(fresh ?? user), tokens, sessionId };
  }

  // ── Phone OTP ──────────────────────────────────────────────────

  async updatePhone(
    projectId: string,
    userId: string,
    phone: string,
  ): Promise<ExposedCustomerUser> {
    const normalized = String(phone ?? '').trim();
    if (!isValidPhone(normalized)) {
      throw new CustomerAuthError('INVALID_PHONE', 'Phone must be E.164 (+15551234567)', 400);
    }
    const updated = await this.store.updateUser(projectId, userId, {
      phone: normalized,
      phoneVerified: false,
    });
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    return exposeUser(updated);
  }

  /** Send a phone code via the configured SMS provider (honest when undeliverable). */
  async requestPhoneOtp(
    projectId: string,
    userId: string,
  ): Promise<{ sent: boolean; delivered: boolean }> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user?.phone) throw new CustomerAuthError('PHONE_MISSING', 'No phone number on file', 400);
    if (user.status !== 'active')
      throw new CustomerAuthError('USER_DISABLED', 'Account is disabled', 403);
    const { code } = await this.deps.otp.issue(projectId, `phone:${user.phone}`, 'phone');
    const receipt = await this.deps.sms.send({
      to: user.phone,
      body: `Your CloudNivo code is: ${code}. It expires in 10 minutes.`,
      channel: 'sms',
    });
    this.audit('user.otp_requested', { projectId, userId });
    return { sent: true, delivered: receipt.delivered };
  }

  async verifyPhoneOtp(
    projectId: string,
    userId: string,
    code: string,
  ): Promise<ExposedCustomerUser> {
    const user = await this.store.findUserById(projectId, userId);
    if (!user?.phone) throw new CustomerAuthError('PHONE_MISSING', 'No phone number on file', 400);
    try {
      await this.deps.otp.verify(projectId, `phone:${user.phone}`, 'phone', code);
    } catch (err) {
      throw new CustomerAuthError(
        (err as { code?: string }).code ?? 'OTP_INVALID',
        err instanceof Error ? err.message : 'Invalid code',
        (err as { status?: number }).status ?? 401,
      );
    }
    const updated = await this.store.updateUser(projectId, user.id, { phoneVerified: true });
    if (!updated) throw new CustomerAuthError('USER_NOT_FOUND', 'User not found', 404);
    this.audit('user.phone_verified', { projectId, userId });
    return exposeUser(updated);
  }

  /** Passwordless phone sign-in: code goes to the account holding the number. */
  async requestLoginOtp(
    projectId: string,
    phone: string,
  ): Promise<{ sent: boolean; delivered: boolean }> {
    const normalized = String(phone ?? '').trim();
    if (!isValidPhone(normalized)) return { sent: true, delivered: false };
    const user = await this.store.findUserByPhone(projectId, normalized);
    if (user && user.status === 'active' && !user.isAnonymous) {
      const { code } = await this.deps.otp.issue(projectId, `phone:${normalized}`, 'phone');
      const receipt = await this.deps.sms
        .send({
          to: normalized,
          body: `Your CloudNivo code is: ${code}. It expires in 10 minutes.`,
          channel: 'sms',
        })
        .catch(() => ({ delivered: false, queued: false, id: 'failed', driver: 'none' }));
      this.audit('user.otp_requested', { projectId });
      return { sent: true, delivered: receipt.delivered };
    }
    return { sent: true, delivered: false };
  }

  async verifyLoginOtp(
    projectId: string,
    phone: string,
    code: string,
    opts: { ip: string | null; agent: string | null },
  ): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
    const normalized = String(phone ?? '').trim();
    try {
      await this.deps.otp.verify(projectId, `phone:${normalized}`, 'phone', code);
    } catch (err) {
      this.audit('user.login_failed', { projectId });
      throw new CustomerAuthError(
        (err as { code?: string }).code ?? 'OTP_INVALID',
        err instanceof Error ? err.message : 'Invalid code',
        (err as { status?: number }).status ?? 401,
      );
    }
    const user = await this.store.findUserByPhone(projectId, normalized);
    if (!user || user.status !== 'active' || user.isAnonymous) {
      throw new CustomerAuthError('INVALID_CREDENTIALS', 'Invalid code', 401);
    }
    if (!user.phoneVerified) {
      await this.store.updateUser(projectId, user.id, { phoneVerified: true });
    }
    const { sessionId, tokens } = await this.issueSession(projectId, user, opts);
    this.audit('user.otp_verified', { projectId, userId: user.id, sessionId });
    const fresh = await this.store.findUserById(projectId, user.id);
    return { user: exposeUser(fresh ?? user), tokens, sessionId };
  }
}
