import { AGENT_SCOPES, EXPIRY_PRESETS } from './scopes.js';

/**
 * Capability discovery — what CloudNivo supports, described so an agent can
 * plan a whole session from one GET instead of probing for endpoints.
 *
 * This manifest is derived from the scope catalog (the thing the API
 * actually enforces), so it cannot drift into advertising a capability no
 * scope backs. Every route below is served by this API today; the `scopes`
 * on each operation are the ones its handler requires.
 */

export const MANAGEMENT_API_VERSION = 'v1';

export interface CapabilityOperation {
  /** Stable machine name — what an agent keys off, not the prose summary. */
  id: string;
  method: string;
  /** Path template, `:param` style, relative to the API origin. */
  path: string;
  summary: string;
  /** Scopes an agent token must hold. Empty = any authenticated caller. */
  scopes: string[];
  /** True when the operation can destroy data or infrastructure. */
  destructive: boolean;
  /** True when a destructive-gated token gets 428 until a human approves. */
  approvable: boolean;
}

export interface CapabilityService {
  service: string;
  title: string;
  summary: string;
  operations: CapabilityOperation[];
}

const op = (
  id: string,
  method: string,
  path: string,
  summary: string,
  scopes: string[],
  destructive = false,
  approvable = false,
): CapabilityOperation => ({ id, method, path, summary, scopes, destructive, approvable });

const P = '/api/v1/projects/:projectId';

