import { describe, expect, it, vi } from 'vitest';
import { CloudNivoClient, SdkError } from './index.js';

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

describe('sdk client', () => {
  it('plans, approves, and applies through typed methods', async () => {
    const client = new CloudNivoClient({ baseUrl: 'http://x:3001', token: 't' });
    stubFetch({ data: { plan: { id: 'p1', status: 'pending', summary: 's' } } });
    const plan = await client.aiPlan('proj', 'I need tasks.');
    expect(plan.id).toBe('p1');
    stubFetch({ data: { ok: true, rolledBack: false, error: null, steps: [] } });
    const res = await client.aiApply('proj', 'p1');
    expect(res.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('surfaces API errors as SdkError with codes', async () => {
    const client = new CloudNivoClient({ baseUrl: 'http://x:3001', token: 't' });
    stubFetch({ error: { code: 'FORBIDDEN', message: 'nope' } }, 403);
    await expect(client.aiUsage('proj')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.aiUsage('proj')).rejects.toBeInstanceOf(SdkError);
    vi.unstubAllGlobals();
  });

  it('fails closed when unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const client = new CloudNivoClient({ baseUrl: 'http://x:3001', token: 't' });
    await expect(client.listProjects()).rejects.toMatchObject({ code: 'UNREACHABLE' });
    vi.unstubAllGlobals();
  });

  it('drives the agent surface with bearer auth and approval headers', async () => {
    const seen: { url: string; auth: string | null; approval: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seen.push({
          url: String(url),
          auth: headers.get('authorization'),
          approval: headers.get('x-approval-id'),
        });
        const body = url.includes('/agent/whoami')
          ? { data: { token: { name: 'ci' }, scopes: ['projects.read'] } }
          : url.includes('/deploy')
            ? { data: { function: { slug: 'f' }, job: { id: 'j1' } } }
            : { data: {} };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const client = new CloudNivoClient({ baseUrl: 'http://x:3001', token: 'cn_agent_test' });
    const who = await client.agentWhoami();
    expect(who.token.name).toBe('ci');
    expect(seen[0]?.auth).toBe('Bearer cn_agent_test');
    const dep = await client.deployFunction('p', 'f', 'src', 'apr_1');
    expect(dep.job.id).toBe('j1');
    expect(seen[1]?.approval).toBe('apr_1');
    const projects = await client.listProjects();
    expect(projects).toEqual({});
    vi.unstubAllGlobals();
  });
});
