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
});
