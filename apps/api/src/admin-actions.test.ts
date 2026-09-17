import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { ApiContext } from './v1.js';

/**
 * The operator console's write side: suspension and operator email.
 *
 * These are the two places the console stopped being read-only, so they are
 * the two places a mistake can do something rather than merely over-share.
 * What these tests pin, in order of what would hurt most:
 *
 * 1. A suspension actually stops the account — on its EXISTING token, not
 *    just at the next sign-in. A suspension that only hid a row would be
 *    decoration.
 * 2. An operator cannot suspend themselves or another operator, so the
 *    console cannot lock every operator out of the platform.
 * 3. The Email Center never reports a send it did not make. With no sender
 *    configured it fails loudly and records the attempt as failed.
 * 4. None of it is reachable without the staff flag.
 */

const JWT_SECRET = 'a'.repeat(48);

interface Booted {
  base: string;
  ctx: ApiContext;
  close: () => Promise<void>;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db';
  process.env['JWT_SECRET'] = JWT_SECRET;
  process.env['CORS_ORIGINS'] = 'http://localhost:3000';
  process.env['CACHE_DRIVER'] = 'memory';
  process.env['CONTROL_STORE'] = 'memory';
  process.env['PROVISION_DRIVER'] = 'fake';
  process.env['AUTH_RATE_MAX'] = '1000';
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  delete process.env['PLATFORM_ADMIN_EMAILS'];
  delete process.env['RESEND_API_KEY'];
  delete process.env['RESEND_FROM'];
  process.env['EMAIL_DRIVER'] = 'memory';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { start } = await import('./index.js');
  const { server, port, ctx } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    ctx,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function api(
  base: string,
  method: string,
  path: string,
  token?: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function signup(base: string, email: string): Promise<{ token: string; userId: string }> {
  const res = await api(base, 'POST', '/api/v1/auth/signup', null, {
    email,
    password: 'Operator-console-42',
  });
  expect(res.status, `signup ${email}`).toBe(201);
  const data = res.json['data'] as { token: string; user: { id: string } };
  return { token: data.token, userId: data.user.id };
}

let live: Booted | null = null;
afterEach(async () => {
  await live?.close();
  live = null;
});

describe('account suspension', () => {
  it('stops an existing session immediately, not just the next sign-in', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');
    const victim = await signup(base, 'victim@example.com');

    // The victim's token works before the suspension.
    expect((await api(base, 'GET', '/api/v1/me', victim.token)).status).toBe(200);

    const suspended = await api(
      base,
      'POST',
      `/api/v1/admin/users/${victim.userId}/suspend`,
      staff.token,
      { reason: 'abuse report #12' },
    );
    expect(suspended.status).toBe(200);

    // The SAME token is now refused. This is the whole point: a suspension
    // that waited for token expiry would leave the account live for an hour.
    const after = await api(base, 'GET', '/api/v1/me', victim.token);
    expect(after.status).toBe(403);

    // And a fresh sign-in is refused too.
    const login = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'victim@example.com',
      password: 'Operator-console-42',
    });
    expect(login.status).toBe(403);

    // Restoring puts it back.
    const restored = await api(
      base,
      'POST',
      `/api/v1/admin/users/${victim.userId}/restore`,
      staff.token,
    );
    expect(restored.status).toBe(200);
    expect((await api(base, 'GET', '/api/v1/me', victim.token)).status).toBe(200);
  });

  it('never lets an operator suspend themselves or another operator', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com,other@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');
    const other = await signup(base, 'other@example.com');

    const self = await api(
      base,
      'POST',
      `/api/v1/admin/users/${staff.userId}/suspend`,
      staff.token,
    );
    expect(self.status).toBe(400);

    const peer = await api(
      base,
      'POST',
      `/api/v1/admin/users/${other.userId}/suspend`,
      staff.token,
    );
    expect(peer.status).toBe(403);

    // Both operators still work.
    expect((await api(base, 'GET', '/api/v1/me', staff.token)).status).toBe(200);
    expect((await api(base, 'GET', '/api/v1/me', other.token)).status).toBe(200);
  });

  it('is unreachable for an ordinary developer', async () => {
    live = await boot();
    const { base } = live;
    const dev = await signup(base, 'dev@example.com');
    const victim = await signup(base, 'target@example.com');
    const res = await api(
      base,
      'POST',
      `/api/v1/admin/users/${victim.userId}/suspend`,
      dev.token,
    );
    // 404, not 403: the console does not confirm it exists.
    expect(res.status).toBe(404);
    expect((await api(base, 'GET', '/api/v1/me', victim.token)).status).toBe(200);
  });
});

