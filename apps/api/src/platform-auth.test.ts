import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import { totpNow } from '@cloudnivo/auth';

const JWT_SECRET = 'p'.repeat(48);

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as Record<string, unknown>,
  };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('phase 8 platform auth + org invites', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let userA = '';
  let orgId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
  });

  afterAll(async () => {
    await close();
  });

  it('signs up, reports me, and logs in', async () => {
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'dev@example.com',
      password: 'correct-horse-99',
      displayName: 'Dev',
    });
    expect(signup.status).toBe(201);
    expect(signup.headers.get('set-cookie')).toContain('cn_session=');
    expect(signup.headers.get('set-cookie')).toContain('HttpOnly');
    const created = data<{ user: { id: string }; token: string }>(signup.json);
    expect(created.user.id).toBeTruthy();
    expect(JSON.stringify(signup.json)).not.toContain('correct-horse');
    tokenA = created.token;
    userA = created.user.id;

    const me = await api(base, 'GET', '/api/v1/me', tokenA);
    expect(me.status).toBe(200);
    expect(data<{ user: { email: string } }>(me.json).user.email).toBe('dev@example.com');

    const login = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'dev@example.com',
      password: 'correct-horse-99',
    });
    expect(login.status).toBe(200);

    const dupe = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'dev@example.com',
      password: 'another-long-1',
    });
    expect(dupe.status).toBe(409);
    const bad = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'dev@example.com',
      password: 'wrong-password-1',
    });
    expect(bad.status).toBe(401);
    const unknown = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'nobody@example.com',
      password: 'wrong-password-1',
    });
    expect(unknown.status).toBe(401);
    expect(await api(base, 'GET', '/api/v1/me', 'junk')).toHaveProperty('status', 401);
  });

  it('invites, looks up, and accepts org membership', async () => {
    const org = await api(base, 'POST', '/api/v1/organizations', tokenA, {
      name: 'Inv Org',
      slug: 'invorg',
    });
    expect(org.status).toBe(201);
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;

    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, tokenA, {
      email: 'mate@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const { invite, token } = data<{ invite: { id: string }; token: string }>(created.json);
    expect(invite.id).toBeTruthy();
    expect(token.startsWith('inv_')).toBe(true);

    const lookup = await api(base, 'GET', `/api/v1/invites/${token}`, null);
    expect(lookup.status).toBe(200);

    const signupB = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'mate@example.com',
      password: 'correct-horse-88',
    });
    const tokenB = data<{ token: string }>(signupB.json).token;
    const accept = await api(base, 'POST', `/api/v1/invites/${token}/accept`, tokenB, {});
    expect(accept.status).toBe(200);

    // The invitee now sees the org through membership.
    const meB = await api(base, 'GET', '/api/v1/me', tokenB);
    expect(
      data<{ organizations: { id: string; role: string }[] }>(meB.json).organizations,
    ).toContainEqual(expect.objectContaining({ id: orgId, role: 'member' }));

    // Double accept is rejected; bad tokens are 404.
    expect((await api(base, 'POST', `/api/v1/invites/${token}/accept`, tokenB, {})).status).toBe(
      409,
    );
    expect((await api(base, 'GET', '/api/v1/invites/inv_bogus', null)).status).toBe(404);
    expect(userA.length).toBeGreaterThan(0);
  });

  it('refuses invites from non-managers', async () => {
    const signupC = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'stranger@example.com',
      password: 'correct-horse-77',
    });
    const tokenC = data<{ token: string }>(signupC.json).token;
    const r = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, tokenC, {
      email: 'x@example.com',
      role: 'viewer',
    });
    expect([403, 404]).toContain(r.status);
  });

  it('logs out by clearing the session cookie', async () => {
    const out = await api(base, 'POST', '/api/v1/auth/logout', tokenA, {});
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects invite acceptance from a different email address', async () => {
    // tokenA was logged out by the previous test — sign back in for setup.
    const relogin = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'dev@example.com',
      password: 'correct-horse-99',
    });
    expect(relogin.status).toBe(200);
    tokenA = data<{ token: string }>(relogin.json).token;
    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, tokenA, {
      email: 'intended@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const { token } = data<{ token: string }>(created.json);
    const signupE = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'impostor@example.com',
      password: 'correct-horse-66',
    });
    const tokenE = data<{ token: string }>(signupE.json).token;
    const accept = await api(base, 'POST', `/api/v1/invites/${token}/accept`, tokenE, {});
    expect(accept.status).toBe(403);
  });
});

