import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { describeError, helpText, readLink, resolveProjectId } from './commands.js';
import { SdkError } from '@cloudnivo/sdk';

/**
 * CLI behaviour that an agent depends on: project resolution order, the
 * connect/migrate loop hitting the real routes, machine-readable failures,
 * and the refusal to take secret values on the command line.
 */

const PROJECT = '11111111-2222-4333-8444-555555555555';

/** Records every request and answers from a route → body table. */
function stubApi(routes: Record<string, unknown>, calls: string[] = []): string[] {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url).split('/api/v1')[1] ?? String(url);
      const key = `${init.method} ${path.split('?')[0]}`;
      calls.push(key);
      const body = routes[key];
      if (body === undefined) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: `no stub for ${key}`,
              remediation: 'add a stub',
              requestId: 'req_test',
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: body, meta: { requestId: 'req_test' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

const CONNECT_BUNDLE = {
  project: { id: PROJECT, slug: 'shop', name: 'Shop', organizationId: 'org', region: 'local' },
  urls: { api: 'https://api.test', project: '', data: '', realtime: '', openapi: '', discovery: '' },
  keys: { publicKeyPrefix: 'cn_pub', secretKeyPrefix: null, note: '', issue: '' },
  database: { host: 'db.test', port: 5432, database: 'shop', user: 'u', password: '••••••••', connectionString: '' },
  agentToken: { issue: 'POST /agent-tokens', verify: '', scopesEndpoint: '', note: '' },
  environments: [{ slug: 'development', name: 'Development', isPreview: false }],
  install: { cli: 'npm install -g @cloudnivo/cli', sdk: 'npm install @cloudnivo/sdk', login: '', link: '' },
  env: {
    lines: [`CLOUDNIVO_PROJECT_ID=${PROJECT}`, 'CLOUDNIVO_AGENT_TOKEN=cn_agent_…'],
    variables: [{ name: 'CLOUDNIVO_AGENT_TOKEN', value: 'cn_agent_…', secret: true, note: '' }],
  },
};

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cn-cli-'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cli help', () => {
  it('documents the whole workflow without any credential', async () => {
    const out = await run([], {});
    for (const cmd of ['link', 'db push', 'db migrations', 'secrets', 'env', 'deploy', 'types']) {
      expect(out).toContain(cmd);
    }
    expect(helpText().join('\n')).toContain('production requires approvals');
  });
});

