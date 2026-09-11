import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'g'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const FN_SOURCE = `module.exports.handler = async () => ({ status: 200, body: { ok: true } });`;

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), 'cn-api-agents-'));
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
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
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
  return { status: res.status, json };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

async function mkProject(
  base: string,
  tok: string,
  org: string,
  slug: string,
): Promise<string> {
  const p = await api(base, 'POST', '/api/v1/projects', tok, {
    name: slug,
    slug,
    organizationId: org,
  });
  expect(p.status).toBe(202);
  return data<{ project: { id: string } }>(p.json).project.id;
}

async function issueAgent(
  base: string,
  ownerToken: string,
  org: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return api(base, 'POST', `/api/v1/organizations/${org}/agent-tokens`, ownerToken, body);
}

describe('phase 13 agent tokens', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let orgA = '';
  let orgB = '';
  let projectA1 = '';
  let projectA2 = '';
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
    orgA = await mkOrg(tokenA, 'agentorga');
    orgB = await mkOrg(tokenB, 'agentorgb');
    projectA1 = await mkProject(base, tokenA, orgA, 'agentshop');
    projectA2 = await mkProject(base, tokenA, orgA, 'agentblog');
    projectB = await mkProject(base, tokenB, orgB, 'agentother');
  });

  afterAll(async () => {
    await close();
    const dir = process.env.STORAGE_LOCAL_DIR ?? '';
    if (dir.includes('cn-api-agents-')) await rm(dir, { recursive: true, force: true });
  });

  it('issues cn_agent_ tokens once-only, validates input, restricts managers', async () => {
    const created = await issueAgent(base, tokenA, orgA, {
      name: 'Claude Code',
      scopes: ['projects.read', 'database.read'],
      projectIds: [projectA1],
      approvalRequired: false,
      expiresIn: '30d',
    });
    expect(created.status).toBe(201);
    const { token, raw } = data<{ token: Record<string, unknown>; raw: string }>(created.json);
    expect(typeof raw === 'string' && raw.startsWith('cn_agent_')).toBe(true);
    expect(token).not.toHaveProperty('hash');
    expect(token).toMatchObject({ name: 'Claude Code' });

    // Unknown scope rejected.
    expect(
      (await issueAgent(base, tokenA, orgA, { name: 'bad', scopes: ['nope'], projectIds: [] })).status,
    ).toBe(400);
    // Project from another org rejected.
    expect(
      (await issueAgent(base, tokenA, orgA, { name: 'bad', scopes: ['projects.read'], projectIds: [projectB] }))
        .status,
    ).toBe(400);
    // Missing project rejected.
    expect(
      (
        await issueAgent(base, tokenA, orgA, {
          name: 'bad',
          scopes: ['projects.read'],
          projectIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(404);
    // Strangers cannot issue for org A.
    expect(
      (await issueAgent(base, tokenB, orgA, { name: 'x', scopes: ['projects.read'], projectIds: [] })).status,
    ).toBe(403);
  });

  it('blocks viewers from managing agent tokens', async () => {
    const email = 'agent-viewer@example.com';
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email,
      password: 'viewer-password-1',
    });
    expect(signup.status).toBe(201);
    const viewerToken = data<{ token: string }>(signup.json).token;
    const invite = await api(base, 'POST', `/api/v1/organizations/${orgA}/invites`, tokenA, {
      email,
      role: 'viewer',
    });
    expect(invite.status).toBe(201);
    const inviteToken = data<{ token: string }>(invite.json).token;
    expect((await api(base, 'POST', `/api/v1/invites/${inviteToken}/accept`, viewerToken, {})).status).toBe(
      200,
    );
    expect(
      (await issueAgent(base, viewerToken, orgA, { name: 'x', scopes: ['projects.read'], projectIds: [] }))
        .status,
    ).toBe(403);
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/agent-tokens`, viewerToken)).status).toBe(
      403,
    );
  });

  it('authenticates scoped reads and isolates organizations/projects', async () => {
    const created = await issueAgent(base, tokenA, orgA, {
      name: 'reader',
      scopes: ['projects.read', 'database.read'],
      projectIds: [projectA1],
    });
    const raw = data<{ raw: string }>(created.json).raw;
    const list = await api(base, 'GET', '/api/v1/projects', raw);
    expect(list.status).toBe(200);
    const ids = data<{ projects: { id: string }[] }>(list.json).projects.map(p => p.id);
    expect(ids).toEqual([projectA1]);

    // Other project in the same org: forbidden.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA2}`, raw)).status).toBe(403);
    // Other org's project: forbidden.
    expect((await api(base, 'GET', `/api/v1/projects/${projectB}`, raw)).status).toBe(403);
    // Unknown agent token: unauthorized.
    expect(
      (await api(base, 'GET', '/api/v1/projects', 'cn_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status,
    ).toBe(401);
    // Sessions still work alongside agent auth.
    expect((await api(base, 'GET', '/api/v1/projects', tokenA)).status).toBe(200);
  });

  it('enforces read-vs-write scopes on the data plane', async () => {
    // Writer first: the fake driver materializes tables on insert.
    const writer = await issueAgent(base, tokenA, orgA, {
      name: 'writer',
      scopes: ['projects.read', 'database.read', 'database.write'],
      projectIds: [projectA1],
    });
    const wraw = data<{ raw: string }>(writer.json).raw;
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA1}/users`, wraw, { id: 'w1', email: 'a@b.c' }))
        .status,
    ).toBe(201);

    const created = await issueAgent(base, tokenA, orgA, {
      name: 'readonly',
      scopes: ['projects.read', 'database.read'],
      projectIds: [projectA1],
    });
    const raw = data<{ raw: string }>(created.json).raw;
    // Read allowed.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA1}/users/w1`, raw)).status).toBe(200);
    // Write denied without database.write.
    const denied = await api(base, 'POST', `/api/v1/projects/${projectA1}/users`, raw, {
      id: 'w2',
      email: 'b@c.d',
    });
    expect(denied.status).toBe(403);
    // Agents can never manage API keys.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA1}/keys`, wraw)).status).toBe(403);
  });

  it('blocks deletes without scope and runs the approval workflow', async () => {
    // Plain token without delete scope: hard deny.
    const plain = await issueAgent(base, tokenA, orgA, {
      name: 'plain',
      scopes: ['projects.read', 'projects.create'],
      projectIds: [],
    });
    const plainRaw = data<{ raw: string }>(plain.json).raw;
    expect((await api(base, 'DELETE', `/api/v1/projects/${projectA2}`, plainRaw)).status).toBe(403);
    expect((await api(base, 'GET', `/api/v1/projects/${projectA2}`, tokenA)).status).toBe(200);

    // Approval-gated token: 428 with an approval id, nothing executed.
    const gated = await issueAgent(base, tokenA, orgA, {
      name: 'gated',
      scopes: ['projects.read'],
      projectIds: [],
      approvalRequired: true,
    });
    const gatedRaw = data<{ raw: string }>(gated.json).raw;
    const held = await api(base, 'DELETE', `/api/v1/projects/${projectA2}`, gatedRaw);
    expect(held.status).toBe(428);
    const approvalId = (
      held.json['data'] as { approval: { id: string; action: string; status: string } }
    ).approval.id;
    expect(approvalId).toBeTruthy();
    // Still there.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA2}`, tokenA)).status).toBe(200);

    // Agent sees its own pending approval; owner sees the inbox.
    const mine = await api(base, 'GET', '/api/v1/agent/approvals?status=pending', gatedRaw);
    expect(mine.status).toBe(200);
    expect(data<{ approvals: { id: string }[] }>(mine.json).approvals.map(a => a.id)).toContain(
      approvalId,
    );
    const inbox = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgA}/approvals?status=pending`,
      tokenA,
    );
    expect(inbox.status).toBe(200);

    // Wrong approval id is rejected.
    expect(
      (
        await api(base, 'DELETE', `/api/v1/projects/${projectA2}`, gatedRaw, undefined, {
          'X-Approval-Id': 'apr_bogus',
        })
      ).status,
    ).toBe(403);

    // Owner approves; retry with the id executes exactly once.
    expect(
      (await api(base, 'POST', `/api/v1/organizations/${orgA}/approvals/${approvalId}/approve`, tokenA, {}))
        .status,
    ).toBe(200);
    const executed = await api(base, 'DELETE', `/api/v1/projects/${projectA2}`, gatedRaw, undefined, {
      'X-Approval-Id': approvalId,
    });
    expect(executed.status).toBe(200);
    expect((await api(base, 'GET', `/api/v1/projects/${projectA2}`, tokenA)).status).toBe(404);
    // Consumed approvals cannot be decided or replayed again.
    expect(
      (
        await api(base, 'POST', `/api/v1/organizations/${orgA}/approvals/${approvalId}/approve`, tokenA, {})
      ).status,
    ).toBe(409);
    expect(
      (
        await api(base, 'DELETE', `/api/v1/projects/${projectA2}`, gatedRaw, undefined, {
          'X-Approval-Id': approvalId,
        })
      ).status,
    ).toBe(404);
  });

  it('revokes immediately and audits activity', async () => {
    const created = await issueAgent(base, tokenA, orgA, {
      name: 'shortlived',
      scopes: ['projects.read'],
      projectIds: [],
    });
    const { token, raw } = data<{ token: { id: string }; raw: string }>(created.json);
    expect((await api(base, 'GET', '/api/v1/projects', raw)).status).toBe(200);
    // Only the owning user (or rather, owner/admins of their own view) — revoke as owner.
    expect((await api(base, 'DELETE', `/api/v1/organizations/${orgA}/agent-tokens/${token.id}`, tokenA)).status).toBe(
      200,
    );
    expect((await api(base, 'GET', '/api/v1/projects', raw)).status).toBe(403);

    const activity = await api(
      base,
      'GET',
      `/api/v1/organizations/${orgA}/agent-activity?tokenId=${token.id}&limit=50`,
      tokenA,
    );
    expect(activity.status).toBe(200);
    const actions = data<{ activity: { action: string; result: string }[] }>(activity.json).activity.map(
      a => `${a.action}:${a.result}`,
    );
    expect(actions).toContain('token.created:success');
    expect(actions).toContain('token.revoked:success');
  });

  it('gates functions, storage, and billing by scope', async () => {
    const reader = await issueAgent(base, tokenA, orgA, {
      name: 'fnreader',
      scopes: ['projects.read', 'functions.read', 'storage.read', 'billing.read', 'usage.read', 'logs.read'],
      projectIds: [projectA1],
    });
    const rraw = data<{ raw: string }>(reader.json).raw;
    expect((await api(base, 'GET', `/api/v1/projects/${projectA1}/functions`, rraw)).status).toBe(200);
    // Deploy needs functions.deploy.
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectA1}/functions/fn1/deploy`, rraw, {
          source: FN_SOURCE,
        })
      ).status,
    ).toBe(403);
    // Invoke needs functions.deploy as well.
    expect((await api(base, 'POST', `/api/v1/projects/${projectA1}/functions/fn1/invoke`, rraw, {}))
      .status).toBe(403);
    // Storage reads allowed, writes denied.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA1}/storage/buckets`, rraw)).status).toBe(
      200,
    );
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA1}/storage/buckets`, rraw, { name: 'b1' }))
        .status,
    ).toBe(403);
    // Billing reads allowed, plan changes denied.
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/billing/usage`, rraw)).status).toBe(
      200,
    );
    expect(
      (
        await api(base, 'POST', `/api/v1/organizations/${orgA}/billing/subscription`, rraw, {
          action: 'cancel',
        })
      ).status,
    ).toBe(403);
    // Usage without usage.read is denied (reader has it; prove denial with a fresh token).
    const narrow = await issueAgent(base, tokenA, orgA, {
      name: 'narrow',
      scopes: ['projects.read'],
      projectIds: [projectA1],
    });
    const nraw = data<{ raw: string }>(narrow.json).raw;
    expect((await api(base, 'GET', `/api/v1/organizations/${orgA}/billing/usage`, nraw)).status).toBe(
      403,
    );
  });

  it('deploys and invokes functions with the deploy scope, then deletes via approval', async () => {
    const deployer = await issueAgent(base, tokenA, orgA, {
      name: 'deployer',
      scopes: ['projects.read', 'functions.read', 'functions.deploy', 'functions.update', 'logs.read'],
      projectIds: [projectA1],
    });
    const draw = data<{ raw: string }>(deployer.json).raw;
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectA1}/functions`, draw, {
          name: 'agentfn',
          slug: 'agentfn',
          runtime: 'node22',
          entrypoint: 'handler',
        })
      ).status,
    ).toBe(201);
    const dep = await api(base, 'POST', `/api/v1/projects/${projectA1}/functions/agentfn/deploy`, draw, {
      source: FN_SOURCE,
    });
    expect(dep.status).toBe(202);
    const jobId = data<{ job: { id: string } }>(dep.json).job.id;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const j = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA1}/functions/agentfn/deployments/${jobId}`,
        draw,
      );
      const st = data<{ deployment: { status: string } }>(j.json).deployment.status;
      if (st === 'ready') break;
      if (st === 'failed' || Date.now() > deadline) throw new Error('deploy failed');
      await new Promise(r => setTimeout(r, 200));
    }
    const invoked = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA1}/functions/agentfn/invoke`,
      draw,
      {},
    );
    expect(invoked.status).toBe(200);

    // Delete without the scope but with approvalRequired → 428 → approve → delete.
    const gated = await issueAgent(base, tokenA, orgA, {
      name: 'gatedfn',
      scopes: ['projects.read', 'functions.read'],
      projectIds: [projectA1],
      approvalRequired: true,
    });
    const graw = data<{ raw: string }>(gated.json).raw;
    const held = await api(base, 'DELETE', `/api/v1/projects/${projectA1}/functions/agentfn`, graw);
    expect(held.status).toBe(428);
    const approvalId = (held.json['data'] as { approval: { id: string } }).approval.id;
    expect(
      (await api(base, 'POST', `/api/v1/organizations/${orgA}/approvals/${approvalId}/approve`, tokenA, {}))
        .status,
    ).toBe(200);
    expect(
      (
        await api(base, 'DELETE', `/api/v1/projects/${projectA1}/functions/agentfn`, graw, undefined, {
          'X-Approval-Id': approvalId,
        })
      ).status,
    ).toBe(204);
  });
});
