import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CloudNivoClient, SdkError } from '@cloudnivo/sdk';

/**
 * The developer/agent command surface: connect → discover → build → migrate
 * → deploy → verify.
 *
 * Every command here goes through the same public API the dashboard uses.
 * There is no second engine and no privileged back door: a `cn_agent_…`
 * token gets exactly the scopes it was granted, and the CLI surfaces the
 * API's own remediation text rather than inventing its own advice.
 */

export interface CommandContext {
  env: NodeJS.ProcessEnv;
  flags: Record<string, string | boolean>;
  log: (line: string) => void;
}

export const LINK_FILE = '.cloudnivo/project.json';

export function apiUrl(env: NodeJS.ProcessEnv): string {
  return env['CLOUDNIVO_URL'] ?? env['CLOUDNIVO_API_URL'] ?? 'http://localhost:3001';
}

export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function requireFlagValue(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const v = flagString(flags, name);
  if (!v) throw new Error(`Missing required --${name}`);
  return v;
}

/** Non-secret project link, committed or not as the developer prefers. */
export interface ProjectLink {
  projectId: string;
  url: string;
  environment: string;
  linkedAt: string;
}

export async function readLink(cwd: string): Promise<ProjectLink | null> {
  try {
    return JSON.parse(await readFile(join(cwd, LINK_FILE), 'utf8')) as ProjectLink;
  } catch {
    return null;
  }
}