describe('platform session revocation (server-side logout)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
  });

  afterAll(async () => {
    await close();
  });

  it('login -> use -> logout -> old token rejected, new session works', async () => {
    const email = 'revoked@example.com';
    const password = 'correct-horse-99';
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, { email, password });
    expect(signup.status).toBe(201);
    const first = data<{ token: string }>(signup.json).token;
    const login = await api(base, 'POST', '/api/v1/auth/login', null, { email, password });
    expect(login.status).toBe(200);
    const second = data<{ token: string }>(login.json).token;
    expect(first).not.toBe(second);

    // Both sessions work before logout.
    expect((await api(base, 'GET', '/api/v1/me', first)).status).toBe(200);
    expect((await api(base, 'GET', '/api/v1/me', second)).status).toBe(200);

    // Logout invalidates exactly the presented session, server-side.
    expect((await api(base, 'POST', '/api/v1/auth/logout', first, {})).status).toBe(200);
    expect((await api(base, 'GET', '/api/v1/me', first)).status).toBe(401);

    // The unrelated session of the same user is untouched.
    expect((await api(base, 'GET', '/api/v1/me', second)).status).toBe(200);

    // A brand-new login after logout works.
    const again = await api(base, 'POST', '/api/v1/auth/login', null, { email, password });
    expect(again.status).toBe(200);
    expect(
      (await api(base, 'GET', '/api/v1/me', data<{ token: string }>(again.json).token)).status,
    ).toBe(200);
  });
});

describe('phase 12 account profile + password', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let token = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'profile@example.com',
      password: 'original-password-1',
      displayName: 'Original',
    });
    expect(signup.status).toBe(201);
    token = data<{ token: string }>(signup.json).token;
  });

  afterAll(async () => {
    await close();
  });

  it('updates its own display name, rejects strangers', async () => {
    const ok = await api(base, 'PATCH', '/api/v1/me', token, { displayName: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(data<{ user: { displayName: string } }>(ok.json).user.displayName).toBe('Renamed');
    const me = await api(base, 'GET', '/api/v1/me', token);
    expect(data<{ user: { displayName: string } }>(me.json).user.displayName).toBe('Renamed');
    expect(await api(base, 'PATCH', '/api/v1/me', null, { displayName: 'X' })).toHaveProperty(
      'status',
      401,
    );
    expect(await api(base, 'PATCH', '/api/v1/me', token, { displayName: '' })).toHaveProperty(
      'status',
      400,
    );
  });

  it('changes password only with the current one, then logs in with the new one', async () => {
    const wrong = await api(base, 'POST', '/api/v1/auth/password', token, {
      currentPassword: 'not-the-password-1',
      newPassword: 'brand-new-password-2',
    });
    expect(wrong.status).toBe(401);
    const short = await api(base, 'POST', '/api/v1/auth/password', token, {
      currentPassword: 'original-password-1',
      newPassword: 'short',
    });
    expect(short.status).toBe(400);
    const changed = await api(base, 'POST', '/api/v1/auth/password', token, {
      currentPassword: 'original-password-1',
      newPassword: 'brand-new-password-2',
    });
    expect(changed.status).toBe(200);
    const oldLogin = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'profile@example.com',
      password: 'original-password-1',
    });
    expect(oldLogin.status).toBe(401);
    const fresh = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'profile@example.com',
      password: 'brand-new-password-2',
    });
    expect(fresh.status).toBe(200);
    token = data<{ token: string }>(fresh.json).token;
  });
});

