import { describe, expect, it } from 'vitest';
import { NodeWorkerRuntime } from './runtime.js';
import { FunctionService } from './service.js';
import type { FunctionLimits } from './types.js';

const LIMITS: FunctionLimits = {
  executionTimeoutMs: 5000,
  memoryMb: 128,
  maxRequestBodyBytes: 262_144,
  maxResponseBytes: 1_048_576,
  maxConcurrency: 10,
  maxDeploymentBytes: 5_242_880,
  maxFunctionsPerProject: 50,
  maxLogEntries: 500,
  logRetentionDays: 7,
};

const HELLO_V1 = `module.exports.handler = async (req) => ({ status: 200, body: { v: 1, you: req.auth.userId, echo: req.body ?? null } });`;
const HELLO_V2 = `module.exports.handler = async () => ({ status: 200, body: { v: 2 } });`;

function svc(limits: FunctionLimits = LIMITS): FunctionService {
  return new FunctionService(new NodeWorkerRuntime(), { limits, maxEnvValueBytes: 8192 });
}

const P = { projectId: 'p1', organizationId: 'o1', userId: 'u1' };

async function deployReady(
  s: FunctionService,
  slug: string,
  source: string,
  project = P,
): Promise<{ id: string }> {
  const created = await s.createFunction({ ...project, name: slug, slug });
  const { job } = await s.deployFunction({ ...project, idOrSlug: created.id, source });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await s.getDeployment(project.projectId, created.id, job.id);
    if (current.status === 'ready') break;
    if (current.status === 'failed') throw new Error(`deploy failed: ${current.lastError}`);
    if (Date.now() > deadline) throw new Error('deploy timed out');
    await new Promise(r => setTimeout(r, 25));
  }
  return { id: created.id };
}

function invoke(s: FunctionService, projectId: string, id: string, body: unknown = null) {
  return s.invokeFunction({
    projectId,
    idOrSlug: id,
    request: { method: 'POST', path: '/', headers: {}, query: {}, body },
    auth: {
      userId: 'u1',
      email: 'u@example.com',
      role: 'member',
      projectId,
      callerKind: 'session',
    },
    requestId: `r-${Math.random().toString(36).slice(2)}`,
  });
}

