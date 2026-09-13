import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';
import {
  newDrainSecret,
  signDrainPayload,
  verifyDrainSignature,
} from './platform-ops.js';

const JWT_SECRET = 'o'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('platform ops: status, domains, drains', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await signSession({ sub: USER_A, email: 'ops-a@example.com' }, { jwtSecret: JWT_SECRET });
    tokenB = await signSession({ sub: USER_B, email: 'ops-b@example.com' }, { jwtSecret: JWT_SECRET });
    for (const [tok, slug] of [
      [tokenA, 'opsa'],
      [tokenB, 'opsb'],
    ] as const) {
      const org = await api(base, 'POST', '/api/v1/organizations', tok, {
        name: `Ops ${slug}`,
        slug,
      });
      const id = data<{ organization: { id: string } }>(org.json).organization.id;
      if (tok === tokenA) orgA = id;
      else orgB = id;
    }
  });
  afterAll(async () => {
    await close();
  });

  it('serves public status without auth; incident writes require an operator', async () => {
    const pub = await api(base, 'GET', '/api/v1/status', null);
    expect(pub.status).toBe(200);
    expect(data<{ status: string }>(pub.json).status).toBe('ok');

    expect((await api(base, 'POST', '/api/v1/status/incidents', null, { title: 'x' })).status).toBe(
      401,
    );
  });

  it('operator creates, patches, and resolves incidents', async () => {
    const created = await api(base, 'POST', '/api/v1/status/incidents', tokenA, {
      title: 'DB latency',
      severity: 'major',
      message: 'p99 elevated',
    });
    expect(created.status).toBe(201);
    const incident = data<{ incident: { id: string; status: string; resolvedAt: string | null } }>(
      created.json,
    ).incident;
    expect(incident.status).toBe('open');
    expect(incident.resolvedAt).toBeNull();

    expect(
      (await api(base, 'POST', '/api/v1/status/incidents', tokenA, { title: '' })).status,
    ).toBe(400);

    const monitoring = await api(
      base,
      'PATCH',
      `/api/v1/status/incidents/${incident.id}`,
      tokenA,
      { status: 'monitoring' },
    );
    expect(monitoring.status).toBe(200);
    expect(data<{ incident: { status: string } }>(monitoring.json).incident.status).toBe(
      'monitoring',
    );

    const resolved = await api(base, 'PATCH', `/api/v1/status/incidents/${incident.id}`, tokenA, {
      status: 'resolved',
    });
    expect(resolved.status).toBe(200);
    const done = data<{ incident: { status: string; resolvedAt: string | null } }>(resolved.json)
      .incident;
    expect(done.status).toBe('resolved');
    expect(done.resolvedAt).not.toBeNull();

    expect(
      (await api(base, 'PATCH', '/api/v1/status/incidents/00000000-0000-0000-0000-000000000000', tokenA, { status: 'open' }))
        .status,
    ).toBe(404);

    const pub = await api(base, 'GET', '/api/v1/status', null);
    expect(pub.status).toBe(200);
    expect(data<{ status: string }>(pub.json).status).toBe('ok');
  });

  it('custom domains: validate, dedupe, verify-fail, isolate, delete', async () => {
    const mine = `/api/v1/organizations/${orgA}/domains`;
    const created = await api(base, 'POST', mine, tokenA, {
      domain: 'api.example.com',
      purpose: 'api',
    });
    expect(created.status).toBe(201);
    const domain = data<{ domain: { id: string; domain: string; dnsRecord: string } }>(created.json)
      .domain;
    expect(domain.domain).toBe('api.example.com');
    expect(domain.dnsRecord).toContain('cloudnivo-verify=');
    // Verification token travels only inside the DNS record, never as a field.
    expect(JSON.stringify(created.json)).not.toContain('verifyToken');

    expect((await api(base, 'POST', mine, tokenA, { domain: 'not a domain!!' })).status).toBe(400);
    expect((await api(base, 'POST', mine, tokenA, { domain: 'API.EXAMPLE.COM' })).status).toBe(409);

    const listed = await api(base, 'GET', mine, tokenA);
    expect(
      data<{ domains: { id: string }[] }>(listed.json).domains.map(d => d.id),
    ).toContain(domain.id);

    // Cross-org: B's own org sees nothing; B touching A's org is forbidden.
    expect(
      data<{ domains: unknown[] }>(
        (await api(base, 'GET', `/api/v1/organizations/${orgB}/domains`, tokenB)).json,
      ).domains,
    ).toEqual([]);
    expect((await api(base, 'DELETE', `${mine}/${domain.id}`, tokenB)).status).toBe(403);

    // Unverifiable domain reports verified:false without throwing.
    const bogus = await api(base, 'POST', mine, tokenA, { domain: 'verify-me.invalid' });
    expect(bogus.status).toBe(201);
    const bogusId = data<{ domain: { id: string } }>(bogus.json).domain.id;
    const check = await api(base, 'POST', `${mine}/${bogusId}/verify`, tokenA);
    expect(check.status).toBe(200);
    expect(data<{ verified: boolean }>(check.json).verified).toBe(false);
    expect((await api(base, 'DELETE', `${mine}/${bogusId}`, tokenA)).status).toBe(200);

    expect((await api(base, 'DELETE', `${mine}/${domain.id}`, tokenA)).status).toBe(200);
    expect((await api(base, 'DELETE', `${mine}/${domain.id}`, tokenA)).status).toBe(404);
  });

  it('log drains: SSRF guard, secret-once, toggle, isolate, delete', async () => {
    const mine = `/api/v1/organizations/${orgA}/drains`;
    const created = await api(base, 'POST', mine, tokenA, {
      url: 'https://example.com/hook',
      events: ['audit'],
    });
    expect(created.status).toBe(201);
    const { drain, secret } = data<{ drain: { id: string; url: string }; secret: string }>(
      created.json,
    );
    expect(drain.url).toBe('https://example.com/hook');
    expect(secret.startsWith('drsec_')).toBe(true);
    // Raw secret is returned once and never echoed in drain payloads.
    expect(JSON.stringify((created.json['data'] as { drain: unknown }).drain)).not.toContain(secret);

    expect((await api(base, 'POST', mine, tokenA, { url: 'http://localhost:9/hook' })).status).toBe(
      400,
    );
    expect(
      (await api(base, 'POST', mine, tokenA, { url: 'https://example.com/hook', events: [] })).status,
    ).toBe(400);

    const listed = await api(base, 'GET', mine, tokenA);
    expect(data<{ drains: { id: string }[] }>(listed.json).drains.map(d => d.id)).toContain(
      drain.id,
    );
    expect(JSON.stringify(listed.json)).not.toContain(secret);

    const toggled = await api(base, 'POST', `${mine}/${drain.id}/toggle`, tokenA, {
      enabled: false,
    });
    expect(toggled.status).toBe(200);
    expect(data<{ drain: { enabled: boolean } }>(toggled.json).drain.enabled).toBe(false);

    expect((await api(base, 'DELETE', `${mine}/${drain.id}`, tokenB)).status).toBe(403);

    expect((await api(base, 'DELETE', `${mine}/${drain.id}`, tokenA)).status).toBe(200);
    expect((await api(base, 'DELETE', `${mine}/${drain.id}`, tokenA)).status).toBe(404);
  });

  it('drain signing helpers round-trip', () => {
    const { raw, prefix, hash } = newDrainSecret();
    expect(raw.startsWith('drsec_')).toBe(true);
    expect(prefix).toBe(raw.slice(0, 10));
    const sig = signDrainPayload(hash, '{"hello":1}');
    expect(verifyDrainSignature(hash, '{"hello":1}', sig)).toBe(true);
    expect(verifyDrainSignature(hash, '{"hello":2}', sig)).toBe(false);
    expect(verifyDrainSignature(hash, '{"hello":1}', null)).toBe(false);
  });
});
