import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'g'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const V1 = `module.exports.handler = async () => ({ status: 200, body: { v: 1 } });`;

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

async function tokenFor(sub: string): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: JWT_SECRET });
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('phase 14 automation E2E (fake provider)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let orgA = '';
  let projectA = '';
  let projectB = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const mkOrg = async (tok: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/organizations', tok, { name: slug, slug });
      expect(r.status).toBe(201);
      return data<{ organization: { id: string } }>(r.json).organization.id;
    };
    orgA = await mkOrg(tokenA, 'autoorga');
    const orgB = await mkOrg(tokenB, 'autoorgb');
    const mkProject = async (tok: string, org: string, slug: string): Promise<string> => {
      const p = await api(base, 'POST', '/api/v1/projects', tok, { name: slug, slug, organizationId: org });
      expect(p.status).toBe(202);
      return data<{ project: { id: string } }>(p.json).project.id;
    };
    projectA = await mkProject(tokenA, orgA, 'autoshop');
    projectB = await mkProject(tokenB, orgB, 'autoother');
  });

  afterAll(async () => {
    await close();
  });

  it('queues: full lifecycle with idempotency and dead-letter', async () => {
    const created = await api(base, 'POST', `/api/v1/projects/${projectA}/queues`, tokenA, { name: 'jobs' });
    expect(created.status).toBe(201);
    const queue = data<{ queue: { id: string } }>(created.json).queue;
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA}/queues`, tokenA, { name: 'jobs' })).status,
    ).toBe(409);

    const p1 = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${queue.id}/messages`, tokenA, {
      body: { n: 1 },
      idempotencyKey: 'k1',
    });
    expect(p1.status).toBe(201);
    const p2 = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${queue.id}/messages`, tokenA, {
      body: { n: 999 },
      idempotencyKey: 'k1',
    });
    expect(p2.status).toBe(200);
    expect(data<{ duplicate: boolean }>(p2.json).duplicate).toBe(true);

    const c1 = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${queue.id}/consume`, tokenA, { limit: 10 });
    expect(c1.status).toBe(200);
    const leased = data<{ messages: { id: string }[] }>(c1.json).messages;
    expect(leased).toHaveLength(1);
    // Second consume sees nothing (leased, not expired).
    expect(
      data<{ messages: unknown[] }>(
        (await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${queue.id}/consume`, tokenA, {})).json,
      ).messages,
    ).toHaveLength(0);
    const ack = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/queues/${queue.id}/messages/${leased[0]?.id}/ack`,
      tokenA,
      {},
    );
    expect(ack.status).toBe(200);

    // Dead-letter path on a fresh queue with maxDeliveries 1.
    const dl = await api(base, 'POST', `/api/v1/projects/${projectA}/queues`, tokenA, { name: 'dlq', maxDeliveries: 1 });
    const dlq = data<{ queue: { id: string } }>(dl.json).queue;
    const pub = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${dlq.id}/messages`, tokenA, { body: {} });
    const mid = data<{ message: { id: string } }>(pub.json).message.id;
    await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${dlq.id}/consume`, tokenA, {});
    const nacked = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${dlq.id}/messages/${mid}/nack`, tokenA, { requeue: true });
    expect(data<{ message: { status: string } }>(nacked.json).message.status).toBe('dead');
    const purged = await api(base, 'POST', `/api/v1/projects/${projectA}/queues/${dlq.id}/purge`, tokenA, { statuses: ['dead'] });
    expect(data<{ purged: number }>(purged.json).purged).toBe(1);

    // Cross-tenant isolation: user B sees nothing of project A.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA}/queues`, tokenB)).status).toBe(403);
    expect((await api(base, 'GET', `/api/v1/projects/${projectB}/queues`, tokenA)).status).toBe(403);
    // Validation.
    expect((await api(base, 'POST', `/api/v1/projects/${projectA}/queues`, tokenA, { name: ' bad!' })).status).toBe(400);
  });

  it('schedules: validate, compute next run, trigger a real function', async () => {
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectA}/schedules`, tokenA, {
          name: 'bad',
          functionSlug: 'x',
          cron: 'not a cron',
        })
      ).status,
    ).toBe(400);
    const created = await api(base, 'POST', `/api/v1/projects/${projectA}/schedules`, tokenA, {
      name: 'nightly',
      functionSlug: 'reporter',
      cron: '0 2 * * *',
      payload: { day: true },
    });
    expect(created.status).toBe(201);
    const schedule = data<{ schedule: { id: string; nextRunAt: string } }>(created.json).schedule;
    expect(schedule.nextRunAt).toMatch(/T02:00:00/);

    // Triggering an undeployed function reports failure honestly (no fake success).
    const trig = await api(base, 'POST', `/api/v1/projects/${projectA}/schedules/${schedule.id}/trigger`, tokenA, {});
    expect(trig.status).toBe(200);
    expect(data<{ ok: boolean }>(trig.json).ok).toBe(false);

    // Deploy the function, wait for READY, trigger again → real invocation.
    const mk = await api(base, 'POST', `/api/v1/projects/${projectA}/functions`, tokenA, {
      name: 'Reporter',
      slug: 'reporter',
      description: 'cron target',
    });
    expect(mk.status).toBe(201);
    const dep = await api(base, 'POST', `/api/v1/projects/${projectA}/functions/reporter/deploy`, tokenA, { source: V1 });
    expect(dep.status).toBe(202);
    const deployJob = data<{ job: { id: string } }>(dep.json).job.id;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const g = await api(base, 'GET', `/api/v1/projects/${projectA}/functions/reporter/deployments/${deployJob}`, tokenA);
      const st = data<{ deployment: { status: string; lastError: string | null } }>(g.json).deployment;
      if (st.status === 'ready') break;
      if (st.status === 'failed' || Date.now() > deadline) throw new Error(`deploy failed: ${st.lastError}`);
      await new Promise(r => setTimeout(r, 100));
    }
    const trig2 = await api(base, 'POST', `/api/v1/projects/${projectA}/schedules/${schedule.id}/trigger`, tokenA, {});
    expect(data<{ ok: boolean }>(trig2.json).ok).toBe(true);
    const got = await api(base, 'GET', `/api/v1/projects/${projectA}/schedules/${schedule.id}`, tokenA);
    expect(data<{ schedule: { lastStatus: string } }>(got.json).schedule.lastStatus).toBe('succeeded');
  });

  it('webhooks: secret-once, signed test delivery, history, replay, rotate', async () => {
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectA}/webhooks`, tokenA, {
          name: 'bad',
          url: 'http://localhost:9/hook',
          eventTypes: ['job.failed'],
        })
      ).status,
    ).toBe(400);
    const created = await api(base, 'POST', `/api/v1/projects/${projectA}/webhooks`, tokenA, {
      name: 'ops',
      url: 'https://example.com/hook',
      eventTypes: ['job.failed'],
    });
    expect(created.status).toBe(201);
    const secret = data<{ webhook: { id: string }; secret: string }>(created.json).secret;
    expect(secret.startsWith('whsec_')).toBe(true);
    const hookId = data<{ webhook: { id: string } }>(created.json).webhook.id;
    const listed = await api(base, 'GET', `/api/v1/projects/${projectA}/webhooks`, tokenA);
    expect(JSON.stringify(listed.json)).not.toContain(secret.slice(8));

    // Test delivery: example.com is unreachable-or-non-2xx either way → pending with an attempt.
    const tested = await api(base, 'POST', `/api/v1/projects/${projectA}/webhooks/${hookId}/test`, tokenA, {});
    expect(tested.status).toBe(200);
    const delivery = data<{ delivery: { id: string; status: string; attempts: unknown[] } }>(tested.json).delivery;
    expect(delivery.attempts).toHaveLength(1);
    expect(['pending', 'succeeded']).toContain(delivery.status);

    const history = await api(base, 'GET', `/api/v1/projects/${projectA}/webhooks/${hookId}/deliveries`, tokenA);
    expect(data<{ deliveries: unknown[] }>(history.json).deliveries.length).toBeGreaterThan(0);

    const replayed = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/webhooks/${hookId}/deliveries/${delivery.id}/replay`,
      tokenA,
      {},
    );
    expect(replayed.status).toBe(200);
    expect(data<{ delivery: { id: string } }>(replayed.json).delivery.id).not.toBe(delivery.id);

    const rotated = await api(base, 'POST', `/api/v1/projects/${projectA}/webhooks/${hookId}/rotate`, tokenA, {});
    expect(rotated.status).toBe(200);
    expect(data<{ secret: string }>(rotated.json).secret).not.toBe(secret);

    // Isolation + viewer role gate.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA}/webhooks`, tokenB)).status).toBe(403);
  });

  it('metrics: counts real traffic, scopes by tenant, validates window', async () => {
    const good = await api(base, 'GET', `/api/v1/organizations/${orgA}/metrics?window=1h`, tokenA);
    expect(good.status).toBe(200);
    const summary = data<{ requests: number; projects: string[]; sinceBoot: string }>(good.json);
    expect(summary.requests).toBeGreaterThan(0);
    expect(summary.projects).toContain(projectA);
    expect(summary.projects).not.toContain(projectB);
    expect(summary.sinceBoot).toBeTruthy();
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/metrics?window=9y`, tokenA)).status).toBe(400);
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/metrics`, tokenB)).status).toBe(403);
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/metrics`, null)).status).toBe(401);
  });

  it('csv: export headers, import round-trip, validation', async () => {
    const rowId = '11111111-2222-4333-8444-555555555555';
    const imp = await api(base, 'POST', `/api/v1/projects/${projectA}/users/import`, tokenA, {
      csv: `id,email,age\r\n${rowId},csv@example.com,30\r\n`,
    });
    expect(imp.status).toBe(200);
    expect(data<{ inserted: number; failed: number }>(imp.json)).toMatchObject({ inserted: 1, failed: 0 });

    const exp = await api(base, 'GET', `/api/v1/projects/${projectA}/users/export`, tokenA);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('text/csv');
    const text = exp.json._raw as string;
    expect(text.split('\r\n')[0]).toBe('id,email,age');
    expect(text).toContain('csv@example.com');

    const badCol = await api(base, 'POST', `/api/v1/projects/${projectA}/users/import`, tokenA, {
      csv: 'id,nope\r\nx,y\r\n',
    });
    expect(badCol.status).toBe(400);
    const ragged = await api(base, 'POST', `/api/v1/projects/${projectA}/users/import`, tokenA, {
      csv: 'id,email\r\nonly-one\r\n',
    });
    expect(ragged.status).toBe(400);
  });

  it('diagnose: healthy on a quiet project, structured otherwise', async () => {
    const r = await api(base, 'POST', `/api/v1/projects/${projectA}/ai/diagnose`, tokenA, {});
    expect(r.status).toBe(200);
    const d = data<{ diagnosis: { healthy: boolean; confidence: string; evidence: unknown[] } }>(r.json).diagnosis;
    expect(typeof d.healthy).toBe('boolean');
    expect(['low', 'medium', 'high']).toContain(d.confidence);
    expect(Array.isArray(d.evidence)).toBe(true);
  });
});
