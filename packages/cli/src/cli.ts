import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CloudNivoClient } from '@cloudnivo/sdk';

/**
 * CloudNivo CLI. Same backend AI Builder service as the dashboard — no
 * second engine. Auth via CLOUDNIVO_TOKEN (session JWT) or CLOUDNIVO_AGENT_TOKEN
 * (`cn_agent_…`); `cloudnivo login` / `cloudnivo agent login` persist them to
 * a 0600 credentials file for interactive use.
 *
 *   cloudnivo login --token <jwt>
 *   cloudnivo agent login --token <cn_agent_…>
 *   cloudnivo agent whoami
 *   cloudnivo agent projects
 *   cloudnivo agent deploy --project <id> --function <slug> --source <file>
 *   cloudnivo ai plan --project <id> --prompt "..."
 *   ...
 */

export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let positional = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      positional = false;
      const eq = arg.indexOf('=');
      if (eq === -1) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i += 1;
        } else {
          flags[arg.slice(2)] = true;
        }
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else if (positional) {
      command.push(arg);
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Missing required --${name}`);
  return v;
}

function clientFromEnv(env: NodeJS.ProcessEnv): CloudNivoClient {
  const baseUrl = env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001';
  const token = env['CLOUDNIVO_TOKEN'] ?? '';
  if (!token)
    throw new Error('Set CLOUDNIVO_TOKEN to a session JWT (login via the dashboard first)');
  return new CloudNivoClient({ baseUrl, token });
}

function credentialsPath(env: NodeJS.ProcessEnv): string {
  if (env['CLOUDNIVO_CREDENTIALS']) return env['CLOUDNIVO_CREDENTIALS'] as string;
  return join(homedir(), '.cloudnivo', 'credentials.json');
}

async function saveCredential(
  env: NodeJS.ProcessEnv,
  kind: 'token' | 'agentToken',
  value: string,
): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    current = {};
  }
  current[kind] = value;
  current['updatedAt'] = new Date().toISOString();
  await writeFile(path, JSON.stringify(current, null, 2), { mode: 0o600 });
}

async function loadCredential(
  env: NodeJS.ProcessEnv,
  kind: 'token' | 'agentToken',
): Promise<string> {
  const direct = kind === 'agentToken' ? env['CLOUDNIVO_AGENT_TOKEN'] : env['CLOUDNIVO_TOKEN'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  try {
    const current = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as Record<string, unknown>;
    const value = current[kind];
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // No stored credential — fall through to the error below.
  }
  throw new Error(
    kind === 'agentToken'
      ? 'No agent credential found (cloudnivo agent login --token <cn_agent_…> or CLOUDNIVO_AGENT_TOKEN)'
      : 'Set CLOUDNIVO_TOKEN to a session JWT (login via the dashboard first)',
  );
}

function agentClientFromEnv(env: NodeJS.ProcessEnv): CloudNivoClient {
  const baseUrl = env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001';
  // Agent tokens first, session JWT as fallback (agents may act as the user).
  const direct =
    env['CLOUDNIVO_AGENT_TOKEN'] ?? env['CLOUDNIVO_TOKEN'] ?? '';
  if (direct) return new CloudNivoClient({ baseUrl, token: direct });
  throw new Error(
    'No agent credential found (cloudnivo agent login --token <cn_agent_…> or CLOUDNIVO_AGENT_TOKEN)',
  );
}

async function agentClientWithStore(env: NodeJS.ProcessEnv): Promise<CloudNivoClient> {
  const baseUrl = env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001';
  try {
    return agentClientFromEnv(env);
  } catch {
    // Fall through to the credentials file.
  }
  const stored =
    (await loadCredential(env, 'agentToken').catch(() => null)) ??
    (await loadCredential(env, 'token').catch(() => null));
  if (!stored) {
    throw new Error(
      'No agent credential found (cloudnivo agent login --token <cn_agent_…> or CLOUDNIVO_AGENT_TOKEN)',
    );
  }
  return new CloudNivoClient({ baseUrl, token: stored });
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { command, flags } = parseArgs(argv);
  const out: string[] = [];
  const log = (line: string): void => {
    out.push(line);
  };
  if (command[0] === 'login') {
    const token = requireFlag(flags, 'token');
    // Verify before persisting: never store a dead credential.
    const probe = new CloudNivoClient({ baseUrl: env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001', token });
    await probe.listProjects();
    await saveCredential(env, 'token', token);
    return 'Logged in — session saved to the local credentials file.';
  }
  if (command[0] === 'agent') {
    return runAgent(argv.slice(1), flags, env, log).then(() => out.join('\n'));
  }
  if (command[0] !== 'ai') {
    throw new Error(
      `Unknown command: ${command.join(' ') || '(none)'}. Try: cloudnivo ai plan --project <id> --prompt "..."`,
    );
  }
  const sub = command[1] ?? 'help';
  const projectId = sub === 'help' ? '' : requireFlag(flags, 'project');
  const client = sub === 'help' ? null : clientFromEnv(env);
  if (!client) {
    return [
      'cloudnivo ai plan --project <id> --prompt "..."',
      'cloudnivo ai approve --project <id> --plan <planId> [--confirm "..."]',
      'cloudnivo ai apply --project <id> --plan <planId>',
      'cloudnivo ai status --project <id> --plan <planId>',
      'cloudnivo ai usage --project <id>',
    ].join('\n');
  }
  if (sub === 'plan') {
    const prompt = requireFlag(flags, 'prompt');
    const plan = await client.aiPlan(projectId, prompt);
    log(`plan ${plan.id} [${plan.status}]`);
    log(plan.summary);
    for (const c of plan.changes.slice(0, 20)) log(` ${c.op} [${c.section}] ${c.text}`);
    if (plan.validation.destructive.length > 0) {
      log(`DESTRUCTIVE: ${plan.validation.destructive.join(', ')} — approve with --confirm`);
    }
  } else if (sub === 'approve') {
    const planId = requireFlag(flags, 'plan');
    const confirm = flags['confirm'];
    const plan = await client.aiApprove(
      projectId,
      planId,
      typeof confirm === 'string' ? [confirm] : [],
    );
    log(`plan ${plan.id} [${plan.status}]`);
  } else if (sub === 'apply') {
    const planId = requireFlag(flags, 'plan');
    const res = await client.aiApply(projectId, planId);
    log(res.ok ? `applied (${res.steps.length} steps)` : `FAILED: ${res.error ?? 'unknown'}`);
    for (const s of res.steps) log(` ${s.ok ? 'ok' : 'FAIL'} ${s.step}: ${s.detail}`);
    if (res.rolledBack) log('rolled back safely');
  } else if (sub === 'status') {
    const planId = requireFlag(flags, 'plan');
    const plan = await client.aiPlanStatus(projectId, planId);
    log(`plan ${plan.id} [${plan.status}]`);
  } else if (sub === 'usage') {
    const usage = await client.aiUsage(projectId);
    log(`requests=${usage.requests} applied=${usage.plansApplied} failed=${usage.plansFailed}`);
  } else {
    throw new Error(`Unknown ai subcommand: ${sub}`);
  }
  return out.join('\n');
}

async function runAgent(
  argv: string[],
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<void> {
  const sub = argv[0] ?? 'help';
  if (sub === 'login') {
    const token = requireFlag(flags, 'token');
    if (!token.startsWith('cn_agent_')) {
      throw new Error('Expected a cn_agent_… token (create one in Account → Agent access)');
    }
    const baseUrl = env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001';
    const probe = new CloudNivoClient({ baseUrl, token });
    const who = await probe.agentWhoami();
    await saveCredential(env, 'agentToken', token);
    log(`agent token saved (${who.token.name}, ${who.scopes.length} scopes)`);
    return;
  }
  if (sub === 'help' || sub === undefined) {
    log('cloudnivo agent login --token <cn_agent_…>');
    log('cloudnivo agent whoami');
    log('cloudnivo agent projects');
    log('cloudnivo agent deploy --project <id> --function <slug> --source <file>');
    return;
  }
  const client = await agentClientWithStore(env);
  if (sub === 'whoami') {
    const who = await client.agentWhoami();
    log(`agent: ${who.token.name} (${who.token.prefix}…)`);
    log(`scopes: ${who.scopes.join(', ') || '(none)'}`);
    log(`organization: ${who.token.organizationId ?? 'account-wide'}`);
    log(
      `projects: ${(who.token.projectIds ?? []).length === 0 ? 'all in scope' : (who.token.projectIds ?? []).join(', ')}`,
    );
    log(`expires: ${who.token.expiresAt ?? 'never'}`);
    return;
  }
  if (sub === 'projects') {
    const { projects } = await client.listProjects();
    if (projects.length === 0) log('(no projects visible to this credential)');
    for (const p of projects) log(`${p.id}  ${p.slug}`);
    return;
  }
  if (sub === 'deploy') {
    const projectId = requireFlag(flags, 'project');
    const slug = requireFlag(flags, 'function');
    const sourcePath = requireFlag(flags, 'source');
    const { readFile: readSource } = await import('node:fs/promises');
    const source = await readSource(sourcePath, 'utf8');
    const { job } = await client.deployFunction(projectId, slug, source);
    log(`deploy started (job ${job.id})`);
    return;
  }
  throw new Error(`Unknown agent subcommand: ${sub}`);
}
