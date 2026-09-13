import { describe, expect, it } from 'vitest';
import { MemoryEmailService } from './email.js';
import { MemoryOtpStore, OtpService } from '../otp.js';
import { MemorySmsService } from '../sms.js';
import { DEFAULT_PASSWORD_POLICY } from '../password-policy.js';
import { totpNow } from '../totp.js';
import { MetadataError, sanitizeAppMetadata, sanitizeUserMetadata } from './metadata.js';
import { ownerPolicies, ownerScope, policiesToSql, requestContextSql } from './rls.js';
import { CustomerAuthService } from './service.js';
import type { AuthTokens, ExposedCustomerUser } from './types.js';
import { MemoryCustomerAuthStore } from './store.js';
import { hashToken, newOpaqueToken, verifyCustomerAccessToken } from './tokens.js';

const SECRET = 'c'.repeat(48);

function service() {
  const store = new MemoryCustomerAuthStore();
  const email = new MemoryEmailService();
  const sms = new MemorySmsService();
  const audits: { event: string; fields: Record<string, unknown> }[] = [];
  const svc = new CustomerAuthService({
    store,
    email,
    config: {
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2592000,
      resetTtlSeconds: 3600,
      verifyTtlSeconds: 86400,
      emailDriver: 'memory',
      jwtSecret: SECRET,
      issuer: 'cloudnivo-test',
    },
    audit: (event, fields) => audits.push({ event, fields }),
    appUrl: 'http://localhost:3000',
    otp: new OtpService(new MemoryOtpStore()),
    sms,
  });
  return { svc, store, email, sms, audits };
}

const PID = '11111111-1111-4111-8111-111111111111';

/** Sign in expecting a full session (fails the test on an MFA challenge). */
async function signInSession(
  svc: CustomerAuthService,
  project: string,
  email: string,
  password: string,
): Promise<{ user: ExposedCustomerUser; tokens: AuthTokens; sessionId: string }> {
  const out = await svc.signIn(project, { email, password }, { ip: null, agent: null });
  if (!('tokens' in out)) throw new Error('expected session, got MFA challenge');
  return out;
}