export const CAPABILITY_SERVICES: readonly CapabilityService[] = [
  {
    service: 'discovery',
    title: 'Discovery',
    summary: 'Find out what exists and what this credential may do.',
    operations: [
      op('discovery.capabilities', 'GET', '/api/v1/discovery', 'Capability manifest (no auth)', []),
      op('discovery.whoami', 'GET', '/api/v1/agent/whoami', 'Identify the calling agent token', []),
      op('discovery.projects', 'GET', '/api/v1/projects', 'List reachable projects', ['projects.read']),
      op('discovery.connect', 'GET', `${P}/connect`, 'Connection bundle + env template for one project', ['projects.read']),
    ],
  },
  {
    service: 'projects',
    title: 'Projects',
    summary: 'Create and inspect projects and their infrastructure.',
    operations: [
      op('projects.get', 'GET', `${P}`, 'Project detail with live database state', ['projects.read']),
      op('projects.create', 'POST', '/api/v1/projects', 'Create a project (provisions a database)', ['projects.create']),
      op('projects.jobs', 'GET', `${P}/jobs`, 'Infrastructure job history', ['logs.read']),
      op('projects.actions', 'POST', `${P}/database/actions`, 'Start / stop / restart the database', ['projects.update']),
      op('projects.delete', 'DELETE', `${P}`, 'Delete a project and its infrastructure', ['projects.delete'], true, true),
    ],
  },
  {
    service: 'database',
    title: 'Database',
    summary: 'Inspect schema, run guarded SQL, and move schema forward through migrations.',
    operations: [
      op('database.overview', 'GET', `${P}/database`, 'Database status and health', ['database.read']),
      op('database.connection', 'GET', `${P}/database/connection`, 'Connection metadata (masked for agents)', ['database.read']),
      op('database.schema', 'GET', `${P}/database/schema`, 'Introspect tables, columns, keys', ['database.read']),
      op('database.types', 'GET', `${P}/database/types`, 'Generate TypeScript types from the live schema', ['database.read']),
      op('database.advisors', 'GET', `${P}/database/advisors`, 'Security and performance findings', ['database.read']),
      op('database.diff', 'POST', `${P}/database/diff`, 'Diff two branches into migration statements', ['database.read']),
      op('database.query', 'POST', `${P}/database/query`, 'Run guarded SQL', ['database.sql']),
      op('database.destructive', 'POST', `${P}/database/query`, 'Run DROP / TRUNCATE / ALTER', ['database.destructive'], true, true),
      op('migrations.list', 'GET', `${P}/database/migrations`, 'Recorded migration state', ['database.read']),
      op('migrations.create', 'POST', `${P}/database/migrations`, 'Create a migration (validated, never applied)', ['database.migrate']),
      op('migrations.get', 'GET', `${P}/database/migrations/:migrationId`, 'Migration detail and validation report', ['database.read']),
      op('migrations.preview', 'POST', `${P}/database/migrations/:migrationId/preview`, 'Preview effects without applying', ['database.read']),
      op('migrations.apply', 'POST', `${P}/database/migrations/:migrationId/apply`, 'Apply a migration transactionally', ['database.migrate'], true, true),
      op('migrations.delete', 'DELETE', `${P}/database/migrations/:migrationId`, 'Discard a pending migration', ['database.migrate']),
      op('database.branches', 'GET', `${P}/database/branches`, 'List database branches', ['database.read']),
      op('database.branch.create', 'POST', `${P}/database/branches`, 'Branch the database', ['database.destructive'], true, true),
      op('database.rls.simulate', 'POST', `${P}/database/rls-simulate`, 'Simulate a query under an RLS role', ['database.read']),
    ],
  },
  {
    service: 'data',
    title: 'Data',
    summary: 'Auto-generated REST over the project tables.',
    operations: [
      op('data.read', 'GET', `${P}/tables/:table`, 'Read rows', ['database.read']),
      op('data.write', 'POST', `${P}/tables/:table`, 'Insert rows', ['database.write']),
      op('data.update', 'PATCH', `${P}/tables/:table/:id`, 'Update a row', ['database.write']),
      op('data.delete', 'DELETE', `${P}/tables/:table/:id`, 'Delete a row', ['database.write']),
      op('data.openapi', 'GET', `${P}/openapi.json`, 'OpenAPI document for this project', ['database.read']),
    ],
  },
  {
    service: 'auth',
    title: 'Authentication',
    summary: 'End-user auth for the project the agent is building.',
    operations: [
      op('auth.config.read', 'GET', `${P}/auth/config`, 'Read auth configuration', ['environment.read']),
      op('auth.config.write', 'PATCH', `${P}/auth/config`, 'Update auth configuration', ['environment.write']),
      op('auth.users', 'GET', `${P}/auth/users`, 'List end users', ['database.read']),
    ],
  },
  {
    service: 'storage',
    title: 'Storage',
    summary: 'Buckets, objects, and access policies.',
    operations: [
      op('storage.buckets', 'GET', `${P}/storage/buckets`, 'List buckets', ['storage.read']),
      op('storage.bucket.create', 'POST', `${P}/storage/buckets`, 'Create a bucket', ['storage.write']),
      op('storage.objects', 'GET', `${P}/storage/buckets/:bucket/objects`, 'List objects', ['storage.read']),
      op('storage.upload', 'PUT', `${P}/storage/buckets/:bucket/objects/:key`, 'Upload an object', ['storage.write']),
      op('storage.delete', 'DELETE', `${P}/storage/buckets/:bucket/objects/:key`, 'Delete an object', ['storage.delete'], true, true),
    ],
  },
  {
    service: 'functions',
    title: 'Functions',
    summary: 'Author, deploy, and invoke server-side functions.',
    operations: [
      op('functions.list', 'GET', `${P}/functions`, 'List functions', ['functions.read']),
      op('functions.create', 'POST', `${P}/functions`, 'Create a function', ['functions.update']),
      op('functions.deploy', 'POST', `${P}/functions/:slug/deploy`, 'Deploy a version', ['functions.deploy'], true, true),
      op('functions.invoke', 'POST', `${P}/functions/:slug/invoke`, 'Invoke a function', ['functions.deploy']),
      op('functions.logs', 'GET', `${P}/functions/:slug/logs`, 'Read function logs', ['logs.read']),
      op('functions.env.read', 'GET', `${P}/functions/:slug/env`, 'Read function environment variables (names only)', ['environment.read']),
      op('functions.env.write', 'PUT', `${P}/functions/:slug/env`, 'Set function environment variables', ['environment.write']),
      op('functions.delete', 'DELETE', `${P}/functions/:slug`, 'Delete a function', ['functions.delete'], true, true),
    ],
  },
  {
    service: 'secrets',
    title: 'Secrets',
    summary: 'Encrypted project secrets. Values are write-only — never returned to an agent.',
    operations: [
      op('secrets.list', 'GET', `${P}/database/vault`, 'List secret names and timestamps', ['database.read']),
      op('secrets.put', 'PUT', `${P}/database/vault/:name`, 'Store or rotate a secret value', ['database.destructive']),
      op('secrets.delete', 'DELETE', `${P}/database/vault/:name`, 'Delete a secret', ['database.destructive'], true),
    ],
  },
  {
    service: 'environments',
    title: 'Environments',
    summary: 'development / staging / preview / production, each pinned to a database branch.',
    operations: [
      op('environments.list', 'GET', `${P}/database/environments`, 'List environments', ['database.read']),
      op('environments.create', 'POST', `${P}/database/environments`, 'Create an environment', ['projects.update']),
      op('environments.update', 'PATCH', `${P}/database/environments/:environmentId`, 'Repoint an environment at a branch', ['projects.update']),
      op('environments.delete', 'DELETE', `${P}/database/environments/:environmentId`, 'Delete an environment', ['projects.update'], true),
    ],
  },
  {
    service: 'realtime',
    title: 'Realtime',
    summary: 'Channels, presence, and change streams.',
    operations: [
      op('realtime.channels', 'GET', `${P}/realtime/channels`, 'List channels', ['realtime.read']),
      op('realtime.publish', 'POST', `${P}/realtime/publish`, 'Publish an event', ['realtime.manage']),
    ],
  },
  {
    service: 'automation',
    title: 'Automation',
    summary: 'Queues, cron schedules, and outbound webhooks.',
    operations: [
      op('automation.queues', 'GET', `${P}/queues`, 'List queues', ['automation.read']),
      op('automation.schedules', 'GET', `${P}/schedules`, 'List schedules', ['automation.read']),
      op('automation.webhooks', 'GET', `${P}/webhooks`, 'List webhooks', ['automation.read']),
      op('automation.write', 'POST', `${P}/queues`, 'Create a queue', ['automation.write']),
    ],
  },
  {
    service: 'observability',
    title: 'Logs & metrics',
    summary: 'What happened, and how fast.',
    operations: [
      op('logs.jobs', 'GET', `${P}/jobs`, 'Infrastructure job log', ['logs.read']),
      op('metrics.project', 'GET', '/api/v1/organizations/:organizationId/metrics', 'Request metrics', ['automation.read']),
      op('usage.read', 'GET', '/api/v1/organizations/:organizationId/usage', 'Metered usage', ['usage.read']),
      op('audit.agent', 'GET', '/api/v1/organizations/:organizationId/agent-activity', 'Agent audit trail (human session)', []),
    ],
  },
  {
    service: 'ai',
    title: 'AI builder',
    summary: 'Plan schema changes, approve, then apply.',
    operations: [
      op('ai.plan', 'POST', `${P}/ai/plans`, 'Plan a change (never executes)', ['database.read']),
      op('ai.approve', 'POST', `${P}/ai/plans/:planId/approve`, 'Approve a plan', ['database.migrate']),
      op('ai.apply', 'POST', `${P}/ai/plans/:planId/apply`, 'Apply an approved plan', ['database.migrate'], true, true),
    ],
  },
] as const;