describe('project resolution', () => {
  it('prefers --project, then the env var, then the link file', async () => {
    const cwd = await workspace();
    const ctx = { env: {}, flags: {}, log: () => {} };
    await expect(resolveProjectId(ctx, cwd)).rejects.toThrow(/cloudnivo link/);

    await mkdir(join(cwd, '.cloudnivo'), { recursive: true });
    await writeFile(
      join(cwd, '.cloudnivo/project.json'),
      JSON.stringify({ projectId: 'from-link', url: '', environment: 'staging', linkedAt: '' }),
    );
    expect(await resolveProjectId(ctx, cwd)).toBe('from-link');
    expect(await resolveProjectId({ ...ctx, env: { CLOUDNIVO_PROJECT_ID: 'from-env' } }, cwd)).toBe('from-env');
    expect(
      await resolveProjectId({ ...ctx, env: { CLOUDNIVO_PROJECT_ID: 'from-env' }, flags: { project: 'from-flag' } }, cwd),
    ).toBe('from-flag');
    await rm(cwd, { recursive: true, force: true });
  });

  it('writes a link file only after the project verifies', async () => {
    const cwd = await workspace();
    stubApi({ [`GET /projects/${PROJECT}/connect`]: CONNECT_BUNDLE });
    const out = await run(['link', '--project', PROJECT, '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
    });
    expect(out).toContain('linked shop');
    expect((await readLink(cwd))?.projectId).toBe(PROJECT);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe('connect', () => {
  it('prints an env template and never a real secret value', async () => {
    const cwd = await workspace();
    stubApi({ [`GET /projects/${PROJECT}/connect`]: CONNECT_BUNDLE });
    const out = await run(['connect', '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
      CLOUDNIVO_PROJECT_ID: PROJECT,
    });
    expect(out).toContain(`CLOUDNIVO_PROJECT_ID=${PROJECT}`);
    expect(out).toContain('CLOUDNIVO_AGENT_TOKEN=cn_agent_…');
    expect(out).toContain('never commit them');
    await rm(cwd, { recursive: true, force: true });
  });
});

describe('db migrations', () => {
  it('push creates then applies through the real routes', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'add_posts.sql'), 'create table posts (id uuid primary key);');
    const calls = stubApi({
      [`POST /projects/${PROJECT}/database/migrations`]: {
        migration: {
          id: 'mig_1',
          version: 1,
          name: 'add_posts',
          statements: ['create table posts (id uuid primary key)'],
          findings: [{ level: 'info', code: 'CLEAN', message: 'fine' }],
        },
        nextStep: 'apply it',
      },
      [`POST /projects/${PROJECT}/database/migrations/mig_1/apply`]: {
        migration: { version: 1, name: 'add_posts', schemaAfter: 'a'.repeat(64) },
        applied: true,
        statements: 1,
        durationMs: 4,
      },
    });
    const out = await run(['db', 'push', '--file', 'add_posts.sql', '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
      CLOUDNIVO_PROJECT_ID: PROJECT,
    });
    expect(out).toContain('created v1 add_posts');
    expect(out).toContain('applied v1 add_posts');
    expect(calls).toEqual([
      `POST /projects/${PROJECT}/database/migrations`,
      `POST /projects/${PROJECT}/database/migrations/mig_1/apply`,
    ]);
    await rm(cwd, { recursive: true, force: true });
  });

  it('--dry-run stops before applying', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'risky.sql'), 'drop table posts;');
    const calls = stubApi({
      [`POST /projects/${PROJECT}/database/migrations`]: {
        migration: {
          id: 'mig_2',
          version: 2,
          name: 'risky',
          statements: ['drop table posts'],
          findings: [{ level: 'destructive', code: 'DROP_TABLE', message: 'drops data' }],
        },
        nextStep: 'approval required',
      },
    });
    const out = await run(['db', 'push', '--file', 'risky.sql', '--dry-run', '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
      CLOUDNIVO_PROJECT_ID: PROJECT,
    });
    expect(out).toContain('[destructive] DROP_TABLE');
    expect(calls.some(c => c.includes('/apply'))).toBe(false);
    await rm(cwd, { recursive: true, force: true });
  });

  it('writes generated types to a file', async () => {
    const cwd = await workspace();
    stubApi({ [`GET /projects/${PROJECT}/database/types`]: { types: 'export interface Posts {}' } });
    await run(['types', '--out', 'gen/db.ts', '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
      CLOUDNIVO_PROJECT_ID: PROJECT,
    });
    expect(await readFile(join(cwd, 'gen/db.ts'), 'utf8')).toContain('export interface Posts');
    await rm(cwd, { recursive: true, force: true });
  });
});

describe('secrets', () => {
  it('refuses a secret value passed as a flag', async () => {
    const cwd = await workspace();
    stubApi({});
    await expect(
      run(['secrets', 'set', '--name', 'STRIPE', '--value', 'sk_live_abc', '--cwd', cwd], {
        CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
        CLOUDNIVO_PROJECT_ID: PROJECT,
      }),
    ).rejects.toThrow(/--from-env/);
    await rm(cwd, { recursive: true, force: true });
  });

  it('reads the value from the named environment variable', async () => {
    const cwd = await workspace();
    stubApi({ [`PUT /projects/${PROJECT}/database/vault/STRIPE`]: { stored: 'STRIPE' } });
    const out = await run(['secrets', 'set', '--name', 'STRIPE', '--from-env', 'MY_SECRET', '--cwd', cwd], {
      CLOUDNIVO_AGENT_TOKEN: 'cn_agent_x',
      CLOUDNIVO_PROJECT_ID: PROJECT,
      MY_SECRET: 'sk_live_abc',
    });
    expect(out).toContain('not readable back');
    expect(out).not.toContain('sk_live_abc');
    await rm(cwd, { recursive: true, force: true });
  });
});

describe('error reporting', () => {
  it('renders code, remediation, approval id and request id', () => {
    const text = describeError(
      new SdkError('APPROVAL_REQUIRED', 'held', 428, {
        remediation: 'ask an owner',
        requestId: 'req_9',
        approvalId: 'apr_1',
      }),
    );
    expect(text).toContain('APPROVAL_REQUIRED (HTTP 428)');
    expect(text).toContain('fix: ask an owner');
    expect(text).toContain('approval: apr_1');
    expect(text).toContain('--approval <id>');
    expect(text).toContain('requestId: req_9');
  });
});
