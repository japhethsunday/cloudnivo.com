import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const execFileAsync = promisify(execFile);
const runDocker = process.env.DOCKER_TESTS === '1';

async function dockerPresent(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

const JWT_SECRET = 'c'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

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

interface WsEnvelope {
  type?: string;
  channel?: string;
  event?: string;
  data?: Record<string, unknown>;
  id?: string;
}

/** Minimal promise-based WS helper over the Node 22 global WebSocket. */
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws connect failed'));
    };
  });
}

function nextMatching(
  ws: WebSocket,
  pred: (m: WsEnvelope) => boolean,
  timeoutMs = 15_000,
): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      reject(new Error('ws message timeout'));
    }, timeoutMs);
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsEnvelope;
        if (pred(msg)) {
          clearTimeout(timer);
          ws.onmessage = null;
          resolve(msg);
        }
      } catch {
        // Keep waiting.
      }
    };
  });
}

// Full CDC path on real infrastructure: provisioned Postgres → trigger →
// LISTEN → gateway → WebSocket. Needs Docker (provider + image pull); runs
// only with DOCKER_TESTS=1.
describe.skipIf(!runDocker)('phase 6 CDC E2E on live postgres', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let token = '';
  let projectId = '';
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    if (!(await dockerPresent())) {
      console.warn('Docker not present; skipping live CDC assertions');
      return;
    }
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.CACHE_DRIVER = 'memory';
    process.env.PROVISION_DRIVER = 'docker';
    process.env.PROVISION_BASE_PORT = '15720';
    const { start } = await import('./index.js');
    const { server, port } = await start(0);
    const srv = server as Server;
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve())));
    token = await signSession(
      { sub: USER_A, email: `${USER_A}@example.com` },
      { jwtSecret: JWT_SECRET },
    );
    const org = await api(base, 'POST', '/api/v1/organizations', token, {
      name: 'cdcorg',
      slug: 'cdcorg',
    });
    const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
    const p = await api(base, 'POST', '/api/v1/projects', token, {
      name: 'cdcshop',
      slug: 'cdcshop',
      organizationId: orgId,
    });
    const created = data<{ project: { id: string }; jobId: string }>(p.json);
    projectId = created.project.id;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const j = await api(
        base,
        'GET',
        `/api/v1/projects/${projectId}/jobs/${created.jobId}`,
        token,
      );
      const st = data<{ job: { status: string } }>(j.json).job.status;
      if (st === 'completed') break;
      if (st === 'failed' || Date.now() > deadline) throw new Error('provisioning failed');
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 240_000);

  afterAll(async () => {
    for (const ws of sockets) {
      try {
        ws.close(1000, 'done');
      } catch {
        // Already gone.
      }
    }
    if (projectId && token && base) {
      await api(base, 'DELETE', `/api/v1/projects/${projectId}`, token).catch(() => undefined);
    }
    await close();
  });

  async function sql(text: string): Promise<void> {
    const r = await api(base, 'POST', `/api/v1/projects/${projectId}/database/query`, token, {
      sql: text,
    });
    expect(r.status).toBe(200);
  }

  it('INSERT → UPDATE → DELETE rows arrive as table events over WS', async () => {
    if (!base) return;
    await sql('CREATE TABLE live_notes (id serial primary key, user_id text, n int)');
    const wsUrl = `${base.replace(/^http/, 'ws')}/api/v1/projects/${projectId}/realtime/ws?token=${token}`;
    const ws = await connectWs(wsUrl);
    sockets.push(ws);
    const channel = `project:${projectId}:table:live_notes`;
    ws.send(JSON.stringify({ id: 'sub1', type: 'subscribe', channel }));
    await nextMatching(ws, m => m.id === 'sub1' && m.type === 'subscribed');

    await sql(`INSERT INTO live_notes (user_id, n) VALUES ('u1', 1)`);
    const inserted = await nextMatching(
      ws,
      m => m.type === 'event' && (m.data as { type?: string })?.type === 'INSERT',
    );
    expect(inserted.channel).toBe(channel);
    expect((inserted.data as { record?: unknown })?.record).toMatchObject({ user_id: 'u1', n: 1 });

    await sql(`UPDATE live_notes SET n = 2 WHERE user_id = 'u1'`);
    const updated = await nextMatching(
      ws,
      m => m.type === 'event' && (m.data as { type?: string })?.type === 'UPDATE',
    );
    expect((updated.data as { record?: unknown })?.record).toMatchObject({ n: 2 });
    expect((updated.data as { old_record?: unknown })?.old_record).toMatchObject({ n: 1 });

    await sql(`DELETE FROM live_notes WHERE user_id = 'u1'`);
    const deleted = await nextMatching(
      ws,
      m => m.type === 'event' && (m.data as { type?: string })?.type === 'DELETE',
    );
    expect((deleted.data as { old_record?: unknown })?.old_record).toMatchObject({ user_id: 'u1' });
  }, 120_000);
});
