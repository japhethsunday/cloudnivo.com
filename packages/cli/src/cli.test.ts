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