describe('operator email', () => {
  it('refuses to send, and records the attempt, when no sender is configured', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com', EMAIL_DRIVER: 'memory' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');

    const res = await api(base, 'POST', '/api/v1/admin/emails', staff.token, {
      to: ['someone@example.com'],
      subject: 'Scheduled maintenance',
      intro: 'We have scheduled maintenance.',
    });
    // A refusal, and NOT a success: the memory driver is not a sender.
    // 409 rather than 503 so the reason survives toPublicError's 5xx scrub.
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toMatch(/no email sender is configured/i);

    // The attempt is visible in the delivery log, as failed — never as sent.
    const log = await api(base, 'GET', '/api/v1/admin/emails', staff.token);
    expect(log.status).toBe(200);
    const emails = (log.json['data'] as { emails: { status: string }[] }).emails;
    expect(emails.length).toBe(1);
    expect(emails[0]?.status).toBe('failed');
  });

  it('validates recipients and body before anything is recorded', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');

    const noSubject = await api(base, 'POST', '/api/v1/admin/emails', staff.token, {
      to: ['a@b.co'],
      subject: '',
      intro: 'body',
    });
    expect(noSubject.status).toBe(400);

    const badAddress = await api(base, 'POST', '/api/v1/admin/emails', staff.token, {
      to: ['not-an-address'],
      subject: 'Hello',
      intro: 'body',
    });
    expect(badAddress.status).toBe(400);

    const noBody = await api(base, 'POST', '/api/v1/admin/emails', staff.token, {
      to: ['a@b.co'],
      subject: 'Hello',
      intro: '   ',
    });
    expect(noBody.status).toBe(400);

    // None of those reached the log.
    const log = await api(base, 'GET', '/api/v1/admin/emails', staff.token);
    expect((log.json['data'] as { emails: unknown[] }).emails.length).toBe(0);
  });

  it('previews without sending or recording', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');

    const res = await api(base, 'POST', '/api/v1/admin/emails/preview', staff.token, {
      subject: 'Scheduled maintenance',
      intro: 'We have scheduled maintenance.',
      bullets: ['Window: 02:00–03:00 UTC'],
    });
    expect(res.status).toBe(200);
    const preview = (res.json['data'] as { preview: { html: string; text: string } }).preview;
    expect(preview.html).toContain('CloudNivo');
    expect(preview.html).toContain('Scheduled maintenance');
    expect(preview.text).toContain('Window: 02:00–03:00 UTC');

    const log = await api(base, 'GET', '/api/v1/admin/emails', staff.token);
    expect((log.json['data'] as { emails: unknown[] }).emails.length).toBe(0);
  });

  it('reports sender readiness without ever returning the API key', async () => {
    live = await boot({
      PLATFORM_ADMIN_EMAILS: 'staff@example.com',
      EMAIL_DRIVER: 'resend',
      RESEND_API_KEY: 're_test_secret_value_do_not_leak',
      RESEND_FROM: 'CloudNivo <noreply@example.com>',
    });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');

    const res = await api(base, 'GET', '/api/v1/admin/emails', staff.token);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.json);
    const sender = (res.json['data'] as { sender: { ready: boolean; from: string | null } }).sender;
    expect(sender.ready).toBe(true);
    expect(sender.from).toBe('CloudNivo <noreply@example.com>');
    // The key is the one thing that must never cross this boundary.
    expect(body).not.toContain('re_test_secret_value_do_not_leak');

    const config = await api(base, 'GET', '/api/v1/admin/config', staff.token);
    expect(JSON.stringify(config.json)).not.toContain('re_test_secret_value_do_not_leak');
    const configured = (config.json['data'] as { configured: { resendApiKey: boolean } }).configured;
    expect(configured.resendApiKey).toBe(true);
  });

  it('is unreachable for an ordinary developer', async () => {
    live = await boot();
    const { base } = live;
    const dev = await signup(base, 'dev@example.com');
    expect((await api(base, 'GET', '/api/v1/admin/emails', dev.token)).status).toBe(404);
    expect(
      (
        await api(base, 'POST', '/api/v1/admin/emails', dev.token, {
          to: ['a@b.co'],
          subject: 'x',
          intro: 'y',
        })
      ).status,
    ).toBe(404);
  });
});

describe('expanded operator reads', () => {
  it('serves the new sections without leaking secrets', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');

    for (const route of [
      '/security',
      '/observability',
      '/infrastructure',
      '/config',
      '/admins',
      '/emails',
      '/emails/templates',
    ]) {
      const res = await api(base, 'GET', `/api/v1/admin${route}`, staff.token);
      expect(res.status, route).toBe(200);
      const body = JSON.stringify(res.json);
      expect(body, `${route} must not carry the JWT secret`).not.toContain(JWT_SECRET);
      expect(body, `${route} must not carry a password hash`).not.toMatch(/scrypt\$/);
    }
  });

  it('exposes a user detail with tenancy but no credential material', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'staff@example.com' });
    const { base } = live;
    const staff = await signup(base, 'staff@example.com');
    const dev = await signup(base, 'member@example.com');
    await api(base, 'POST', '/api/v1/organizations', dev.token, {
      name: 'Acme',
      slug: 'acme-detail',
    });

    const res = await api(base, 'GET', `/api/v1/admin/users/${dev.userId}`, staff.token);
    expect(res.status).toBe(200);
    const user = (res.json['data'] as {
      user: { email: string; organizations: unknown[]; suspendedAt: string | null };
    }).user;
    expect(user.email).toBe('member@example.com');
    expect(user.organizations.length).toBe(1);
    expect(user.suspendedAt).toBeNull();
    expect(JSON.stringify(res.json)).not.toMatch(/passwordHash|totpSecret|backupCode/i);
  });
});
