import { describe, expect, it } from 'vitest';
import { MemoryEmailService } from './email.js';
import { MetadataError, sanitizeAppMetadata, sanitizeUserMetadata } from './metadata.js';
import { ownerPolicies, ownerScope, policiesToSql, requestContextSql } from './rls.js';
import { CustomerAuthService } from './service.js';
import { MemoryCustomerAuthStore } from './store.js';
import { hashToken, newOpaqueToken, verifyCustomerAccessToken } from './tokens.js';

const SECRET = 'c'.repeat(48);

function service() {
  const store = new MemoryCustomerAuthStore();
  const email = new MemoryEmailService();
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
  });
  return { svc, store, email, audits };
}

const PID = '11111111-1111-4111-8111-111111111111';

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

    const login = await svc.signIn(
      PID,
      { email: 'u@example.com', password: 'correct-horse-1' },
      { ip: null, agent: null },
    );
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
    const login = await svc.signIn(
      PID,
      { email: 'r@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
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
    const login = await svc.signIn(
      PID,
      { email: 'l@example.com', password: 'long-enough-1' },
      { ip: null, agent: null },
    );
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
    const a = await svc.signIn(
      PID,
      { email: 's@example.com', password: 'long-enough-1' },
      { ip: '1.1.1.1', agent: 'a' },
    );
    const b = await svc.signIn(
      PID,
      { email: 's@example.com', password: 'long-enough-1' },
      { ip: '2.2.2.2', agent: 'b' },
    );
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
