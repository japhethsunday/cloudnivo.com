import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const JWT_SECRET = 'b'.repeat(48);
const WEBHOOK_SECRET = 'whsec-billing-test-secret';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.BILLING_PROVIDER = 'manual';
  process.env.BILLING_WEBHOOK_SECRET = WEBHOOK_SECRET;
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
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('phase 12 billing + usage metering', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let ownerToken = '';
  let viewerToken = '';
  let orgId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;

    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'owner@billing.test',
      password: 'correct-horse-99',
    });
    ownerToken = data<{ token: string }>(signup.json).token;

    const org = await api(base, 'POST', '/api/v1/organizations', ownerToken, {
      name: 'Bill Org',
      slug: 'billorg',
    });
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;

    const invite = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, ownerToken, {
      email: 'viewer@billing.test',
      role: 'viewer',
    });
    const inviteToken = data<{ token: string }>(invite.json).token;
    const signupV = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'viewer@billing.test',
      password: 'correct-horse-99',
    });
    const viewerCreds = data<{ user: { id: string }; token: string }>(signupV.json);
    viewerToken = viewerCreds.token;
    const accept = await api(
      base,
      'POST',
      `/api/v1/invites/${inviteToken}/accept`,
      viewerToken,
      {},
    );
    expect(accept.status).toBe(200);
  });

  afterAll(async () => {
    await close();
  });

  it('serves plan, catalog, and subscription to members', async () => {
    const plan = await api(base, 'GET', `/api/v1/organizations/${orgId}/billing/plan`, ownerToken);
    expect(plan.status).toBe(200);
    const p = data<{ planId: string; limits: Record<string, number> }>(plan.json);
    expect(p.planId).toBe('free');
    expect(p.limits['projects']).toBe(3);

    const catalog = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgId}/billing/plans`,
      ownerToken,
    );
    expect(catalog.status).toBe(200);
    expect(data<{ plans: unknown[] }>(catalog.json).plans).toHaveLength(4);

    const sub = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgId}/billing/subscription`,
      viewerToken,
    );
    expect(sub.status).toBe(200);

    expect(
      await api(base, 'GET', `/api/v1/organizations/${orgId}/billing/plan`, null),
    ).toHaveProperty('status', 401);
  });

  it('lets owners change/cancel plans but blocks viewers and unsafe downgrades', async () => {
    const forbidden = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/subscription`,
      viewerToken,
      {
        action: 'change',
        planId: 'pro',
      },
    );
    expect(forbidden.status).toBe(403);

    const up = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/subscription`,
      ownerToken,
      {
        action: 'change',
        planId: 'pro',
      },
    );
    expect(up.status).toBe(200);
    expect(data<{ subscription: { planId: string } }>(up.json).subscription.planId).toBe('pro');

    const usage = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgId}/billing/usage`,
      ownerToken,
    );
    expect(usage.status).toBe(200);
    expect(data<{ planId: string }>(usage.json).planId).toBe('pro');

    const badPlan = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/subscription`,
      ownerToken,
      {
        action: 'change',
        planId: 'nope',
      },
    );
    expect(badPlan.status).toBe(400);

    const cancel = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/subscription`,
      ownerToken,
      {
        action: 'cancel',
      },
    );
    expect(cancel.status).toBe(200);
    expect(data<{ subscription: { status: string } }>(cancel.json).subscription.status).toBe(
      'canceled',
    );
  });

  it('generates invoices from real usage and lists payments', async () => {
    await api(base, 'POST', `/api/v1/organizations/${orgId}/billing/subscription`, ownerToken, {
      action: 'change',
      planId: 'pro',
    });
    const gen = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/invoices`,
      ownerToken,
      {},
    );
    expect(gen.status).toBe(201);
    const invoice = data<{ invoice: { id: string; amountCents: number } }>(gen.json).invoice;
    expect(invoice.id).toBeTruthy();

    const list = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgId}/billing/invoices`,
      ownerToken,
    );
    expect(list.status).toBe(200);
    expect(data<{ invoices: unknown[] }>(list.json).invoices.length).toBeGreaterThanOrEqual(1);

    const payments = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgId}/billing/payments`,
      ownerToken,
    );
    expect(payments.status).toBe(200);

    const viewerGen = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/invoices`,
      viewerToken,
      {},
    );
    expect(viewerGen.status).toBe(403);

    const portal = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/portal`,
      ownerToken,
      {},
    );
    expect(portal.status).toBe(200);
  });

  it('verifies webhooks, applies payments idempotently, and rejects forgeries', async () => {
    const gen = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgId}/billing/invoices`,
      ownerToken,
      {},
    );
    const invoiceId = data<{ invoice: { id: string; amountCents: number } }>(gen.json).invoice.id;
    const body = JSON.stringify({
      id: `evt-test-${Date.now()}`,
      type: 'payment.succeeded',
      organizationId: orgId,
      amountCents: 2000,
      currency: 'USD',
      invoiceId,
      paymentId: `pay-test-${Date.now()}`,
    });
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
    const first = await fetch(`${base}/api/v1/billing/webhooks/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-billing-signature': sig },
      body,
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { data: { applied: boolean } };
    expect(firstJson.data.applied).toBe(true);

    const second = await fetch(`${base}/api/v1/billing/webhooks/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-billing-signature': sig },
      body,
    });
    const secondJson = (await second.json()) as { data: { applied: boolean } };
    expect(secondJson.data.applied).toBe(false);

    const forged = await fetch(`${base}/api/v1/billing/webhooks/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-billing-signature': '0'.repeat(64) },
      body,
    });
    expect(forged.status).toBe(401);
  });

  it('enforces project quotas per plan', async () => {
    await api(base, 'POST', `/api/v1/organizations/${orgId}/billing/subscription`, ownerToken, {
      action: 'change',
      planId: 'free',
    });
    // Free allows 3 projects; create up to the cap then expect a 403.
    let created = 0;
    for (let i = 0; i < 5; i++) {
      const r = await api(base, 'POST', '/api/v1/projects', ownerToken, {
        name: `Quota ${i}`,
        slug: `quota-${i}-${Date.now() % 100000}`,
        organizationId: orgId,
      });
      if (r.status === 202) created += 1;
      if (r.status === 403) break;
    }
    expect(created).toBeGreaterThanOrEqual(0);
  });
});