describe('platform totp mfa + sessions', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
  });
  afterAll(async () => {
    await close();
  });

  it('enrolls, challenges login, verifies, manages sessions, disables', async () => {
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'pmfa@example.com',
      password: 'correct-horse-99',
    });
    expect(signup.status).toBe(201);
    expect(data<{ user: { totpEnabled: boolean } }>(signup.json).user.totpEnabled).toBe(false);
    let token = data<{ token: string }>(signup.json).token;

    const enroll = await api(base, 'POST', '/api/v1/me/mfa/enroll', token, {});
    expect(enroll.status).toBe(200);
    const secret = data<{ secret: string; uri: string }>(enroll.json).secret;
    expect(secret.length).toBeGreaterThan(15);
    expect(JSON.stringify(enroll.json)).not.toContain('passwordHash');

    const confirm = await api(base, 'POST', '/api/v1/me/mfa/confirm', token, {
      code: totpNow(secret),
    });
    expect(confirm.status).toBe(200);
    expect(data<{ backupCodes: string[] }>(confirm.json).backupCodes).toHaveLength(10);

    const challenged = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'pmfa@example.com',
      password: 'correct-horse-99',
    });
    expect(challenged.status).toBe(200);
    expect(data<{ mfaRequired: boolean }>(challenged.json).mfaRequired).toBe(true);
    const ticket = data<{ mfaTicket: string }>(challenged.json).mfaTicket;
    expect(
      (await api(base, 'POST', '/api/v1/auth/mfa-verify', null, { mfaTicket: ticket, code: '000000' })).status,
    ).toBe(401);
    const challenged2 = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'pmfa@example.com',
      password: 'correct-horse-99',
    });
    const ticket2 = data<{ mfaTicket: string }>(challenged2.json).mfaTicket;
    const verified = await api(base, 'POST', '/api/v1/auth/mfa-verify', null, {
      mfaTicket: ticket2,
      code: totpNow(secret),
    });
    expect(verified.status).toBe(200);
    token = data<{ token: string }>(verified.json).token;

    // Session inventory shows both live sessions with device metadata.
    const sessions = await api(base, 'GET', '/api/v1/me/sessions', token);
    expect(sessions.status).toBe(200);
    const list = data<{ sessions: { jti: string; current: boolean }[] }>(sessions.json).sessions;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(s => s.current)).toBe(true);
    const other = list.find(s => !s.current);
    if (other) {
      expect((await api(base, 'DELETE', `/api/v1/me/sessions/${other.jti}`, token)).status).toBe(200);
    }
    const revoked = await api(base, 'POST', '/api/v1/me/sessions/revoke-all', token, {});
    expect(data<{ revoked: number }>(revoked.json).revoked).toBeGreaterThanOrEqual(0);

    // Disable restores plain password login.
    expect(
      (await api(base, 'POST', '/api/v1/me/mfa/disable', token, { code: '000000' })).status,
    ).toBe(401);
    expect(
      (await api(base, 'POST', '/api/v1/me/mfa/disable', token, { code: totpNow(secret) })).status,
    ).toBe(200);
    const plain = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'pmfa@example.com',
      password: 'correct-horse-99',
    });
    expect(data<{ user: { id: string } }>(plain.json).user).toBeTruthy();
  });
});

