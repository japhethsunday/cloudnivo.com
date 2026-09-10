import { CloudNivoClient } from '@cloudnivo/sdk';

/**
 * CloudNivo CLI. Same backend AI Builder service as the dashboard — no
 * second engine. Auth via CLOUDNIVO_TOKEN (session JWT); API via
 * CLOUDNIVO_API_URL (default http://localhost:3001).
 *
 *   cloudnivo ai plan --project <id> --prompt "..."
 *   cloudnivo ai approve --project <id> --plan <planId> [--confirm "DROP TABLE"]
 *   cloudnivo ai apply --project <id> --plan <planId>
 *   cloudnivo ai status --project <id> --plan <planId>
 *   cloudnivo ai usage --project <id>
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

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { command, flags } = parseArgs(argv);
  const out: string[] = [];
  const log = (line: string): void => {
    out.push(line);
  };
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