export async function writeLink(cwd: string, link: ProjectLink): Promise<string> {
  const path = join(cwd, LINK_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(link, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Resolve the project an agent is operating on, most explicit first:
 * `--project`, then `CLOUDNIVO_PROJECT_ID`, then the linked project.
 * Never guesses from "the only project you have" — an agent silently
 * targeting the wrong project is the failure worth preventing.
 */
export async function resolveProjectId(ctx: CommandContext, cwd: string): Promise<string> {
  const explicit = flagString(ctx.flags, 'project') ?? ctx.env['CLOUDNIVO_PROJECT_ID'];
  if (explicit) return explicit;
  const link = await readLink(cwd);
  if (link?.projectId) return link.projectId;
  throw new Error(
    'No project selected. Pass --project <id>, set CLOUDNIVO_PROJECT_ID, or run: cloudnivo link --project <id>',
  );
}

export async function resolveEnvironment(ctx: CommandContext, cwd: string): Promise<string> {
  const explicit = flagString(ctx.flags, 'environment') ?? ctx.env['CLOUDNIVO_ENVIRONMENT'];
  if (explicit) return explicit;
  return (await readLink(cwd))?.environment ?? 'development';
}

/** A client with whatever credential is available; token kind does not matter. */
export function clientFor(env: NodeJS.ProcessEnv, token?: string): CloudNivoClient {
  const resolved = token ?? env['CLOUDNIVO_AGENT_TOKEN'] ?? env['CLOUDNIVO_TOKEN'] ?? '';
  return new CloudNivoClient({ baseUrl: apiUrl(env), ...(resolved ? { token: resolved } : {}) });
}

/**
 * Render an API failure the way an agent can act on: the code it branches
 * on, the message, the remediation the API itself supplied, and — for a
 * held destructive operation — the approval id to quote after a human
 * approves.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof SdkError)) return err instanceof Error ? err.message : String(err);
  const lines = [`error: ${err.code} (HTTP ${err.status})`, `  ${err.message}`];
  if (err.remediation) lines.push(`  fix: ${err.remediation}`);
  if (err.approvalId) {
    lines.push(`  approval: ${err.approvalId}`);
    lines.push('  next: once an owner approves, repeat the command with --approval <id>');
  }
  if (err.requestId) lines.push(`  requestId: ${err.requestId}`);
  return lines.join('\n');
}

// ── Commands ───────────────────────────────────────────────

export async function cmdWhoami(ctx: CommandContext): Promise<void> {
  const client = clientFor(ctx.env);
  const token = ctx.env['CLOUDNIVO_AGENT_TOKEN'] ?? '';
  if (token.startsWith('cn_agent_')) {
    const who = await client.agentWhoami();
    ctx.log(`agent: ${who.token.name} (${who.token.prefix}…)`);
    ctx.log(`organization: ${who.token.organizationId ?? 'account-wide'}`);
    ctx.log(
      `projects: ${who.token.projectIds.length === 0 ? 'all in organization scope' : who.token.projectIds.join(', ')}`,
    );
    ctx.log(`scopes: ${who.scopes.join(', ') || '(none)'}`);
    ctx.log(`expires: ${who.token.expiresAt ?? 'never'}`);
    ctx.log(`approval required: ${who.token.approvalRequired ? 'yes' : 'no'}`);
    return;
  }
  const { projects } = await client.listProjects();
  ctx.log(`session credential — ${projects.length} project(s) reachable`);
}

export async function cmdProjects(ctx: CommandContext): Promise<void> {
  const { projects } = await clientFor(ctx.env).listProjects();
  if (projects.length === 0) {
    ctx.log('(no projects visible to this credential)');
    return;
  }
  for (const p of projects) ctx.log(`${p.id}  ${p.slug}`);
}

export async function cmdLink(ctx: CommandContext, cwd: string): Promise<void> {
  const projectId = requireFlagValue(ctx.flags, 'project');
  const environment = flagString(ctx.flags, 'environment') ?? 'development';
  // Verify before writing: a link file pointing at a project this credential
  // cannot reach is worse than no link file.
  const bundle = await clientFor(ctx.env).connect(projectId, { environment });
  const path = await writeLink(cwd, {
    projectId,
    url: apiUrl(ctx.env),
    environment,
    linkedAt: new Date().toISOString(),
  });
  ctx.log(`linked ${bundle.project.slug} (${projectId}) → ${path}`);
  ctx.log(`environment: ${environment}`);
}

export async function cmdStatus(ctx: CommandContext, cwd: string): Promise<void> {
  const projectId = await resolveProjectId(ctx, cwd);
  const client = clientFor(ctx.env);
  const bundle = await client.connect(projectId, { environment: await resolveEnvironment(ctx, cwd) });
  ctx.log(`project: ${bundle.project.name} (${bundle.project.slug})`);
  ctx.log(`id: ${bundle.project.id}`);
  ctx.log(`api: ${bundle.urls.api}`);
  ctx.log(
    `database: ${bundle.database.host ? `${bundle.database.host}:${bundle.database.port}/${bundle.database.database}` : 'not provisioned'}`,
  );
  ctx.log(
    `environments: ${bundle.environments.map(e => e.slug).join(', ') || 'development (default)'}`,
  );
  const { state } = await client.listMigrations(projectId).catch(() => ({
    state: { appliedVersion: 0, pending: 0, failed: 0 },
  }));
  ctx.log(
    `migrations: applied through v${state.appliedVersion}, ${state.pending} pending, ${state.failed} failed`,
  );
}

export async function cmdConnect(ctx: CommandContext, cwd: string): Promise<void> {
  const projectId = await resolveProjectId(ctx, cwd);
  const environment = await resolveEnvironment(ctx, cwd);
  const bundle = await clientFor(ctx.env).connect(projectId, { environment });
  if (ctx.flags['json'] === true) {
    ctx.log(JSON.stringify(bundle, null, 2));
    return;
  }
  ctx.log('# CloudNivo environment — fill the secret values from the dashboard, never commit them');
  for (const line of bundle.env.lines) ctx.log(line);
  ctx.log('');
  ctx.log(`# install: ${bundle.install.cli} && ${bundle.install.sdk}`);
  ctx.log(`# agent token: ${bundle.agentToken.issue}`);
}

export async function cmdDiscover(ctx: CommandContext): Promise<void> {
  const manifest = await clientFor(ctx.env).discover();
  if (ctx.flags['json'] === true) {
    ctx.log(JSON.stringify(manifest, null, 2));
    return;
  }
  ctx.log(`cloudnivo ${manifest.apiVersion} — ${manifest.services.length} services`);
  const service = flagString(ctx.flags, 'service');
  for (const s of manifest.services) {
    if (service && s.service !== service) continue;
    ctx.log(`\n${s.service}: ${s.summary}`);
    for (const o of s.operations) {
      const marks = [o.destructive ? 'destructive' : '', o.approvable ? 'approvable' : '']
        .filter(Boolean)
        .join(',');
      ctx.log(
        `  ${o.method.padEnd(6)} ${o.path}  [${o.scopes.join(' ') || 'any'}]${marks ? ` (${marks})` : ''}`,
      );
    }
  }
}

export async function cmdTypes(ctx: CommandContext, cwd: string): Promise<void> {
  const projectId = await resolveProjectId(ctx, cwd);
  const { types } = await clientFor(ctx.env).generateTypes(projectId, ctx.flags['schema-prefix'] === true);
  const out = flagString(ctx.flags, 'out');
  if (out) {
    await mkdir(dirname(join(cwd, out)), { recursive: true });
    await writeFile(join(cwd, out), types, 'utf8');
    ctx.log(`types written to ${out}`);
    return;
  }
  ctx.log(types);
}

export async function cmdDb(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'status';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);

  if (sub === 'status' || sub === 'schema') {
    const { schema } = await client.schema(projectId);
    const tables = (schema.tables ?? []) as { schema: string; name: string; columns: unknown[] }[];
    ctx.log(`${tables.length} table(s)`);
    for (const t of tables) ctx.log(`  ${t.schema}.${t.name} (${t.columns.length} columns)`);
    return;
  }
  if (sub === 'query') {
    const result = await client.runSql(projectId, requireFlagValue(ctx.flags, 'sql'));
    ctx.log(`${result.rowCount} row(s)`);
    for (const row of result.rows.slice(0, 50)) ctx.log(JSON.stringify(row));
    return;
  }
  if (sub === 'advisors') {
    const { findings } = await client.advisors(projectId);
    if (findings.length === 0) ctx.log('no findings');
    for (const f of findings) ctx.log(`[${f.level}] ${f.title}`);
    return;
  }
  if (sub === 'diff') {
    const { statements } = await client.schemaDiff(projectId, {
      base: flagString(ctx.flags, 'base') ?? 'main',
      compare: flagString(ctx.flags, 'compare') ?? 'main',
      includeDrops: ctx.flags['include-drops'] === true,
    });
    if (statements.length === 0) ctx.log('no differences');
    for (const s of statements) ctx.log(s);
    return;
  }
  if (sub === 'pull') {
    // Write the live schema locally so an agent can diff it against the code
    // it is generating, which is what "pull" means to every other tool.
    const { types } = await client.generateTypes(projectId);
    const out = flagString(ctx.flags, 'out') ?? 'cloudnivo/schema.ts';
    await mkdir(dirname(join(cwd, out)), { recursive: true });
    await writeFile(join(cwd, out), types, 'utf8');
    ctx.log(`live schema written to ${out}`);
    return;
  }
  if (sub === 'migrations') {
    const { migrations, state } = await client.listMigrations(projectId);
    ctx.log(
      `applied through v${state.appliedVersion} — ${state.pending} pending, ${state.failed} failed`,
    );
    for (const m of migrations) {
      const flag = m.destructive ? ' DESTRUCTIVE' : '';
      ctx.log(`v${m.version} ${m.name} [${m.status}] ${m.environment}${flag}  ${m.id}`);
    }
    return;
  }
  if (sub === 'push') {
    await dbPush(ctx, cwd, client, projectId);
    return;
  }
  if (sub === 'apply') {
    const migrationId = requireFlagValue(ctx.flags, 'migration');
    await applyMigration(ctx, client, projectId, migrationId);
    return;
  }
  if (sub === 'preview') {
    const migrationId = requireFlagValue(ctx.flags, 'migration');
    const { preview } = await client.previewMigration(projectId, migrationId);
    ctx.log(`${preview.statements.length} statement(s), destructive=${preview.destructive}`);
    for (const f of preview.findings) ctx.log(`  [${f.level}] ${f.code}: ${f.message}`);
    if (preview.approvalRequired) ctx.log('  approval required before this can be applied');
    return;
  }
  throw new Error(`Unknown db subcommand: ${sub}. Try: cloudnivo db migrations`);
}

/**
 * `db push`: create a migration from local SQL, show what it will do, then
 * apply it. Destructive work still stops at the approval gate — push is a
 * convenience over the same three calls, never a way around them.
 */
async function dbPush(
  ctx: CommandContext,
  cwd: string,
  client: CloudNivoClient,
  projectId: string,
): Promise<void> {
  const file = requireFlagValue(ctx.flags, 'file');
  const name = flagString(ctx.flags, 'name') ?? baseName(file);
  const sql = await readFile(join(cwd, file), 'utf8');
  const environment = await resolveEnvironment(ctx, cwd);
  const { migration, nextStep } = await client.createMigration(projectId, {
    name,
    sql,
    environment,
    target: flagString(ctx.flags, 'target') ?? 'main',
  });
  ctx.log(`created v${migration.version} ${migration.name} (${migration.statements.length} statements)`);
  for (const f of migration.findings) ctx.log(`  [${f.level}] ${f.code}: ${f.message}`);
  if (ctx.flags['dry-run'] === true) {
    ctx.log(nextStep);
    return;
  }
  await applyMigration(ctx, client, projectId, migration.id);
}

async function applyMigration(
  ctx: CommandContext,
  client: CloudNivoClient,
  projectId: string,
  migrationId: string,
): Promise<void> {
  const approvalId = flagString(ctx.flags, 'approval');
  const result = await client.applyMigration(projectId, migrationId, {
    ...(approvalId ? { approvalId } : {}),
  });
  ctx.log(
    `applied v${result.migration.version} ${result.migration.name} — ${result.statements} statement(s) in ${result.durationMs}ms`,
  );
  if (result.migration.schemaAfter) {
    ctx.log(`schema fingerprint: ${result.migration.schemaAfter.slice(0, 16)}…`);
  }
}

function baseName(file: string): string {
  const raw = file.split('/').pop() ?? file;
  return raw.replace(/\.sql$/i, '').replace(/[^a-z0-9_-]/gi, '_').toLowerCase().slice(0, 120);
}

export async function cmdSecrets(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'list';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  if (sub === 'list') {
    const { secrets } = await client.listSecrets(projectId);
    if (secrets.length === 0) ctx.log('(no secrets)');
    // Names and timestamps only — values are write-only by design.
    for (const s of secrets) ctx.log(`${s.name}  updated ${s.updatedAt}`);
    return;
  }
  if (sub === 'set') {
    const name = requireFlagValue(ctx.flags, 'name');
    // The value comes from an env var, never a flag: a flag lands in shell
    // history and in the process table where any local user can read it.
    const fromEnv = flagString(ctx.flags, 'from-env');
    const value = fromEnv ? ctx.env[fromEnv] : undefined;
    if (!value) {
      throw new Error(
        'Pass --from-env <ENV_VAR> holding the secret value. Values are never accepted as command-line flags (shell history and the process table are readable).',
      );
    }
    await client.setSecret(projectId, name, value);
    ctx.log(`secret ${name} stored (value is not readable back)`);
    return;
  }
  if (sub === 'rotate') {
    const name = requireFlagValue(ctx.flags, 'name');
    const fromEnv = requireFlagValue(ctx.flags, 'from-env');
    const value = ctx.env[fromEnv];
    if (!value) throw new Error(`Environment variable ${fromEnv} is empty`);
    await client.setSecret(projectId, name, value);
    ctx.log(`secret ${name} rotated`);
    return;
  }
  if (sub === 'delete') {
    await client.deleteSecret(projectId, requireFlagValue(ctx.flags, 'name'));
    ctx.log('deleted');
    return;
  }
  throw new Error(`Unknown secrets subcommand: ${sub}`);
}

export async function cmdEnv(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'list';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  if (sub === 'template') {
    await cmdConnect(ctx, cwd);
    return;
  }
  if (sub === 'list') {
    const { environments } = await client.listEnvironments(projectId);
    const active = await resolveEnvironment(ctx, cwd);
    if (environments.length === 0) ctx.log('development (default, no explicit environments)');
    for (const e of environments) {
      ctx.log(`${e.slug === active ? '*' : ' '} ${e.slug}  ${e.name}${e.isPreview ? '  (preview)' : ''}`);
    }
    return;
  }
  if (sub === 'create') {
    const { environment } = await client.createEnvironment(projectId, {
      name: requireFlagValue(ctx.flags, 'name'),
      slug: requireFlagValue(ctx.flags, 'slug'),
      preview: ctx.flags['preview'] === true,
    });
    ctx.log(`environment ${environment.slug} created`);
    return;
  }
  if (sub === 'use') {
    const slug = requireFlagValue(ctx.flags, 'slug');
    const link = (await readLink(cwd)) ?? {
      projectId,
      url: apiUrl(ctx.env),
      environment: slug,
      linkedAt: new Date().toISOString(),
    };
    await writeLink(cwd, { ...link, environment: slug });
    ctx.log(`environment set to ${slug}`);
    return;
  }
  if (sub === 'delete') {
    await client.deleteEnvironment(projectId, requireFlagValue(ctx.flags, 'environment-id'));
    ctx.log('deleted');
    return;
  }
  throw new Error(`Unknown env subcommand: ${sub}`);
}

export async function cmdAuth(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'config';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  if (sub === 'config') {
    ctx.log(JSON.stringify(await client.authConfig(projectId), null, 2));
    return;
  }
  if (sub === 'set') {
    const patch = JSON.parse(requireFlagValue(ctx.flags, 'config')) as Record<string, unknown>;
    ctx.log(JSON.stringify(await client.updateAuthConfig(projectId, patch), null, 2));
    return;
  }
  throw new Error(`Unknown auth subcommand: ${sub}`);
}

export async function cmdStorage(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'list';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  if (sub === 'list') {
    const { buckets } = await client.listBuckets(projectId);
    if (buckets.length === 0) ctx.log('(no buckets)');
    for (const b of buckets) ctx.log(b.name);
    return;
  }
  if (sub === 'create') {
    const { bucket } = await client.createBucket(projectId, {
      name: requireFlagValue(ctx.flags, 'name'),
      public: ctx.flags['public'] === true,
    });
    ctx.log(`bucket ${bucket.name} created`);
    return;
  }
  throw new Error(`Unknown storage subcommand: ${sub}`);
}

export async function cmdFunctions(ctx: CommandContext, argv: string[], cwd: string): Promise<void> {
  const sub = argv[0] ?? 'list';
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  if (sub === 'list') {
    const { functions } = await client.listFunctions(projectId);
    if (functions.length === 0) ctx.log('(no functions)');
    for (const f of functions) ctx.log(`${f.slug}  [${f.status}]`);
    return;
  }
  if (sub === 'deploy') {
    const slug = requireFlagValue(ctx.flags, 'function');
    const source = await readFile(join(cwd, requireFlagValue(ctx.flags, 'source')), 'utf8');
    const { job } = await client.deployFunction(projectId, slug, source);
    ctx.log(`deploy started (job ${job.id})`);
    return;
  }
  if (sub === 'invoke') {
    const slug = requireFlagValue(ctx.flags, 'function');
    const payload = flagString(ctx.flags, 'payload');
    const result = await client.invokeFunction(
      projectId,
      slug,
      payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
    );
    ctx.log(JSON.stringify(result, null, 2));
    return;
  }
  if (sub === 'logs') {
    const { logs } = await client.functionLogs(projectId, requireFlagValue(ctx.flags, 'function'));
    if (logs.length === 0) ctx.log('(no logs)');
    for (const l of logs) ctx.log(`${l.at} ${l.line}`);
    return;
  }
  throw new Error(`Unknown functions subcommand: ${sub}`);
}

export async function cmdLogs(ctx: CommandContext, cwd: string): Promise<void> {
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  const fn = flagString(ctx.flags, 'function');
  if (fn) {
    const { logs } = await client.functionLogs(projectId, fn);
    if (logs.length === 0) ctx.log('(no logs)');
    for (const l of logs) ctx.log(`${l.at} ${l.line}`);
    return;
  }
  const { jobs } = await client.listJobs(projectId);
  if (jobs.length === 0) ctx.log('(no infrastructure jobs)');
  for (const j of jobs) ctx.log(`${j.id}  ${j.kind}  [${j.status}]`);
}

/**
 * `deploy`: push every pending migration, then deploy the named function.
 * The order is deliberate — code that expects a column must not reach
 * production before the column does.
 */
export async function cmdDeploy(ctx: CommandContext, cwd: string): Promise<void> {
  const client = clientFor(ctx.env);
  const projectId = await resolveProjectId(ctx, cwd);
  const { migrations } = await client.listMigrations(projectId);
  const pending = migrations.filter(m => m.status === 'pending');
  for (const m of pending) {
    ctx.log(`applying v${m.version} ${m.name}…`);
    await applyMigration(ctx, client, projectId, m.id);
  }
  if (pending.length === 0) ctx.log('no pending migrations');
  const fn = flagString(ctx.flags, 'function');
  if (!fn) {
    ctx.log('done (pass --function <slug> --source <file> to deploy a function too)');
    return;
  }
  const source = await readFile(join(cwd, requireFlagValue(ctx.flags, 'source')), 'utf8');
  const { job } = await client.deployFunction(projectId, fn, source);
  ctx.log(`deploy started (job ${job.id})`);
}

export function helpText(): string[] {
  return [
    'cloudnivo — connect → discover → build → migrate → deploy → verify',
    '',
    'Connect',
    '  cloudnivo login --token <jwt> | --agent-token <cn_agent_…>',
    '  cloudnivo whoami                       identity and granted scopes',
    '  cloudnivo projects                     projects this credential can reach',
    '  cloudnivo link --project <id> [--environment development]',
    '  cloudnivo connect [--json]             env template for this project',
    '  cloudnivo status                       project, database, migration state',
    '',
    'Discover',
    '  cloudnivo discover [--service database] [--json]',
    '',
    'Database',
    '  cloudnivo db schema | advisors | query --sql "…" | pull [--out file]',
    '  cloudnivo db diff [--base main] [--compare <branch>] [--include-drops]',
    '  cloudnivo db migrations                recorded migration state',
    '  cloudnivo db push --file migration.sql [--name n] [--dry-run]',
    '  cloudnivo db preview --migration <id>',
    '  cloudnivo db apply --migration <id> [--approval <id>]',
    '  cloudnivo types [--out types.ts]',
    '',
    'Build',
    '  cloudnivo auth config | set --config \'{...}\'',
    '  cloudnivo storage list | create --name <bucket> [--public]',
    '  cloudnivo functions list | deploy --function <slug> --source <file>',
    '  cloudnivo functions invoke --function <slug> [--payload \'{...}\']',
    '  cloudnivo secrets list | set --name N --from-env VAR | rotate | delete --name N',
    '  cloudnivo env list | use --slug <env> | create --name N --slug S [--preview]',
    '',
    'Ship',
    '  cloudnivo deploy [--function <slug> --source <file>]',
    '  cloudnivo logs [--function <slug>]',
    '',
    'Automation: cloudnivo queues|schedules|webhooks|metrics help',
    'AI builder: cloudnivo ai plan|approve|apply|status|usage',
    '',
    'Environment: CLOUDNIVO_URL, CLOUDNIVO_PROJECT_ID, CLOUDNIVO_AGENT_TOKEN,',
    '             CLOUDNIVO_ENVIRONMENT (production requires approvals).',
  ];
}