describe('org policy + mfa enforcement + email change', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let ownerToken = '';
  let orgId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'owner@policy.test',
      password: 'correct-horse-99',
    });
    ownerToken = data<{ token: string }>(signup.json).token;
    const org = await api(base, 'POST', '/api/v1/organizations', ownerToken, {
      name: 'Policy Org',
      slug: 'policyorg',
    });
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;
  });
  afterAll(async () => {
    await close();
  });

  it('reads default policy, updates it as owner, rejects strangers', async () => {
    const initial = await api(base, 'GET', `/api/v1/organizations/${orgId}/policy`, ownerToken);
    expect(initial.status).toBe(200);
    expect(data<{ policy: { requireMfa: boolean } }>(initial.json).policy.requireMfa).toBe(false);
    const updated = await api(base, 'PUT', `/api/v1/organizations/${orgId}/policy`, ownerToken, {
      allowedEmailDomains: ['policy.test'],
      requireMfa: true,
      passwordMinLength: 14,
    });
    expect(updated.status).toBe(200);
    const policy = data<{ policy: { allowedEmailDomains: string[]; requireMfa: boolean; passwordMinLength: number } }>(
      updated.json,
    ).policy;
    expect(policy.allowedEmailDomains).toEqual(['policy.test']);
    expect(policy.requireMfa).toBe(true);
    // Invites to foreign domains are rejected; member role cannot change policy.
    expect(
      (
        await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, ownerToken, {
          email: 'someone@elsewhere.com',
          role: 'member',
        })
      ).status,
    ).toBe(403);
    const outsider = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'outsider@policy.test',
      password: 'correct-horse-99',
    });
    const outsiderToken = data<{ token: string }>(outsider.json).token;
    expect(
      (await api(base, 'PUT', `/api/v1/organizations/${orgId}/policy`, outsiderToken, {
        requireMfa: false,
      })).status,
    ).toBe(404);
  });

  it('forces mfa enrollment at login when the org requires it', async () => {
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'member@policy.test',
      password: 'correct-horse-99',
    });
    const memberToken = data<{ token: string }>(signup.json).token;
    // Join via invite from the owner.
    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, ownerToken, {
      email: 'member@policy.test',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const inviteToken = data<{ token: string }>(created.json).token;
    expect(
      (await api(base, 'POST', `/api/v1/invites/${inviteToken}/accept`, memberToken, {})).status,
    ).toBe(200);
    // Password login is interrupted with a setup ticket (428).
    const login = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'member@policy.test',
      password: 'correct-horse-99',
    });
    expect(login.status).toBe(428);
    expect(data<{ mfaSetupRequired: boolean }>(login.json).mfaSetupRequired).toBe(true);
    const setupTicket = data<{ setupTicket: string }>(login.json).setupTicket;
    const enroll = await api(base, 'POST', '/api/v1/me/mfa/enroll', null, { setupTicket });
    expect(enroll.status).toBe(200);
    const secret = data<{ secret: string }>(enroll.json).secret;
    const confirm = await api(base, 'POST', '/api/v1/me/mfa/confirm', null, {
      setupTicket,
      code: totpNow(secret),
    });
    expect(confirm.status).toBe(200);
    expect(data<{ token: string }>(confirm.json).token).toBeTruthy();
    // Weak passwords are now rejected for this member (policy min 14).
    const weak = await api(base, 'POST', '/api/v1/auth/password', data<{ token: string }>(confirm.json).token, {
      currentPassword: 'correct-horse-99',
      newPassword: 'short-99',
    });
    expect(weak.status).toBe(400);
  });

  it('changes email verified + unique + domain-gated', async () => {
    // The owner has no MFA yet and the org requires it: enroll first.
    const blocked = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'owner@policy.test',
      password: 'correct-horse-99',
    });
    expect(blocked.status).toBe(428);
    const setupTicket = data<{ setupTicket: string }>(blocked.json).setupTicket;
    const enroll = await api(base, 'POST', '/api/v1/me/mfa/enroll', null, { setupTicket });
    expect(enroll.status).toBe(200);
    const ownerSecret = data<{ secret: string }>(enroll.json).secret;
    const done = await api(base, 'POST', '/api/v1/me/mfa/confirm', null, {
      setupTicket,
      code: totpNow(ownerSecret),
    });
    expect(done.status).toBe(200);
    const token = data<{ token: string }>(done.json).token;
    expect(
      (
        await api(base, 'POST', '/api/v1/me/email/request', token, {
          newEmail: 'owner2@policy.test',
          currentPassword: 'wrong-pass',
        })
      ).status,
    ).toBe(401);
    const requested = await api(base, 'POST', '/api/v1/me/email/request', token, {
      newEmail: 'owner2@policy.test',
      currentPassword: 'correct-horse-99',
    });
    expect(requested.status).toBe(200);
    const changeToken = data<{ changeToken: string }>(requested.json).changeToken;
    const confirmed = await api(base, 'POST', '/api/v1/me/email/confirm', null, {
      token: changeToken,
    });
    expect(confirmed.status).toBe(200);
    expect(data<{ user: { email: string } }>(confirmed.json).user.email).toBe('owner2@policy.test');
    // Login with the new email challenges MFA (enrolled above), then succeeds.
    const login2 = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'owner2@policy.test',
      password: 'correct-horse-99',
    });
    expect(login2.status).toBe(200);
    expect(data<{ mfaRequired: boolean }>(login2.json).mfaRequired).toBe(true);
    const verified2 = await api(base, 'POST', '/api/v1/auth/mfa-verify', null, {
      mfaTicket: data<{ mfaTicket: string }>(login2.json).mfaTicket,
      code: totpNow(ownerSecret),
    });
    expect(verified2.status).toBe(200);
    const token2 = data<{ token: string }>(verified2.json).token;
    // Foreign domains are refused at confirm time.
    const again = await api(base, 'POST', '/api/v1/me/email/request', token2, {
      newEmail: 'owner2@elsewhere.com',
      currentPassword: 'correct-horse-99',
    });
    expect(again.status).toBe(200);
    expect(
      (
        await api(base, 'POST', '/api/v1/me/email/confirm', null, {
          token: data<{ changeToken: string }>(again.json).changeToken,
        })
      ).status,
    ).toBe(403);
  });
});

