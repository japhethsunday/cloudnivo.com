/**
 * The line between the dashboard's environment and the API's.
 *
 * The dashboard is a browser client with a thin BFF. It talks to the API over
 * HTTPS and never opens a database, cache or object-store connection itself —
 * there is no Postgres driver in its dependency tree and nothing imports
 * `@cloudnivo/config`. So none of the API's infrastructure variables mean
 * anything here.
 *
 * They are present anyway. A Railway -> Vercel integration syncs the API
 * service's whole environment into the dashboard's Vercel project, so
 * DATABASE_URL, MANAGED_PG_URL, the POSTGRES_* set, the REDIS* set and
 * friends all arrive in the frontend's process. Their values point at
 * `*.railway.internal` hosts, which resolve only inside Railway's private
 * network. Vercel is a different network, so any code that reads one gets a
 * DNS failure naming a hostname that looks nothing like the real cause.
 *
 * Removing them upstream is the platform-side fix and is not ours to make
 * here: the integration re-syncs whatever is deleted. So the boundary is
 * enforced in the process instead. At startup these keys are dropped from
 * `process.env`, which turns a confusing `.internal` DNS error into a plain
 * "not configured" — and means a future import cannot quietly acquire a
 * database handle in the frontend just because a variable happened to exist.
 *
 * This deletes nothing in Vercel or Railway. It scopes one process.
 */

/** Everything the dashboard legitimately reads. Never scrubbed. */
export const DASHBOARD_ENV = [
  'NODE_ENV',
  'VERCEL_ENV',
  'NEXT_PUBLIC_API_URL',
  // The BFF under app/api/v1 verifies sessions minted by the API.
  'JWT_SECRET',
  'CLOUDNIVO_API_URL',
  'CLOUDNIVO_PROJECT_ID',
  'CLOUDNIVO_PUBLIC_KEY',
  'CLOUDNIVO_AGENT_TOKEN',
] as const;

/**
 * API-owned keys. Each names a backing service the dashboard has no client
 * for, so its only possible effect here is a misleading failure.
 */
export const BACKEND_ONLY_ENV = [
  'DATABASE_URL',
  'MANAGED_PG_URL',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'PGDATA',
  'REDIS_URL',
  'REDIS_PASSWORD',
  'REDISHOST',
  'REDISPORT',
  'REDISUSER',
  'REDISPASSWORD',
  'CONTROL_STORE',
  'MIGRATE_ON_BOOT',
  'PROVISION_DRIVER',
  'PROVISION_HOST_MODE',
  'VAULT_KEY',
  'STORAGE_SIGNING_SECRET',
  'BILLING_WEBHOOK_SECRET',
] as const;

/**
 * Hosts reachable only from inside a provider's private network. Matched on
 * the whole value rather than a parsed host: these arrive as connection
 * strings in several shapes, and a value carrying one is unusable here
 * whatever its syntax.
 */
const PRIVATE_HOST = /\.internal\b/i;

export interface ScrubResult {
  /** Names dropped. Names only — a value here is a credential. */
  removed: string[];
  /** Of those, the ones whose value named an unreachable private host. */
  unreachable: string[];
}

/**
 * Drop API-owned variables from `env`. Anything in DASHBOARD_ENV is kept even
 * if it also appears in BACKEND_ONLY_ENV, so this can never remove something
 * the dashboard needs to run.
 */
export function scrubBackendEnv(env: Record<string, string | undefined>): ScrubResult {
  const keep = new Set<string>(DASHBOARD_ENV);
  const removed: string[] = [];
  const unreachable: string[] = [];

  for (const key of BACKEND_ONLY_ENV) {
    if (keep.has(key)) continue;
    const value = env[key];
    if (value === undefined) continue;
    if (PRIVATE_HOST.test(value)) unreachable.push(key);
    delete env[key];
    removed.push(key);
  }

  return { removed: removed.sort(), unreachable: unreachable.sort() };
}

/** True when a value names a host only its own private network can resolve. */
export function namesPrivateHost(value: string): boolean {
  return PRIVATE_HOST.test(value);
}