export interface CapabilityManifest {
  product: 'cloudnivo';
  apiVersion: string;
  /** Auth schemes an agent may present, most specific first. */
  auth: { scheme: string; header: string; format: string; use: string }[];
  envTemplate: { name: string; required: boolean; example: string; description: string }[];
  services: readonly CapabilityService[];
  scopes: readonly { scope: string; service: string; description: string; dangerous: boolean }[];
  expiryPresets: readonly { id: string; label: string; days: number | null }[];
  environments: readonly string[];
  errorCodes: readonly { code: string; remediation: string }[];
  conventions: Record<string, string>;
}

/**
 * The manifest served at `GET /api/v1/discovery`.
 *
 * `errorRemediation` is injected by the caller (api-core owns the catalog)
 * so this package keeps no dependency on the HTTP layer.
 */
export function capabilityManifest(input: {
  apiUrl: string;
  errorRemediation: Readonly<Record<string, string>>;
}): CapabilityManifest {
  return {
    product: 'cloudnivo',
    apiVersion: MANAGEMENT_API_VERSION,
    auth: [
      {
        scheme: 'agent-token',
        header: 'Authorization: Bearer cn_agent_…',
        format: 'cn_agent_<random>',
        use: 'Coding agents and CI. Scoped, expiring, revocable, audited.',
      },
      {
        scheme: 'session',
        header: 'Authorization: Bearer <jwt>',
        format: 'JWT',
        use: 'Humans signed into the dashboard. Required for anything an agent may not do.',
      },
      {
        scheme: 'project-key',
        header: 'Authorization: Bearer cn_…',
        format: 'cn_<random>',
        use: 'Application runtime against the data plane only.',
      },
    ],
    envTemplate: [
      { name: 'CLOUDNIVO_URL', required: true, example: input.apiUrl, description: 'API origin for this project.' },
      { name: 'CLOUDNIVO_PROJECT_ID', required: true, example: '00000000-0000-0000-0000-000000000000', description: 'Project the agent is building.' },
      { name: 'CLOUDNIVO_AGENT_TOKEN', required: true, example: 'cn_agent_…', description: 'Scoped agent credential. Never commit it.' },
      { name: 'CLOUDNIVO_ENVIRONMENT', required: false, example: 'development', description: 'Environment the agent is modifying.' },
    ],
    services: CAPABILITY_SERVICES,
    scopes: AGENT_SCOPES.map(s => ({
      scope: s.scope,
      service: s.service,
      description: s.description,
      dangerous: s.dangerous,
    })),
    expiryPresets: EXPIRY_PRESETS.map(p => ({ id: p.id, label: p.label, days: p.days })),
    environments: ['development', 'staging', 'preview', 'production'],
    errorCodes: Object.entries(input.errorRemediation).map(([code, remediation]) => ({
      code,
      remediation,
    })),
    conventions: {
      success: 'HTTP 2xx with { data, meta: { requestId } }.',
      failure:
        'HTTP 4xx/5xx with { error: { code, message, remediation, requestId, details? } }. Branch on code, never on message.',
      requestId: 'Echoed in the X-Request-Id response header and meta.requestId. Quote it in support requests.',
      approval:
        'HTTP 428 APPROVAL_REQUIRED carries data.approval.id. Repeat the identical request with X-Approval-Id once a human approves.',
      rateLimit: 'HTTP 429 RATE_LIMITED with Retry-After in seconds.',
      secrets: 'Secret values are returned exactly once at creation and never again. Agents can never read them back.',
    },
  };
}

/** Flat operation index — handy for a CLI that resolves an id to a route. */
export function capabilityOperations(): CapabilityOperation[] {
  return CAPABILITY_SERVICES.flatMap(s => s.operations);
}
