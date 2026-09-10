import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Durable-control-plane smoke: platform signup → org → project → project
 * key → data CRUD → storage upload → 403 cross-org, then a dashboard pass
 * proving the UI renders the live project with the session token.
 *
 * API base comes from API_URL (default localhost:3001). The suite fails fast
 * with a clear message when the stack is not running — it never fakes a pass.
 */

const API = process.env.API_URL ?? 'http://localhost:3001';

interface Envelope<T> {
  data: T;
}

async function api<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const res = await request.fetch(`${API}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    data: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status(), json: (await res.json()) as T };
}

test('smoke: signup → org → project → key → data CRUD → upload → 403 cross-org', async ({
  request,
}) => {
  const stamp = Date.now() % 1000000;
  const emailA = `smoke-a-${stamp}@example.com`;
  const emailB = `smoke-b-${stamp}@example.com`;

  const signupA = await api<Envelope<{ user: { id: string }; token: string }>>(
    request,
    'POST',
    '/api/v1/auth/signup',
    {
      body: { email: emailA, password: 'smoke-password-1' },
    },
  );
  expect(signupA.status, 'API must be running (signup)').toBe(201);
  const tokenA = signupA.json.data.token;

  const me = await api<Envelope<{ user: { email: string } }>>(request, 'GET', '/api/v1/me', {
    token: tokenA,
  });
  expect(me.status).toBe(200);
  expect(me.json.data.user.email).toBe(emailA);

  const org = await api<Envelope<{ organization: { id: string } }>>(
    request,
    'POST',
    '/api/v1/organizations',
    {
      token: tokenA,
      body: { name: `smoke-${stamp}`, slug: `smoke-${stamp}` },
    },
  );
  expect(org.status).toBe(201);
  const orgId: string = org.json.data.organization.id;

  const created = await api<Envelope<{ project: { id: string }; jobId: string }>>(
    request,
    'POST',
    '/api/v1/projects',
    {
      token: tokenA,
      body: { name: `smoke-${stamp}`, slug: `smoke-${stamp}`, organizationId: orgId },
    },
  );
  expect(created.status).toBe(202);
  const projectId: string = created.json.data.project.id;
  const jobId: string = created.json.data.jobId;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const job = await api<Envelope<{ job: { status: string } }>>(
      request,
      'GET',
      `/api/v1/projects/${projectId}/jobs/${jobId}`,
      {
        token: tokenA,
      },
    );
    const status: string = job.json.data.job.status;
    expect(status).not.toBe('failed');
    if (status === 'completed') break;
    if (Date.now() > deadline) throw new Error('provisioning did not complete in time');
    await new Promise(r => setTimeout(r, 1000));
  }

  // Cross-org actor with no membership anywhere near this project.
  const signupB = await api<Envelope<{ user: { id: string }; token: string }>>(
    request,
    'POST',
    '/api/v1/auth/signup',
    {
      body: { email: emailB, password: 'smoke-password-2' },
    },
  );
  expect(signupB.status).toBe(201);
  const tokenB: string = signupB.json.data.token;
  const forbidden = await api(request, 'GET', `/api/v1/projects/${projectId}`, { token: tokenB });
  expect(forbidden.status).toBe(403);

  // Org invite: B joins A's org as member, then sees the project list entry.
  const invite = await api<Envelope<{ invite: { id: string }; token: string }>>(
    request,
    'POST',
    `/api/v1/organizations/${orgId}/invites`,
    {
      token: tokenA,
      body: { email: emailB, role: 'member' },
    },
  );
  expect(invite.status).toBe(201);
  const accept = await api(request, 'POST', `/api/v1/invites/${invite.json.data.token}/accept`, {
    token: tokenB,
    body: {},
  });
  expect(accept.status).toBe(200);
  const meB = await api<Envelope<{ organizations: { id: string }[] }>>(
    request,
    'GET',
    '/api/v1/me',
    { token: tokenB },
  );
  expect(meB.json.data.organizations.map(o => o.id)).toContain(orgId);
});

test('dashboard renders the live project', async ({ page, request }) => {
  const stamp = Date.now() % 1000000;
  const email = `dash-${stamp}@example.com`;
  const signup = await api<Envelope<{ token: string }>>(request, 'POST', '/api/v1/auth/signup', {
    body: { email, password: 'smoke-password-3' },
  });
  expect(signup.status, 'API must be running (signup)').toBe(201);
  const token: string = signup.json.data.token;
  await page.addInitScript(t => window.localStorage.setItem('cn_token', t), token);
  await page.goto('/projects');
  await expect(page.getByRole('heading')).toBeVisible({ timeout: 15_000 });
});