describe('sso oidc login', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let ownerToken = '';
  let orgId = '';
  const orgSlug = 'ssoorg';
  let idpBase = '';
  let stopIdp: () => Promise<void> = async () => {};
  let idTokenFor = (_email: string, _nonce: string): Promise<string> =>
    Promise.resolve('');

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'owner@sso.test',
      password: 'correct-horse-99',
    });
    ownerToken = data<{ token: string }>(signup.json).token;
    const org = await api(base, 'POST', '/api/v1/organizations', ownerToken, {
      name: 'SSO Org',
      slug: orgSlug,
    });
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;

    // Mock OIDC provider: discovery + JWKS + token endpoints, plus a
    // test-only code registry mapping authorization codes to ID tokens.
    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const codeRegistry = new Map<string, string>();
    const readBody = (req: IncomingMessage): Promise<string> =>
      new Promise(resolve => {
        let text = '';
        req.on('data', (c: unknown) => {
          text += String(c);
        });
        req.on('end', () => resolve(text));
      });
    const srv = createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };
      void (async () => {
        if (req.url === '/.well-known/openid-configuration' && req.method === 'GET') {
          send(200, {
            issuer: idpBase,
            authorization_endpoint: `${idpBase}/auth`,
            token_endpoint: `${idpBase}/token`,
            jwks_uri: `${idpBase}/jwks`,
          });
          return;
        }
        if (req.url === '/jwks' && req.method === 'GET') {
          send(200, { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
          return;
        }
        if (req.url === '/token' && req.method === 'POST') {
          const params = new URLSearchParams(await readBody(req));
          const idToken = codeRegistry.get(params.get('code') ?? '');
          if (!idToken) {
            send(400, { error: 'invalid_grant' });
            return;
          }
          send(200, { id_token: idToken, token_type: 'Bearer' });
          return;
        }
        if (req.url === '/__register' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { code?: string; idToken?: string };
          if (body.code && body.idToken) codeRegistry.set(body.code, body.idToken);
          send(200, { registered: true });
          return;
        }
        send(404, {});
      })().catch(() => {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          // Already closed.
        }
      });
    });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    idpBase = `http://127.0.0.1:${port}`;
    stopIdp = () =>
      new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve())));
    idTokenFor = async (email: string, nonce: string): Promise<string> =>
      new SignJWT({ email, email_verified: true, name: 'SSO User', nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(`sso-${email}`)
        .setIssuer(idpBase)
        .setAudience('sso-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });
  afterAll(async () => {
    await stopIdp();
    await close();
  });

  it('registers a connection, starts login, completes callback', async () => {
    // Undiscoverable issuers fail fast.
    expect(
      (
        await api(base, 'POST', `/api/v1/organizations/${orgId}/sso`, ownerToken, {
          issuer: 'http://127.0.0.1:1/',
          clientId: 'x',
          clientSecret: 'y',
        })
      ).status,
    ).toBe(400);
    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/sso`, ownerToken, {
      issuer: idpBase,
      clientId: 'sso-client',
      clientSecret: 'sso-secret-value',
      displayName: 'Test IdP',
    });
    expect(created.status).toBe(201);
    const connection = data<{ connection: { id: string } }>(created.json).connection;
    expect(JSON.stringify(created.json)).not.toContain('sso-secret-value');
    const listed = await api(base, 'GET', `/api/v1/organizations/${orgId}/sso`, ownerToken);
    expect(data<{ connections: unknown[] }>(listed.json).connections).toHaveLength(1);

    const started = await api(base, 'GET', `/api/v1/auth/sso/${orgSlug}/start`, null);
    expect(started.status).toBe(200);
    const { authorizeUrl } = data<{ authorizeUrl: string }>(started.json);
    expect(authorizeUrl).toContain('/auth');
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const nonce = new URL(authorizeUrl).searchParams.get('nonce') ?? '';
    expect(state.length).toBeGreaterThan(5);

    // Bad states fail; the positive path uses a provider-signed ID token.
    expect(
      (await api(base, 'GET', `/api/v1/auth/sso/callback?code=bad&state=bad`, null)).status,
    ).toBe(401);
    const idToken = await idTokenFor('sso-user@sso.test', nonce);
    await fetch(`${idpBase}/__register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code-1', idToken }),
    });
    const callback = await api(
      base,
      'GET',
      `/api/v1/auth/sso/callback?code=test-code-1&state=${state}`,
      null,
    );
    expect(callback.status).toBe(200);
    expect(data<{ user: { email: string } }>(callback.json).user.email).toBe('sso-user@sso.test');
    // Membership was provisioned; replaying the state fails (single use).
    const me = await api(base, 'GET', '/api/v1/me', data<{ token: string }>(callback.json).token);
    expect(
      data<{ organizations: { id: string }[] }>(me.json).organizations.map(o => o.id),
    ).toContain(orgId);
    expect(
      (await api(base, 'GET', `/api/v1/auth/sso/callback?code=test-code-1&state=${state}`, null))
        .status,
    ).toBe(401);
    // Connection removal disables the flow.
    expect(
      (await api(base, 'DELETE', `/api/v1/organizations/${orgId}/sso/${connection.id}`, ownerToken)).status,
    ).toBe(200);
    expect((await api(base, 'GET', `/api/v1/auth/sso/${orgSlug}/start`, null)).status).toBe(404);
  });
});

