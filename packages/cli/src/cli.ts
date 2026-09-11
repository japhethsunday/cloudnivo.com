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
  for (const group of ['queues', 'schedules', 'webhooks', 'metrics'] as const) {
    if (command[0] === group) {
      await runAutomationGroup(group, argv.slice(1), flags, env, log);
      return out.join('\n');
    }
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
  } else if (sub === 'diagnose') {
    const d = await client.aiDiagnose(projectId, {
      ...(typeof flags['ref'] === 'string' ? { ref: flags['ref'] } : {}),
      ...(typeof flags['note'] === 'string' ? { note: flags['note'] } : {}),
    });
    log(d.diagnosis.healthy ? 'healthy: no recent failures' : `cause: ${d.diagnosis.probableCause}`);
    log(`service: ${d.diagnosis.affectedService} confidence: ${d.diagnosis.confidence}`);
    log(`fix: ${d.diagnosis.suggestedFix}`);
    for (const e of d.diagnosis.evidence.slice(0, 5)) log(` [${e.source}] ${e.ref}: ${e.excerpt.slice(0, 120)}`);
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

type AutomationGroup = 'queues' | 'schedules' | 'webhooks' | 'metrics';

function automationHelp(group: AutomationGroup): string[] {
  if (group === 'queues') {
    return [
      'cloudnivo queues create --project <id> --name <name> [--max-deliveries N]',
      'cloudnivo queues list --project <id>',
      'cloudnivo queues publish --project <id> --queue <id|name> --body \'{...}\' [--key <idempotency>]',
      'cloudnivo queues consume --project <id> --queue <id|name> [--limit N]',
      'cloudnivo queues ack --project <id> --queue <id|name> --message <id>',
      'cloudnivo queues purge --project <id> --queue <id|name> [--status dead,acked]',
      'cloudnivo queues delete --project <id> --queue <id|name>',
    ];
  }
  if (group === 'schedules') {
    return [
      'cloudnivo schedules create --project <id> --name <n> --function <slug> --cron "0 * * * *" [--payload \'{...}\']',
      'cloudnivo schedules list --project <id>',
      'cloudnivo schedules trigger --project <id> --schedule <id>',
      'cloudnivo schedules pause --project <id> --schedule <id>',
      'cloudnivo schedules resume --project <id> --schedule <id>',
      'cloudnivo schedules delete --project <id> --schedule <id>',
    ];
  }
  if (group === 'webhooks') {
    return [
      'cloudnivo webhooks create --project <id> --name <n> --url <https://…> --events job.failed,function.deployed',
      'cloudnivo webhooks list --project <id>',
      'cloudnivo webhooks deliveries --project <id> --webhook <id>',
      'cloudnivo webhooks test --project <id> --webhook <id>',
      'cloudnivo webhooks replay --project <id> --webhook <id> --delivery <id>',
      'cloudnivo webhooks rotate --project <id> --webhook <id>',
      'cloudnivo webhooks delete --project <id> --webhook <id>',
    ];
  }
  return ['cloudnivo metrics --org <id> --project <id> [--window 1h|6h|24h|7d]'];
}

function parseJsonFlag(flags: Record<string, string | boolean>, name: string, fallback: string): unknown {
  const raw = flags[name];
  const text = typeof raw === 'string' ? raw : fallback;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
}

async function runAutomationGroup(
  group: AutomationGroup,
  argv: string[],
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<void> {
  const sub = argv[0] ?? 'help';
  if (sub === 'help') {
    for (const line of automationHelp(group)) log(line);
    return;
  }
  const client = clientFromEnv(env);
  if (group === 'metrics') {
    const org = requireFlag(flags, 'org');
    const project = requireFlag(flags, 'project');
    const window = typeof flags['window'] === 'string' ? (flags['window'] as string) : '1h';
    const m = await client.projectMetrics(org, project, window);
    log(`requests=${m.requests} errors=${m.errors} p50=${m.p50Ms}ms p95=${m.p95Ms}ms`);
    return;
  }
  const projectId = requireFlag(flags, 'project');
  if (group === 'queues') {
    if (sub === 'create') {
      const max = flags['max-deliveries'];
      const q = await client.createQueue(projectId, {
        name: requireFlag(flags, 'name'),
        ...(typeof max === 'string' ? { maxDeliveries: Number(max) } : {}),
      });
      log(`queue ${q.queue.id} (${q.queue.name})`);
      return;
    }
    if (sub === 'list') {
      const { queues } = await client.listQueues(projectId);
      if (queues.length === 0) log('(no queues)');
      for (const q of queues) log(`${q.id}  ${q.name}`);
      return;
    }
    let publishBody: Record<string, unknown> | null = null;
    if (sub === 'publish') {
      const parsed = parseJsonFlag(flags, 'body', '{}') as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('--body must be a JSON object');
      }
      publishBody = parsed;
    }
    const queueId = await resolveQueueId(client, projectId, requireFlag(flags, 'queue'));
    if (sub === 'publish') {
      const key = typeof flags['key'] === 'string' ? (flags['key'] as string) : undefined;
      const r = await client.publishMessage(projectId, queueId, publishBody as Record<string, unknown>, key);
      log(r.duplicate ? `duplicate of ${r.message.id}` : `published ${r.message.id}`);
      return;
    }
    if (sub === 'consume') {
      const limit = flags['limit'];
      const { messages } = await client.consumeMessages(projectId, queueId, {
        ...(typeof limit === 'string' ? { limit: Number(limit) } : {}),
      });
      if (messages.length === 0) log('(empty)');
      for (const m of messages) log(`${m.id} [${m.status}] ${JSON.stringify(m.body).slice(0, 200)}`);
      return;
    }
    if (sub === 'ack') {
      await client.ackMessage(projectId, queueId, requireFlag(flags, 'message'));
      log('acked');
      return;
    }
    if (sub === 'purge') {
      const status = typeof flags['status'] === 'string' ? (flags['status'] as string).split(',') : ['acked', 'dead'];
      const r = await client.purgeQueue(projectId, queueId, status);
      log(`purged ${r.purged}`);
      return;
    }
    if (sub === 'delete') {
      await client.deleteQueue(projectId, queueId);
      log('deleted');
      return;
    }
    throw new Error(`Unknown queues subcommand: ${sub}`);
  }
  if (group === 'schedules') {
    if (sub === 'create') {
      const s = await client.createSchedule(projectId, {
        name: requireFlag(flags, 'name'),
        functionSlug: requireFlag(flags, 'function'),
        cron: requireFlag(flags, 'cron'),
        ...(flags['payload'] !== undefined
          ? { payload: parseJsonFlag(flags, 'payload', '{}') as Record<string, unknown> }
          : {}),
      });
      log(`schedule ${s.schedule.id} next ${s.schedule.nextRunAt ?? '—'}`);
      return;
    }
    if (sub === 'list') {
      const { schedules } = await client.listSchedules(projectId);
      if (schedules.length === 0) log('(no schedules)');
      for (const s of schedules) log(`${s.id}  ${s.name}  ${s.cron}`);
      return;
    }
    const scheduleId = requireFlag(flags, 'schedule');
    if (sub === 'trigger') {
      const r = await client.triggerSchedule(projectId, scheduleId);
      log(r.ok ? 'fired' : `FAILED: ${r.error ?? 'unknown'}`);
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      await client.patchSchedule(projectId, scheduleId, { enabled: sub === 'resume' });
      log(sub === 'resume' ? 'resumed' : 'paused');
      return;
    }
    if (sub === 'delete') {
      await client.deleteSchedule(projectId, scheduleId);
      log('deleted');
      return;
    }
    throw new Error(`Unknown schedules subcommand: ${sub}`);
  }
  if (sub === 'create') {
    const w = await client.createWebhook(projectId, {
      name: requireFlag(flags, 'name'),
      url: requireFlag(flags, 'url'),
      eventTypes: requireFlag(flags, 'events').split(','),
    });
    log(`webhook ${w.webhook.id} secret: ${w.secret} (shown once)`);
    return;
  }
  if (sub === 'list') {
    const { webhooks } = await client.listWebhooks(projectId);
    if (webhooks.length === 0) log('(no webhooks)');
    for (const w of webhooks) log(`${w.id}  ${w.name}  ${w.url}`);
    return;
  }
  const webhookId = requireFlag(flags, 'webhook');
  if (sub === 'deliveries') {
    const { deliveries } = await client.listDeliveries(projectId, webhookId);
    if (deliveries.length === 0) log('(no deliveries)');
    for (const d of deliveries) log(`${d.id} [${d.status}]`);
    return;
  }
  if (sub === 'test') {
    const r = await client.testWebhook(projectId, webhookId);
    log(`delivery ${r.delivery.id} [${r.delivery.status}]`);
    return;
  }
  if (sub === 'replay') {
    const r = await client.replayDelivery(projectId, webhookId, requireFlag(flags, 'delivery'));
    log(`replayed as ${r.delivery.id}`);
    return;
  }
  if (sub === 'rotate') {
    const r = await client.rotateWebhook(projectId, webhookId);
    log(`new secret: ${r.secret} (shown once)`);
    return;
  }
  if (sub === 'delete') {
    await client.deleteWebhook(projectId, webhookId);
    log('deleted');
    return;
  }
  throw new Error(`Unknown webhooks subcommand: ${sub}`);
}

async function resolveQueueId(
  client: CloudNivoClient,
  projectId: string,
  ref: string,
): Promise<string> {
  const { queues } = await client.listQueues(projectId);
  const found = queues.find(q => q.id === ref || q.name === ref);
  if (!found) throw new Error(`Queue not found: ${ref}`);
  return found.id;
}
