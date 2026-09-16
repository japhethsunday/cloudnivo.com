import { describe, expect, it } from 'vitest';
import { NodeWorkerRuntime } from './runtime.js';

/**
 * Sandbox containment. Before this suite existed, customer function source
 * escaped the vm context through any host object placed in it — for example
 * `Date.constructor('return process')()` — and reached the worker's real
 * `process` (every API environment variable: DATABASE_URL, JWT_SECRET,
 * VAULT_KEY) and `require`. Nothing may hand the host realm back.
 */
describe('function sandbox containment', () => {
  const rt = new NodeWorkerRuntime();

  async function run(body: string, sdk?: Parameters<typeof rt.execute>[0]['sdk']) {
    return rt.execute({
      source: `module.exports.handler = async (req) => { ${body} };`,
      entrypoint: 'handler',
      request: { method: 'POST', path: '/', headers: { 'x-test': '1' }, query: {}, body: { a: 1 } },
      auth: { userId: 'u', email: 'e@example.com', role: 'anon', projectId: 'p1', callerKind: 'public' },
      env: { TENANT_ONLY: 'value' },
      timeoutMs: 5000,
      memoryMb: 64,
      maxResponseBytes: 100_000,
      ...(sdk ? { sdk } : {}),
    });
  }

  it.each([
    ['a host intrinsic', "Date.constructor('return typeof process')()"],
    ['the request object', "req.constructor.constructor('return typeof process')()"],
    ['console', "console.log.constructor('return typeof process')()"],
    ['the env object', "Object.getPrototypeOf(env).constructor.constructor('return typeof process')()"],
    ['an array literal', "[].constructor.constructor('return typeof process')()"],
    ['a timer function', "setTimeout.constructor('return typeof process')()"],
  ])('cannot reach the host process through %s', async (_label, expr) => {
    const out = await run(`
      let v;
      try { v = await (${expr}); } catch { v = 'blocked'; }
      return { status: 200, body: String(v) };
    `);
    expect(['undefined', 'blocked']).toContain(out.body);
  });

  it('cannot reach require', async () => {
    const out = await run(`
      let v;
      try { v = await ([].constructor.constructor('return typeof require')()); } catch { v = 'blocked'; }
      return { status: 200, body: String(v) };
    `);
    expect(['undefined', 'blocked']).toContain(out.body);
  });

  it('leaves no bridge globals reachable from customer code', async () => {
    const out = await run(`
      return { status: 200, body: typeof globalThis.__cnBridge + ',' + typeof globalThis.__cnData };
    `);
    expect(out.body).toBe('undefined,undefined');
  });

  it('still exposes the function own env, console and timers', async () => {
    const out = await run(`
      console.log('hello');
      const slept = await new Promise(r => setTimeout(() => r('timer-ok'), 1));
      return { status: 200, body: Object.keys(env).join(',') + '|' + slept + '|' + typeof cloudnivo.project.id };
    `);
    expect(out.body).toBe('TENANT_ONLY|timer-ok|string');
    expect(out.logs.map(l => l.message)).toContain('hello');
  });

  it('still routes SDK capability calls through the control plane', async () => {
    const seen: string[] = [];
    const out = await run(`
      const rows = await cloudnivo.database.query('select 1', []);
      return { status: 200, body: rows };
    `, {
      databaseQuery: async (sql: string) => {
        seen.push(sql);
        return [{ ok: 1 }];
      },
    });
    expect(seen).toEqual(['select 1']);
    expect(out.body).toEqual([{ ok: 1 }]);
  });

  it('keeps denied capabilities denied', async () => {
    const out = await run(`
      let v;
      try { await cloudnivo.storage.write('b', 'p', 'x'); v = 'allowed'; } catch (e) { v = 'denied'; }
      return { status: 200, body: v };
    `);
    expect(out.body).toBe('denied');
  });
});