describe('customer signup/login', () => {
  it('signs up, verifies, logs in with tokens', async () => {
    const { svc, email } = service();
    const { user } = await svc.signUp(PID, { email: 'u@example.com', password: 'correct-horse-1' });
    expect(user.emailVerified).toBe(false);
    expect('passwordHash' in user).toBe(false);
    const sent = email.lastTo('u@example.com');
    expect(sent).not.toBe(null);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent?.text ?? '')?.[1] ?? '';
    const verified = await svc.verifyEmail(PID, token);
    expect(verified.emailVerified).toBe(true);
    await expect(svc.verifyEmail(PID, token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

    const login = await signInSession(svc, PID, 'u@example.com', 'correct-horse-1');
    expect(login.tokens.tokenType).toBe('bearer');
    const claims = await verifyCustomerAccessToken(login.tokens.accessToken, {
      jwtSecret: SECRET,
      issuer: 'cloudnivo-test',
      projectId: PID,
    });
    expect(claims.sub).toBe(user.id);
    expect(claims.sessionId).toBe(login.sessionId);
  });

  it('rejects duplicates, weak passwords, bad logins — neutrally', async () => {
    const { svc } = service();
    await svc.signUp(PID, { email: 'a@example.com', password: 'long-enough-1' });
    await expect(
      svc.signUp(PID, { email: 'a@example.com', password: 'long-enough-1' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    await expect(
      svc.signUp(PID, { email: 'b@example.com', password: 'short' }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(
      svc.signIn(
        PID,
        { email: 'nobody@example.com', password: 'whatever-123' },
        { ip: null, agent: null },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(
      svc.signIn(
        PID,
        { email: 'a@example.com', password: 'wrong-pass-1' },
        { ip: null, agent: null },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('isolates users per project', async () => {
    const { svc } = service();
    const other = '22222222-2222-4222-8222-222222222222';
    await svc.signUp(PID, { email: 'same@example.com', password: 'long-enough-1' });
    await svc.signUp(other, { email: 'same@example.com', password: 'long-enough-1' });
    await expect(
      svc.signIn(
        other,
        { email: 'same@example.com', password: 'wrong-0000' },
        { ip: null, agent: null },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('refresh rotation + reuse detection', () => {
  it('rotates refresh tokens and kills sessions on reuse', async () => {
    const { svc } = service();
    await svc.signUp(PID, { email: 'r@example.com', password: 'long-enough-1' });
    const login = await signInSession(svc, PID, 'r@example.com', 'long-enough-1');
    const r1 = await svc.refreshSession(PID, login.tokens.refreshToken, { ip: null, agent: null });
    expect(r1.sessionId).toBe(login.sessionId);
    expect(r1.tokens.refreshToken).not.toBe(login.tokens.refreshToken);
    // Reuse the retired token ⇒ theft response.
    await expect(
      svc.refreshSession(PID, login.tokens.refreshToken, { ip: null, agent: null }),
    ).rejects.toMatchObject({
      code: 'REFRESH_REUSED',
    });
    // Session is dead now — even the rotated token fails.
    await expect(
      svc.refreshSession(PID, r1.tokens.refreshToken, { ip: null, agent: null }),
    ).rejects.toMatchObject({
      code: 'INVALID_REFRESH',
    });
  });

  it('logout revokes; disabled users cannot sign in', async () => {
    const { svc } = service();
    const { user } = await svc.signUp(PID, { email: 'l@example.com', password: 'long-enough-1' });
    const login = await signInSession(svc, PID, 'l@example.com', 'long-enough-1');
    await svc.signOut(PID, login.sessionId, user.id);
    await expect(
      svc.refreshSession(PID, login.tokens.refreshToken, { ip: null, agent: null }),
    ).rejects.toMatchObject({
      code: 'INVALID_REFRESH',
    });
    await svc.adminUpdateUser(PID, user.id, { status: 'disabled' });
    await expect(
      svc.signIn(
        PID,
        { email: 'l@example.com', password: 'long-enough-1' },
        { ip: null, agent: null },
      ),
    ).rejects.toMatchObject({ code: 'USER_DISABLED' });
  });
});

describe('password reset + change', () => {
  it('resets via single-use token and revokes sessions', async () => {
    const { svc, email } = service();
    await svc.signUp(PID, { email: 'p@example.com', password: 'old-password-1' });
    const req = await svc.requestPasswordReset(PID, 'p@example.com');
    expect(req.sent).toBe(true);
    // Enumeration-neutral for unknown emails too.
    expect((await svc.requestPasswordReset(PID, 'ghost@example.com')).sent).toBe(true);
    const token =
      /token=([A-Za-z0-9_-]+)/.exec(email.lastTo('p@example.com')?.text ?? '')?.[1] ?? '';
    await svc.completePasswordReset(PID, token, 'new-password-2');
    await expect(svc.completePasswordReset(PID, token, 'new-password-3')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    await svc.signIn(
      PID,
      { email: 'p@example.com', password: 'new-password-2' },
      { ip: null, agent: null },
    );
  });

  it('changes passwords only with the current one', async () => {
    const { svc } = service();
    const { user } = await svc.signUp(PID, { email: 'c@example.com', password: 'old-password-1' });
    await expect(
      svc.changePassword(PID, user.id, 'wrong-0000', 'new-password-2'),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await svc.changePassword(PID, user.id, 'old-password-1', 'new-password-2');
  });
});

describe('metadata guards', () => {
  it('allows profile fields, blocks roles and unknowns', () => {
    expect(sanitizeUserMetadata({ display_name: 'Ada', locale: 'en' })).toEqual({
      display_name: 'Ada',
      locale: 'en',
    });
    expect(() => sanitizeUserMetadata({ role: 'admin' })).toThrow(MetadataError);
    expect(() => sanitizeUserMetadata({ admin: true })).toThrow(MetadataError);
    expect(() => sanitizeUserMetadata({ totally_new: 1 })).toThrow(MetadataError);
    expect(sanitizeAppMetadata({ role: 'admin' })).toEqual({ role: 'admin' });
    expect(() => sanitizeAppMetadata({ role: 'superuser' })).toThrow(MetadataError);
  });

  it('strips hashes and project ids from exposed users', async () => {
    const { svc } = service();
    const { user } = await svc.signUp(PID, { email: 'e@example.com', password: 'long-enough-1' });
    expect('passwordHash' in user).toBe(false);
    expect('projectId' in user).toBe(false);
    const updated = await svc.updateUser(PID, user.id, { userMetadata: { display_name: 'E' } });
    expect(updated.userMetadata).toEqual({ display_name: 'E' });
    await expect(
      svc.updateUser(PID, user.id, { userMetadata: { role: 'admin' } }),
    ).rejects.toThrow();
  });
});

describe('tokens + sessions', () => {
  it('hashes opaque tokens and lists/revokes sessions', async () => {
    expect(hashToken('x')).toHaveLength(64);
    expect(newOpaqueToken()).not.toBe(newOpaqueToken());
    const { svc } = service();
    const { user } = await svc.signUp(PID, { email: 's@example.com', password: 'long-enough-1' });
    const a = await signInSession(svc, PID, 's@example.com', 'long-enough-1');
    const b = await signInSession(svc, PID, 's@example.com', 'long-enough-1');
    const sessions = await svc.listSessions(PID, user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.refreshTokenHash).toBe('');
    await svc.revokeSession(PID, user.id, a.sessionId);
    expect((await svc.listSessions(PID, user.id)).map(s => s.id)).toEqual([b.sessionId]);
    const { revoked } = await svc.revokeAllSessions(PID, user.id);
    expect(revoked).toBe(1);
  });
});

describe('rls foundation', () => {
  it('generates executable policy SQL for owner tables', () => {
    const sql = policiesToSql('public', 'posts');
    expect(sql[0]).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql.join('\n')).toContain('app.user_id');
    expect(sql.join('\n')).toContain('service_role');
    expect(() => policiesToSql('public', 'posts; DROP')).toThrow();
  });

  it('scopes engine queries to owners, bypasses admins', () => {
    expect(ownerScope(['id', 'user_id'], 'authenticated', 'u1')).toEqual({
      column: 'user_id',
      userId: 'u1',
    });
    expect(ownerScope(['id', 'user_id'], 'admin', 'u1')).toBe(null);
    expect(ownerScope(['id', 'user_id'], 'service_role', 'u1')).toBe(null);
    expect(ownerScope(['id'], 'authenticated', 'u1')).toBe(null);
    expect(
      requestContextSql('11111111-1111-4111-8111-111111111111', 'authenticated').params,
    ).toHaveLength(2);
    expect(() => requestContextSql('not-a-uuid', 'authenticated')).toThrow();
    expect(ownerPolicies('public', 'posts')).toHaveLength(4);
  });
});

describe('anonymous auth + identity linking', () => {
  it('creates anonymous sessions and converts them to email identities', async () => {
    const { svc } = service();
    const anon = await svc.signInAnonymously(PID, {}, { ip: null, agent: null });
    expect(anon.user.isAnonymous).toBe(true);
    expect(anon.user.role).toBe('anonymous');
    expect('passwordHash' in anon.user).toBe(false);
    // Password login is impossible before conversion.
    await expect(
      svc.signIn(PID, { email: anon.user.email, password: 'whatever-123' }, { ip: null, agent: null }),
    ).rejects.toMatchObject({ code: 'ANONYMOUS_CONVERT_REQUIRED' });
    const converted = await svc.convertAnonymous(PID, anon.user.id, {
      email: 'human@example.com',
      password: 'long-enough-1',
    });
    expect(converted.user.isAnonymous).toBe(false);
    expect(converted.verificationSent).toBe(true);
    const login = await signInSession(svc, PID, 'human@example.com', 'long-enough-1');
    expect(login.user.role).toBe('authenticated');
    // Double conversion is rejected.
    await expect(
      svc.convertAnonymous(PID, anon.user.id, { email: 'other@example.com', password: 'long-enough-1' }),
    ).rejects.toMatchObject({ code: 'NOT_ANONYMOUS' });
  });
});

describe('email OTP + magic links', () => {
  it('logs in with a one-time code (single use, neutral responses)', async () => {
    const { svc, email } = service();
    await svc.signUp(PID, { email: 'otp@example.com', password: 'long-enough-1' });
    expect((await svc.requestEmailOtp(PID, 'otp@example.com', 'login')).sent).toBe(true);
    expect((await svc.requestEmailOtp(PID, 'ghost@example.com', 'login')).sent).toBe(true);
    const code = /(\d{6})/.exec(email.lastTo('otp@example.com')?.text ?? '')?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const login = await svc.verifyEmailOtp(PID, 'otp@example.com', code, { ip: null, agent: null });
    expect(login.tokens.tokenType).toBe('bearer');
    await expect(
      svc.verifyEmailOtp(PID, 'otp@example.com', code, { ip: null, agent: null }),
    ).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
    await expect(
      svc.verifyEmailOtp(PID, 'otp@example.com', '000000', { ip: null, agent: null }),
    ).rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  it('signs in with magic links (single use)', async () => {
    const { svc, email } = service();
    await svc.signUp(PID, { email: 'magic@example.com', password: 'long-enough-1' });
    expect((await svc.requestMagicLink(PID, 'magic@example.com')).sent).toBe(true);
    const token =
      /token=([A-Za-z0-9_-]+)/.exec(email.lastTo('magic@example.com')?.text ?? '')?.[1] ?? '';
    const login = await svc.consumeMagicLink(PID, token, { ip: null, agent: null });
    expect(login.user.emailVerified).toBe(true);
    await expect(svc.consumeMagicLink(PID, token, { ip: null, agent: null })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

describe('totp mfa', () => {
  it('enrolls, challenges password login, verifies, disables', async () => {
    const { svc, store } = service();
    await svc.signUp(PID, { email: 'mfa@example.com', password: 'long-enough-1' });
    const created = await store.findUserByEmail(PID, 'mfa@example.com');
    if (!created) throw new Error('user missing');
    const enrolled = await svc.enrollTotp(PID, created.id);
    expect(enrolled.secret.length).toBeGreaterThan(15);
    expect(enrolled.uri).toContain('otpauth://totp/');
    // Secret must never leak through the exposed user.
    const listed = await svc.listUsers(PID);
    expect('totpSecret' in (listed[0] as unknown as Record<string, unknown>)).toBe(false);
    const { backupCodes } = await svc.confirmTotp(PID, created.id, totpNow(enrolled.secret));
    expect(backupCodes).toHaveLength(10);
    // Password login now returns a challenge instead of a session.
    const challenged = await svc.signIn(
      PID,
      { email: 'mfa@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
    if (!('mfaRequired' in challenged)) throw new Error('expected MFA challenge');
    expect(challenged.mfaTicket.length).toBeGreaterThan(10);
    // Wrong code burns the single-use ticket...
    await expect(
      svc.verifyMfa(PID, challenged.mfaTicket, '000000', { ip: null, agent: null }),
    ).rejects.toMatchObject({ code: 'MFA_INVALID' });
    // ...so a fresh challenge is needed for the live code.
    const challenged2 = await svc.signIn(
      PID,
      { email: 'mfa@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
    if (!('mfaRequired' in challenged2)) throw new Error('expected MFA challenge');
    const verified = await svc.verifyMfa(PID, challenged2.mfaTicket, totpNow(enrolled.secret), {
      ip: null,
      agent: null,
    });
    expect(verified.tokens.tokenType).toBe('bearer');
  });

  it('accepts live codes and single-use backup codes', async () => {
    const { svc, store } = service();
    await svc.signUp(PID, { email: 'mfa2@example.com', password: 'long-enough-1' });
    const created = await store.findUserByEmail(PID, 'mfa2@example.com');
    if (!created) throw new Error('user missing');
    const enrolled = await svc.enrollTotp(PID, created.id);
    const { backupCodes } = await svc.confirmTotp(PID, created.id, totpNow(enrolled.secret));
    const challenged = await svc.signIn(
      PID,
      { email: 'mfa2@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
    if (!('mfaRequired' in challenged)) throw new Error('expected MFA challenge');
    const verified = await svc.verifyMfa(PID, challenged.mfaTicket, totpNow(enrolled.secret), {
      ip: null,
      agent: null,
    });
    expect(verified.tokens.tokenType).toBe('bearer');
    // Backup code works once, then dies.
    const challenged2 = await svc.signIn(
      PID,
      { email: 'mfa2@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
    if (!('mfaRequired' in challenged2)) throw new Error('expected MFA challenge');
    await svc.verifyMfa(PID, challenged2.mfaTicket, backupCodes[0] as string, {
      ip: null,
      agent: null,
    });
    const challenged3 = await svc.signIn(
      PID,
      { email: 'mfa2@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
    if (!('mfaRequired' in challenged3)) throw new Error('expected MFA challenge');
    await expect(
      svc.verifyMfa(PID, challenged3.mfaTicket, backupCodes[0] as string, {
        ip: null,
        agent: null,
      }),
    ).rejects.toMatchObject({ code: 'MFA_INVALID' });
    // Disable with a live code restores plain password login.
    await svc.disableTotp(PID, created.id, totpNow(enrolled.secret));
    await signInSession(svc, PID, 'mfa2@example.com', 'long-enough-1');
  });
});

describe('phone otp', () => {
  it('sets, verifies, and passwordlessly logs in by phone', async () => {
    const { svc, sms } = service();
    const { user } = await svc.signUp(PID, { email: 'ph@example.com', password: 'long-enough-1' });
    await expect(svc.updatePhone(PID, user.id, 'not-a-phone')).rejects.toMatchObject({
      code: 'INVALID_PHONE',
    });
    await svc.updatePhone(PID, user.id, '+15551234567');
    const req = await svc.requestPhoneOtp(PID, user.id);
    expect(req.sent).toBe(true);
    const otpCode = /(\d{6})/.exec(sms.lastTo('+15551234567')?.body ?? '')?.[1] ?? '';
    expect(otpCode).toMatch(/^\d{6}$/);
    // Wrong code fails...
    await expect(svc.verifyPhoneOtp(PID, user.id, '000000')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    const verified = await svc.verifyPhoneOtp(PID, user.id, otpCode);
    expect(verified.phoneVerified).toBe(true);
    // Passwordless login by phone.
    await svc.requestLoginOtp(PID, '+15551234567');
    const loginCode = /(\d{6})/.exec(sms.lastTo('+15551234567')?.body ?? '')?.[1] ?? '';
    const login = await svc.verifyLoginOtp(PID, '+15551234567', loginCode, {
      ip: null,
      agent: null,
    });
    expect(login.tokens.tokenType).toBe('bearer');
  });
});

describe('custom claims + password policy', () => {
  it('injects allowlisted app_metadata scalars into JWTs', async () => {
    const { svc } = service();
    const { user } = await svc.signUp(PID, { email: 'cl@example.com', password: 'long-enough-1' });
    await svc.adminUpdateUser(PID, user.id, {
      appMetadata: { role: 'authenticated', plan: 'pro', seats: 5, admin: true },
    });
    const login = await signInSession(svc, PID, 'cl@example.com', 'long-enough-1');
    const claims = await verifyCustomerAccessToken(login.tokens.accessToken, {
      jwtSecret: SECRET,
      issuer: 'cloudnivo-test',
      projectId: PID,
    });
    const raw = claims as unknown as Record<string, unknown>;
    expect(raw['plan']).toBe('pro');
    expect(raw['seats']).toBe(5);
    expect(raw['role']).toBe('authenticated');
  });

  it('enforces a configured policy, keeps legacy default', async () => {
    const { svc } = service();
    // Legacy default: 8-char passwords still accepted.
    await svc.signUp(PID, { email: 'leg@example.com', password: 'long-enough-1' });
    const strictSvc = new CustomerAuthService({
      store: new MemoryCustomerAuthStore(),
      email: new MemoryEmailService(),
      config: {
        accessTtlSeconds: 900,
        refreshTtlSeconds: 100,
        resetTtlSeconds: 100,
        verifyTtlSeconds: 100,
        emailDriver: 'memory',
        jwtSecret: SECRET,
        issuer: 'cloudnivo-test',
        passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, minLength: 20 },
      },
      audit: () => undefined,
      appUrl: 'http://localhost:3000',
      otp: new OtpService(new MemoryOtpStore()),
      sms: new MemorySmsService(),
    });
    await expect(
      strictSvc.signUp(PID, { email: 's@example.com', password: 'long-enough-1' }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await strictSvc.signUp(PID, { email: 's@example.com', password: 'A-much-longer-password-99' });
  });
});