describe('function management', () => {
  it('creates, lists, retrieves, updates, deletes', async () => {
    const s = svc();
    const created = await s.createFunction({ ...P, name: 'Hi', slug: 'hi' });
    expect(created.status).toBe('creating');
    expect(await s.listFunctions('p1')).toHaveLength(1);
    expect((await s.getFunction('p1', 'hi')).id).toBe(created.id);
    const updated = await s.updateFunction('p1', created.id, {
      description: 'd',
      entrypoint: 'api.handler',
    });
    expect(updated.entrypoint).toBe('api.handler');
    await s.deleteFunction('p1', created.id);
    expect(await s.listFunctions('p1')).toHaveLength(0);
    await expect(s.getFunction('p1', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects duplicate slugs and enforces project isolation', async () => {
    const s = svc();
    await s.createFunction({ ...P, name: 'Alpha', slug: 'dupe' });
    await expect(s.createFunction({ ...P, name: 'Beta', slug: 'dupe' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(s.getFunction('other-project', 'dupe')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(s.updateFunction('other-project', 'dupe', { name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('deployment pipeline', () => {
  it('create → build → deploy → ready, then invokes the active version', async () => {
    const s = svc();
    const { id } = await deployReady(s, 'hello', HELLO_V1);
    const fn = await s.getFunction('p1', id);
    expect(fn.status).toBe('ready');
    expect(fn.activeVersion).toBe(1);
    const out = await invoke(s, 'p1', id, { n: 7 });
    expect(out.result.status).toBe(200);
    expect(out.result.body).toMatchObject({ v: 1, you: 'u1', echo: { n: 7 } });
    expect(out.version).toBe(1);
    expect(out.coldStart).toBe(true);
    const again = await invoke(s, 'p1', id);
    expect(again.coldStart).toBe(false);
  });

  it('fails honestly on broken source (never READY on failure)', async () => {
    const s = svc();
    const created = await s.createFunction({ ...P, name: 'Bad', slug: 'bad' });
    const { job } = await s.deployFunction({
      ...P,
      idOrSlug: created.id,
      source: 'this is {{{ not js',
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = await s.getDeployment('p1', created.id, job.id);
      if (current.status === 'failed') break;
      if (current.status === 'ready') throw new Error('broken source reported READY');
      if (Date.now() > deadline) throw new Error('deploy timed out');
      await new Promise(r => setTimeout(r, 25));
    }
    expect((await s.getFunction('p1', created.id)).status).toBe('failed');
  });

  it('versions immutably and rolls back via activateVersion', async () => {
    const s = svc();
    const { id } = await deployReady(s, 'ver', HELLO_V1);
    const created = await s.getFunction('p1', id);
    await s.deployFunction({ ...P, idOrSlug: created.id, source: HELLO_V2 });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const fn = await s.getFunction('p1', id);
      if (fn.activeVersion === 2 && fn.status === 'ready') break;
      if (fn.status === 'failed') throw new Error('v2 failed');
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 25));
    }
    expect((await invoke(s, 'p1', id)).result.body).toMatchObject({ v: 2 });
    expect(await s.listVersions('p1', id)).toHaveLength(2);
    await s.activateVersion('p1', id, 1);
    expect((await invoke(s, 'p1', id)).result.body).toMatchObject({ v: 1 });
  });
});

describe('env vars, logs, metrics', () => {
  it('stores secrets, masks them in reads, redacts them in logs', async () => {
    const s = svc();
    const { id } = await deployReady(s, 'envfn', HELLO_V1);
    await s.setEnvVar({
      ...P,
      idOrSlug: id,
      key: 'API_TOKEN',
      value: 'tok-secret-12345',
      secret: true,
    });
    await s.setEnvVar({ ...P, idOrSlug: id, key: 'REGION', value: 'local', secret: false });
    const listed = await s.listEnvVars('p1', id);
    const token = listed.find(e => e.key === 'API_TOKEN');
    expect(token?.value).not.toContain('secret-12345');
    expect(listed.find(e => e.key === 'REGION')?.value).toBe('local');
    const leak = await s.invokeFunction({
      projectId: 'p1',
      idOrSlug: id,
      request: { method: 'POST', path: '/', headers: {}, query: {}, body: null },
      auth: {
        userId: 'u1',
        email: 'u@example.com',
        role: 'member',
        projectId: 'p1',
        callerKind: 'session',
      },
      requestId: 'leak-check',
    });
    void leak;
    const logs = await s.getFunctionLogs('p1', id);
    for (const l of logs) expect(l.message).not.toContain('tok-secret-12345');
  });

  it('records invocation logs and metrics honestly', async () => {
    const s = svc();
    const { id } = await deployReady(
      s,
      'metered',
      `module.exports.handler = async () => { console.log('did work'); return { body: 1 }; };`,
    );
    await invoke(s, 'p1', id);
    const logs = await s.getFunctionLogs('p1', id);
    expect(logs.some(l => l.message.includes('did work'))).toBe(true);
    const m = await s.getMetrics('p1', id);
    expect(m.invocations).toBe(1);
    expect(m.successes).toBe(1);
    expect(m.coldStarts).toBe(1);
  });
});

describe('invocation guards', () => {
  it('rejects deleted functions and cross-project invocation', async () => {
    const s = svc();
    const { id } = await deployReady(s, 'gone', HELLO_V1);
    await s.deleteFunction('p1', id);
    await expect(invoke(s, 'p1', id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { id: kept } = await deployReady(s, 'kept', HELLO_V1);
    await expect(invoke(s, 'project-b', kept)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('times out runaway handlers and counts them', async () => {
    const s = svc({ ...LIMITS, executionTimeoutMs: 300 });
    const { id } = await deployReady(
      s,
      'slow',
      `module.exports.handler = async () => { await new Promise(r => setTimeout(r, 60000)); };`,
    );
    await expect(invoke(s, 'p1', id)).rejects.toMatchObject({ code: 'FUNCTION_TIMEOUT' });
    expect((await s.getMetrics('p1', id)).timeouts).toBe(1);
  });

  it('rate-limits floods via the shared store', async () => {
    const s = svc();
    const { id } = await deployReady(s, 'hot', HELLO_V1);
    const store = { incr: async (): Promise<number> => 10_000 };
    await expect(
      s.invokeFunction({
        projectId: 'p1',
        idOrSlug: id,
        request: { method: 'POST', path: '/', headers: {}, query: {}, body: null },
        auth: { userId: 'u1', email: null, role: 'member', projectId: 'p1', callerKind: 'session' },
        requestId: 'flood',
        rateLimit: store,
        rateMax: 5,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
