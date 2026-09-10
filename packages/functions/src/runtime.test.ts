import { describe, expect, it } from 'vitest';
import { DockerFunctionRuntime, DOCKER_HARNESS, NodeWorkerRuntime } from './runtime.js';
import { FunctionError } from './types.js';

const ECHO = `module.exports.handler = async (req) => ({ status: 200, body: { method: req.method, echo: req.body ?? null } });`;

function req(body: unknown = null) {
  return { method: 'POST', path: '/', headers: {}, query: {}, body };
}

function auth() {
  return {
    userId: 'u1',
    email: 'u@example.com',
    role: 'member',
    projectId: 'p1',
    callerKind: 'session',
  } as const;
}

describe('worker runtime execution', () => {
  const rt = new NodeWorkerRuntime();

  it('executes real handler code and returns structured results', async () => {
    const out = await rt.execute({
      source: ECHO,
      entrypoint: 'handler',
      request: req({ hi: 1 }),
      auth: { ...auth() },
      env: {},
      timeoutMs: 5000,
      memoryMb: 128,
      maxResponseBytes: 1_048_576,
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ method: 'POST', echo: { hi: 1 } });
    expect(out.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('denies host access: require/process/fetch are undefined inside', async () => {
    const src = `module.exports.handler = async () => ({
      status: 200,
      body: {
        require: typeof require,
        process: typeof process,
        fetch: typeof fetch,
        WebSocket: typeof WebSocket,
        user: cloudnivo.auth.userId,
        project: cloudnivo.project.id,
      },
    });`;
    const out = await rt.execute({
      source: src,
      entrypoint: 'handler',
      request: req(),
      auth: { ...auth() },
      env: { PUB: 'yes' },
      timeoutMs: 5000,
      memoryMb: 128,
      maxResponseBytes: 1_048_576,
    });
    expect(out.body).toMatchObject({
      require: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
      WebSocket: 'undefined',
      user: 'u1',
      project: 'p1',
    });
  });

  it('captures console output as logs', async () => {
    const out = await rt.execute({
      source: `module.exports.handler = async () => { console.log('hello', 42); console.warn('careful'); return { body: 'ok' }; };`,
      entrypoint: 'handler',
      request: req(),
      auth: { ...auth() },
      env: {},
      timeoutMs: 5000,
      memoryMb: 128,
      maxResponseBytes: 1_048_576,
    });
    expect(out.logs.some(l => l.level === 'log' && l.message.includes('hello'))).toBe(true);
    expect(out.logs.some(l => l.level === 'warn')).toBe(true);
  });

  it('enforces timeouts by terminating the isolate', async () => {
    await expect(
      rt.execute({
        source: `module.exports.handler = async () => { await new Promise(r => setTimeout(r, 60000)); };`,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 300,
        memoryMb: 128,
        maxResponseBytes: 1_048_576,
      }),
    ).rejects.toMatchObject({ code: 'FUNCTION_TIMEOUT' });
  });

  it('rejects missing entrypoints and oversized responses', async () => {
    await expect(
      rt.execute({
        source: `module.exports.other = 1;`,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 5000,
        memoryMb: 128,
        maxResponseBytes: 1_048_576,
      }),
    ).rejects.toMatchObject({ code: 'ENTRYPOINT_NOT_FOUND' });
    await expect(
      rt.execute({
        source: `module.exports.handler = async () => ({ body: 'x'.repeat(10000) });`,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 5000,
        memoryMb: 128,
        maxResponseBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('surfaces handler errors without leaking internals', async () => {
    await expect(
      rt.execute({
        source: `module.exports.handler = async () => { throw new Error('boom-secret-xyz'); };`,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 5000,
        memoryMb: 128,
        maxResponseBytes: 1_048_576,
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
  });

  it('denies SDK access when no hooks are injected', async () => {
    await expect(
      rt.execute({
        source: `module.exports.handler = async () => { await cloudnivo.database.query('select 1'); };`,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 5000,
        memoryMb: 128,
        maxResponseBytes: 1_048_576,
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
  });
});

describe('worker runtime SDK capabilities', () => {
  const rt = new NodeWorkerRuntime();
  const base = {
    entrypoint: 'handler',
    request: req(),
    auth: { ...auth() },
    env: {},
    timeoutMs: 5000,
    memoryMb: 128,
    maxResponseBytes: 1_048_576,
  };

  it('runs guarded database queries through injected hooks', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const out = await rt.execute({
      ...base,
      source: `module.exports.handler = async () => ({ body: await cloudnivo.database.query('select * from notes where id = 1', [1]) });`,
      sdk: {
        databaseQuery: async (sql, params) => {
          seen.push({ sql, params });
          return [{ id: 1 }];
        },
      },
    });
    expect(out.body).toEqual([{ id: 1 }]);
    expect(seen).toHaveLength(1);
  });

  it('rejects non-SELECT statements before any hook runs', async () => {
    let called = false;
    await expect(
      rt.execute({
        ...base,
        source: `module.exports.handler = async () => { await cloudnivo.database.query('DROP TABLE notes'); };`,
        sdk: {
          databaseQuery: async () => {
            called = true;
            return [];
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
    expect(called).toBe(false);
  });

  it('binds realtime publish to the function project', async () => {
    const published: { channel: string; event: string }[] = [];
    const out = await rt.execute({
      ...base,
      source: `module.exports.handler = async () => { await cloudnivo.realtime.publish('project:p1:chat', 'msg', { n: 1 }); return { body: 'sent' }; };`,
      sdk: {
        realtimePublish: async (channel, event) => {
          published.push({ channel, event });
        },
      },
    });
    expect(out.body).toBe('sent');
    expect(published).toEqual([{ channel: 'project:p1:chat', event: 'msg' }]);
    await expect(
      rt.execute({
        ...base,
        source: `module.exports.handler = async () => { await cloudnivo.realtime.publish('project:other:chat', 'msg'); };`,
        sdk: { realtimePublish: async () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_ERROR' });
  });

  it('reads storage objects through injected hooks', async () => {
    const out = await rt.execute({
      ...base,
      source: `module.exports.handler = async () => ({ body: await cloudnivo.storage.read('docs', 'a.txt') });`,
      sdk: {
        storageRead: async (bucket, path) => ({
          bucket,
          path,
          mimeType: 'text/plain',
          size: 5,
          body: 'hello',
          encoding: 'utf8' as const,
        }),
      },
    });
    expect(out.body).toMatchObject({ body: 'hello' });
  });
});

describe('docker runtime contract', () => {
  it('exposes the container driver and a vm-based harness', () => {
    const rt = new DockerFunctionRuntime();
    expect(rt.driver).toBe('docker');
    expect(DOCKER_HARNESS).toContain('vm');
    expect(DOCKER_HARNESS).toContain('createContext');
  });

  it('fails honestly without an image or engine (never fakes execution)', async () => {
    const rt = new DockerFunctionRuntime();
    await expect(
      rt.execute({
        source: ECHO,
        entrypoint: 'handler',
        request: req(),
        auth: { ...auth() },
        env: {},
        timeoutMs: 5000,
        memoryMb: 128,
        maxResponseBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(FunctionError);
  });
});
