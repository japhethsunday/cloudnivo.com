/**
 * Agent scope catalog — the single source of truth for what an agent token
 * may do. Every scope below is enforced server-side at a real choke point
 * (see the `enforcedBy` note); there are no display-only scopes. Scopes
 * marked `dangerous` are never pre-selected in the UI and should only be
 * granted deliberately, ideally behind the approval gate.
 */

export interface ScopeDefinition {
  scope: string;
  service: string;
  description: string;
  dangerous: boolean;
  /** Where the API enforces it — keeps catalog and code honest. */
  enforcedBy: string;
}

export const AGENT_SCOPES: readonly ScopeDefinition[] = [
  { scope: 'projects.read', service: 'projects', description: 'List and inspect projects, databases, jobs, and metrics', dangerous: false, enforcedBy: 'projects.ts reads, database overview, jobs' },
  { scope: 'projects.create', service: 'projects', description: 'Create projects (provisioning runs automatically)', dangerous: false, enforcedBy: 'POST /api/v1/projects' },
  { scope: 'projects.update', service: 'projects', description: 'Start, stop, and restart project databases', dangerous: false, enforcedBy: 'POST /database/actions' },
  { scope: 'projects.delete', service: 'projects', description: 'Delete projects and their infrastructure', dangerous: true, enforcedBy: 'DELETE /api/v1/projects/:id (+approval)' },
  { scope: 'database.read', service: 'database', description: 'Inspect schema, metrics, masked connection info, OpenAPI', dangerous: false, enforcedBy: 'database reads, data-plane reads' },
  { scope: 'database.write', service: 'database', description: 'Create, update, and delete table rows', dangerous: false, enforcedBy: 'data-plane writes' },
  { scope: 'database.sql', service: 'database', description: 'Run guarded read/write SQL', dangerous: false, enforcedBy: 'POST /database/query' },
  { scope: 'database.migrate', service: 'database', description: 'Apply AI-planned migrations', dangerous: true, enforcedBy: 'POST /ai/plans/:id/apply' },
  { scope: 'database.destructive', service: 'database', description: 'DROP / TRUNCATE / ALTER statements', dangerous: true, enforcedBy: 'POST /database/query (+approval)' },
  { scope: 'functions.read', service: 'functions', description: 'List functions, status, versions, logs', dangerous: false, enforcedBy: 'functions reads' },
  { scope: 'functions.deploy', service: 'functions', description: 'Deploy, redeploy, and invoke functions', dangerous: true, enforcedBy: 'POST deploy/redeploy/invoke (+approval for deploy)' },
  { scope: 'functions.update', service: 'functions', description: 'Edit metadata, environment variables, versions', dangerous: false, enforcedBy: 'PATCH function, env, activate' },
  { scope: 'functions.delete', service: 'functions', description: 'Delete functions', dangerous: true, enforcedBy: 'DELETE function (+approval)' },
  { scope: 'storage.read', service: 'storage', description: 'List buckets/objects, download, usage', dangerous: false, enforcedBy: 'storage reads' },
  { scope: 'storage.write', service: 'storage', description: 'Create buckets, upload, move, copy', dangerous: false, enforcedBy: 'storage writes' },
  { scope: 'storage.delete', service: 'storage', description: 'Delete buckets and objects', dangerous: true, enforcedBy: 'storage deletes (+approval)' },
  { scope: 'realtime.read', service: 'realtime', description: 'Subscribe to channels and presence', dangerous: false, enforcedBy: 'WS upgrade, channel reads' },
  { scope: 'realtime.manage', service: 'realtime', description: 'Publish events and manage channels', dangerous: false, enforcedBy: 'broadcast/publish routes' },
  { scope: 'logs.read', service: 'logs', description: 'Read infrastructure jobs and function logs', dangerous: false, enforcedBy: 'jobs + function logs reads' },
  { scope: 'environment.read', service: 'environment', description: 'Read function env vars and auth config', dangerous: false, enforcedBy: 'env/auth-config reads' },
  { scope: 'environment.write', service: 'environment', description: 'Write function env vars and auth config', dangerous: false, enforcedBy: 'env/auth-config writes' },
  { scope: 'usage.read', service: 'usage', description: 'Read metered usage summaries', dangerous: false, enforcedBy: 'billing usage read' },
  { scope: 'billing.read', service: 'billing', description: 'Read plans, invoices, payments', dangerous: false, enforcedBy: 'billing reads' },
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number]['scope'];

const KNOWN = new Set<string>(AGENT_SCOPES.map(s => s.scope));

/** True for catalogued scopes only — unknown strings never grant anything. */
export function isKnownScope(scope: string): boolean {
  return KNOWN.has(scope);
}

/** Scopes safe to pre-select in creation UIs. */
export function defaultScopes(): string[] {
  return AGENT_SCOPES.filter(s => !s.dangerous).map(s => s.scope);
}

export function dangerousScopes(): string[] {
  return AGENT_SCOPES.filter(s => s.dangerous).map(s => s.scope);
}

/** Expiry presets offered by the UI (days; null = never expires). */
export const EXPIRY_PRESETS = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '365d', label: '1 year', days: 365 },
  { id: 'never', label: 'Never', days: null },
] as const;

export type ExpiryPresetId = (typeof EXPIRY_PRESETS)[number]['id'];

export function expiryPreset(id: string): { days: number | null } | null {
  const found = EXPIRY_PRESETS.find(p => p.id === id);
  return found ? { days: found.days } : null;
}