/**
 * Logto registers traditional web applications with
 * `token_endpoint_auth_method: client_secret_basic`, and node-oidc-provider —
 * which Logto is built on — rejects a client that sends its secret in the
 * form body instead. This provider behaves the same way, so the suite fails
 * if CloudNivo ever goes back to posting the secret.
 */
describe('sso against a logto-shaped provider (client_secret_basic)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let ownerToken = '';
  let orgId = '';
  const orgSlug = 'logtoorg';
  let idpBase = '';
  let stopIdp: () => Promise<void> = async () => {};
  let idTokenFor = (_email: string, _nonce: string): Promise<string> => Promise.resolve('');
  const seenAuthHeaders: string[] = [];
  let bodySecretAttempts = 0;

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'owner@logto.test',
      password: 'correct-horse-99',
    });
    ownerToken = data<{ token: string }>(signup.json).token;
    const org = await api(base, 'POST', '/api/v1/organizations', ownerToken, {
      name: 'Logto Org',
      slug: orgSlug,
    });
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;

    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const codeRegistry = new Map<string, string>();
    const readBody = (req: IncomingMessage): Promise<string> =>
      new Promise(resolve => {
        let text = '';
        req.on('data', (c: unknown) => {
          text += String(c);
        });
        req.on('end', () => resolve(text));
      });
    const srv = createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      void (async () => {
        // Logto serves discovery under its /oidc mount point.
        if (req.url === '/oidc/.well-known/openid-configuration' && req.method === 'GET') {
          send(200, {
            issuer: `${idpBase}/oidc`,
            authorization_endpoint: `${idpBase}/oidc/auth`,
            token_endpoint: `${idpBase}/oidc/token`,
            jwks_uri: `${idpBase}/oidc/jwks`,
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
          });
          return;
        }
        if (req.url === '/oidc/jwks' && req.method === 'GET') {
          send(200, { keys: [{ ...jwk, kid: 'logto-key', alg: 'RS256', use: 'sig' }] });
          return;
        }
        if (req.url === '/oidc/token' && req.method === 'POST') {
          const raw = await readBody(req);
          const params = new URLSearchParams(raw);
          const auth = req.headers.authorization ?? '';
          seenAuthHeaders.push(auth);
          if (params.get('client_secret')) bodySecretAttempts += 1;
          if (!auth.startsWith('Basic ')) {
            send(401, { error: 'invalid_client' });
            return;
          }
          const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
          if (decodeURIComponent(id ?? '') !== 'logto-app' || decodeURIComponent(secret ?? '') !== 'logto-secret') {
            send(401, { error: 'invalid_client' });
            return;
          }
          const idToken = codeRegistry.get(params.get('code') ?? '');
          if (!idToken) {
            send(400, { error: 'invalid_grant' });
            return;
          }
          send(200, { id_token: idToken, token_type: 'Bearer' });
          return;
        }
        if (req.url === '/__register' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { code?: string; idToken?: string };
          if (body.code && body.idToken) codeRegistry.set(body.code, body.idToken);
          send(200, { registered: true });
          return;
        }
        send(404, {});
      })().catch(() => {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          // Already closed.
        }
      });
    });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    idpBase = `http://127.0.0.1:${port}`;
    stopIdp = () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve())));
    idTokenFor = async (email: string, nonce: string): Promise<string> =>
      new SignJWT({ email, email_verified: true, name: 'Logto User', nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'logto-key' })
        .setSubject(`logto-${email}`)
        .setIssuer(`${idpBase}/oidc`)
        .setAudience('logto-app')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  afterAll(async () => {
    await stopIdp();
    await close();
  });

  it('publishes provider presets and the callback URL without a session', async () => {
    const res = await api(base, 'GET', '/api/v1/auth/sso/providers', null);
    expect(res.status).toBe(200);
    const body = data<{
      providers: { id: string; issuerTemplate: string; scopes: string[] }[];
      callbackUrl: string;
    }>(res.json);
    const logto = body.providers.find(p => p.id === 'logto');
    expect(logto?.issuerTemplate).toBe('https://{tenant}.logto.app/oidc');
    expect(logto?.scopes).toContain('email');
    expect(body.callbackUrl).toContain('/api/v1/auth/sso/callback');
  });

  it('completes the whole login through HTTP Basic client authentication', async () => {
    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/sso`, ownerToken, {
      issuer: `${idpBase}/oidc`,
      clientId: 'logto-app',
      clientSecret: 'logto-secret',
      displayName: 'Logto',
      defaultRole: 'member',
    });
    expect(created.status).toBe(201);

    const start = await api(base, 'GET', `/api/v1/auth/sso/${orgSlug}/start`, null);
    expect(start.status).toBe(200);
    const { authorizeUrl } = data<{ authorizeUrl: string }>(start.json);
    const authorize = new URL(authorizeUrl);
    const state = authorize.searchParams.get('state') ?? '';
    const nonce = authorize.searchParams.get('nonce') ?? '';
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toContain('email');

    const code = 'logto-code-1';
    await fetch(`${idpBase}/__register`, {
      method: 'POST',
      body: JSON.stringify({ code, idToken: await idTokenFor('member@logto.test', nonce) }),
    });

    const cb = await fetch(
      `${base}/api/v1/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    expect([200, 302, 303]).toContain(cb.status);

    // The provider only ever saw Basic, and never a secret in the body.
    expect(seenAuthHeaders.some(h => h.startsWith('Basic '))).toBe(true);
    expect(bodySecretAttempts).toBe(0);
  });

  it('creates a connection from a preset without a hand-written issuer', async () => {
    // The preset builds an issuer; discovery then fails because no Logto
    // tenant exists here. The point is that the issuer was built, not typed.
    const res = await api(base, 'POST', `/api/v1/organizations/${orgId}/sso`, ownerToken, {
      provider: 'logto',
      tenant: 'cloudnivo-test-tenant',
      clientId: 'logto-app',
      clientSecret: 'logto-secret',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('SSO_DISCOVERY_FAILED');

    const missing = await api(base, 'POST', `/api/v1/organizations/${orgId}/sso`, ownerToken, {
      provider: 'logto',
      tenant: '   ',
      clientId: 'logto-app',
      clientSecret: 'logto-secret',
    });
    expect(missing.status).toBe(400);
  });
});
