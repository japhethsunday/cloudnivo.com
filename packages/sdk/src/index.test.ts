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

  it('drives automation, metrics, diagnose, and CSV through typed methods', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(`${init.method ?? 'GET'} ${String(url)}`);
        const u = String(url);
        const body = u.includes('/queues') && (init.method ?? 'GET') === 'POST' && !u.includes('/messages') && !u.includes('/consume')
          ? { data: { queue: { id: 'q1', name: 'jobs' } } }
          : u.includes('/messages') && (init.method ?? 'GET') === 'POST'
            ? { data: { message: { id: 'm1' }, duplicate: false } }
            : u.includes('/schedules') && (init.method ?? 'GET') === 'POST'
              ? { data: { schedule: { id: 's1', nextRunAt: null } } }
              : u.includes('/webhooks') && (init.method ?? 'GET') === 'POST'
                ? { data: { webhook: { id: 'w1' }, secret: 'whsec_x' } }
                : u.includes('/metrics')
                  ? { data: { requests: 7, errors: 0, p50Ms: 3, p95Ms: 9 } }
                  : u.includes('/diagnose')
                    ? { data: { diagnosis: { healthy: true } } }
                    : u.includes('/import')
                      ? { data: { inserted: 2, failed: 0, errors: [] } }
                      : { data: {} };
        if (u.includes('/export')) {
          return new Response('id\n1\n', { status: 200, headers: { 'Content-Type': 'text/csv' } });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const client = new CloudNivoClient({ baseUrl: 'http://x:3001', token: 't' });
    await client.createQueue('p', { name: 'jobs' });
    await client.publishMessage('p', 'q1', { n: 1 }, 'k1');
    await client.consumeMessages('p', 'q1');
    await client.ackMessage('p', 'q1', 'm1');
    await client.createSchedule('p', { name: 'n', functionSlug: 'f', cron: '0 * * * *' });
    await client.triggerSchedule('p', 's1');
    await client.createWebhook('p', { name: 'w', url: 'https://example.com/h', eventTypes: ['job.failed'] });
    await client.listDeliveries('p', 'w1');
    const m = await client.projectMetrics('o', 'p');
    expect(m.requests).toBe(7);
    const d = await client.aiDiagnose('p', {});
    expect(d.diagnosis.healthy).toBe(true);
    expect(await client.exportTable('p', 'users')).toContain('id');
    const imp = await client.importTable('p', 'users', 'id\n1\n');
    expect(imp.inserted).toBe(2);
    expect(seen.some(s => s.includes('/queues') && s.startsWith('POST'))).toBe(true);
    expect(seen.some(s => s.includes('/diagnose'))).toBe(true);
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
