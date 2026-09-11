import { describe, expect, it, vi } from 'vitest';
import { parseArgs, run } from './cli.js';

describe('cli arg parsing', () => {
  it('parses commands and flags', () => {
    expect(parseArgs(['ai', 'plan', '--project', 'p1', '--prompt', 'hi there'])).toEqual({
      command: ['ai', 'plan'],
      flags: { project: 'p1', prompt: 'hi there' },
    });
    expect(
      parseArgs(['ai', 'approve', '--project=p1', '--plan=x', '--confirm', 'DROP TABLE']),
    ).toEqual({
      command: ['ai', 'approve'],
      flags: { project: 'p1', plan: 'x', confirm: 'DROP TABLE' },
    });
    expect(() => parseArgs(['ai', 'plan', '--project', 'p', 'stray'])).toThrow();
  });

  it('requires a token and project', async () => {
    const env = { ...process.env };
    delete env['CLOUDNIVO_TOKEN'];
    await expect(
      run(['ai', 'plan', '--project', 'p', '--prompt', 'I need tasks please'], env),
    ).rejects.toThrow(/CLOUDNIVO_TOKEN/);
    process.env.CLOUDNIVO_TOKEN = 't';
    await expect(run(['ai', 'plan', '--prompt', 'I need tasks please'], {})).rejects.toThrow(
      /--project/,
    );
    delete process.env.CLOUDNIVO_TOKEN;
  });

  it('drives plan/approve/apply through the same backend service', async () => {    process.env.CLOUDNIVO_TOKEN = 't';
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${String(url).split('/api')[1]}`);
        const body = {
          data: {
            plan: {
              id: 'pl',
              status: 'pending',
              summary: 's',
              changes: [],
              validation: { destructive: [] },
            },
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const out = await run(['ai', 'plan', '--project', 'proj', '--prompt', 'I need tasks please'], {
      ...process.env,
    });
    expect(out).toContain('pl');
    expect(calls.join('|')).toContain('POST /v1/projects/proj/ai/plan');
    vi.unstubAllGlobals();
    delete process.env.CLOUDNIVO_TOKEN;
  });
});

describe('cli agent commands', () => {
  it('logs in agent tokens only after verifying them', async () => {
    const tmp = `${process.cwd()}/node_modules/.tmp-agent-creds-${Date.now()}.json`;
    const env: NodeJS.ProcessEnv = { ...process.env, CLOUDNIVO_CREDENTIALS: tmp, CLOUDNIVO_API_URL: 'http://x:3001' };
    delete env['CLOUDNIVO_TOKEN'];
    delete env['CLOUDNIVO_AGENT_TOKEN'];
    await expect(run(['agent', 'login', '--token', 'not-an-agent-token'], env)).rejects.toThrow(
      /cn_agent_/,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              token: {
                name: 'ci',
                prefix: 'cn_agent_abc',
                organizationId: 'org-1',
                projectIds: [],
                expiresAt: null,
              },
              scopes: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const out = await run(['agent', 'login', '--token', 'cn_agent_testvalue'], env);
    expect(out).toContain('saved');
    const who = await run(['agent', 'whoami'], env);
    expect(who).toContain('ci');
    vi.unstubAllGlobals();
    await import('node:fs/promises').then(m => m.rm(tmp, { force: true }));
  });

  it('lists projects and deploys functions through the SDK', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${String(url).split('/api')[1]}`);
        const body = String(url).includes('/deploy')
          ? { data: { function: { slug: 'f' }, job: { id: 'j9' } } }
          : { data: { projects: [{ id: 'p1', slug: 'shop' }] } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, CLOUDNIVO_AGENT_TOKEN: 'cn_agent_testvalue' };
    const listed = await run(['agent', 'projects'], env);
    expect(listed).toContain('shop');
    const { writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const src = join(tmpdir(), `cn-agent-src-${Date.now()}.js`);
    await writeFile(src, 'module.exports.handler = async () => ({ ok: true });');
    const deployed = await run(
      ['agent', 'deploy', '--project', 'p1', '--function', 'f', '--source', src],
      env,
    );
    expect(deployed).toContain('j9');
    await rm(src, { force: true });
    expect(calls.join('|')).toContain('POST /v1/projects/p1/functions/f/deploy');
    vi.unstubAllGlobals();
  });
});

