/**
 * Runs once per server start, before any route handler.
 *
 * The dashboard's Vercel project receives the API service's whole environment
 * from a Railway integration, including connection strings whose hosts only
 * resolve inside Railway's private network. lib/env-boundary explains why
 * that is and why the fix lives here rather than upstream.
 */
import { scrubBackendEnv } from './lib/env-boundary';

export function register(): void {
  // The Edge runtime has no database clients to protect and a frozen env.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  const { removed, unreachable } = scrubBackendEnv(process.env);
  if (removed.length === 0) return;

  // Names only. These variables hold credentials; their values never reach a
  // log line.
  console.warn(
    JSON.stringify({
      msg: 'env.backend_vars_scrubbed',
      service: 'dashboard',
      detail: 'API-owned variables were present in the frontend environment and were ignored',
      removed,
      unreachableHosts: unreachable,
    }),
  );
}
