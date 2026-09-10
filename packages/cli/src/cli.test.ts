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

  it('drives plan/approve/apply through the same backend service', async () => {
    process.env.CLOUDNIVO_TOKEN = 't';
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