describe('cli automation commands', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDNIVO_TOKEN: 't', CLOUDNIVO_API_URL: 'http://x:3001' };

  function stub(routes: [method: string, part: string, body: unknown][]): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        const path = String(url).split('/api')[1] ?? String(url);
        calls.push(`${method} ${path}`);
        const match = routes.find(([m, part]) => {
          if (m !== method) return false;
          if (part.endsWith('$')) return path.endsWith(part.slice(0, -1));
          return path.includes(part);
        })?.[2] ?? { data: {} };
        return new Response(JSON.stringify(match), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  it('queues: create, publish, consume, ack, purge', async () => {
    const calls = stub([
      ['POST', '/messages$', { data: { message: { id: 'm1' }, duplicate: false } }],
      ['POST', '/consume$', { data: { messages: [{ id: 'm1', status: 'leased', body: {} }] } }],
      ['POST', '/ack$', { data: { message: { id: 'm1' } } }],
      ['POST', '/purge$', { data: { purged: 2 } }],
      ['POST', '/queues$', { data: { queue: { id: 'q1', name: 'jobs' } } }],
      ['GET', '/queues$', { data: { queues: [{ id: 'q1', name: 'jobs' }] } }],
    ]);
    expect(await run(['queues', 'create', '--project', 'p1', '--name', 'jobs'], env)).toContain('q1');
    expect(
      await run(['queues', 'publish', '--project', 'p1', '--queue', 'jobs', '--body', '{"n":1}'], env),
    ).toContain('m1');
    expect(await run(['queues', 'consume', '--project', 'p1', '--queue', 'q1'], env)).toContain('m1');
    expect(await run(['queues', 'ack', '--project', 'p1', '--queue', 'q1', '--message', 'm1'], env)).toContain('acked');
    expect(await run(['queues', 'purge', '--project', 'p1', '--queue', 'q1'], env)).toContain('purged 2');
    expect(calls.join('|')).toContain('POST /v1/projects/p1/queues/q1/consume');
    vi.unstubAllGlobals();
  });

  it('schedules, webhooks, metrics, and diagnose', async () => {
    const calls = stub([
      ['POST', '/trigger$', { data: { ok: true, error: null } }],
      ['POST', '/schedules$', { data: { schedule: { id: 's1', nextRunAt: null } } }],
      ['POST', '/webhooks$', { data: { webhook: { id: 'w1' }, secret: 'whsec_x' } }],
      ['POST', '/test$', { data: { delivery: { id: 'd1', status: 'pending' } } }],
      ['GET', '/metrics', { data: { requests: 3, errors: 0, p50Ms: 1, p95Ms: 2 } }],
      ['POST', '/diagnose$', {
        data: { diagnosis: { healthy: true, probableCause: 'none', affectedService: 'none', evidence: [], suggestedFix: 'x', confidence: 'high' } },
      }],
    ]);
    expect(
      await run(['schedules', 'create', '--project', 'p1', '--name', 'n', '--function', 'f', '--cron', '0 * * * *'], env),
    ).toContain('s1');
    expect(await run(['schedules', 'trigger', '--project', 'p1', '--schedule', 's1'], env)).toContain('fired');
    expect(
      await run(['webhooks', 'create', '--project', 'p1', '--name', 'w', '--url', 'https://example.com/h', '--events', 'job.failed'], env),
    ).toContain('whsec_x');
    expect(await run(['webhooks', 'test', '--project', 'p1', '--webhook', 'w1'], env)).toContain('d1');
    expect(await run(['metrics', '--org', 'o1', '--project', 'p1'], env)).toContain('requests=3');
    expect(await run(['ai', 'diagnose', '--project', 'p1'], env)).toContain('healthy');
    expect(calls.join('|')).toContain('POST /v1/projects/p1/ai/diagnose');
    vi.unstubAllGlobals();
  });

  it('rejects unknown groups and bad JSON bodies', async () => {
    stub([['GET', '/queues', { data: { queues: [{ id: 'q1', name: 'jobs' }] } }]]);
    await expect(run(['nope'], env)).rejects.toThrow(/Unknown command/);
    await expect(
      run(['queues', 'publish', '--project', 'p1', '--queue', 'q', '--body', '{bad'], env),
    ).rejects.toThrow(/valid JSON/);
    vi.unstubAllGlobals();
  });
});
