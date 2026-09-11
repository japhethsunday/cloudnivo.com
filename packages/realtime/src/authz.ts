import { parseChannel, tableOfTopic } from './types.js';

/**
 * Server-side realtime authorization — pure functions, unit-tested without
 * sockets. Frontend state is never consulted; every decision re-derives from
 * the verified credential + server-side project binding.
 */

export interface AuthContext {
  /** Platform user id, customer user id, or service-key identity. */
  userId: string | null;
  role: string;
  projectId: string;
  organizationId: string;
  /**
   * Credential expiry (ISO timestamp) when known — JWT `exp` or key
   * `expiresAt`. The gateway sweep drops connections past expiry so a
   * revoked/expired session never retains realtime access indefinitely;
   * clients re-authenticate and reconnect.
   */
  expiresAt?: string | null;
}

/** Anonymous callers may only touch explicitly public surface (none by default). */
export function canConnect(ctx: AuthContext | null): ctx is AuthContext {
  return ctx !== null && ctx.projectId.length > 0;
}

export function canSubscribe(ctx: AuthContext, channel: string): boolean {
  let parsed;
  try {
    parsed = parseChannel(channel);
  } catch {
    return false;
  }
  // Structural project binding: the channel's project MUST equal the
  // credential's project. Cross-project subscription is impossible by shape.
  return parsed.projectId === ctx.projectId;
}

export function canBroadcast(ctx: AuthContext, channel: string): boolean {
  if (!canSubscribe(ctx, channel)) return false;
  // Viewers/anonymous may listen, never speak. Public project keys read.
  // Read-only agent tokens (realtime.read without realtime.manage) listen only.
  if (ctx.role === 'viewer' || ctx.role === 'anonymous') return false;
  if (ctx.role === 'public' || ctx.role === 'agent:readonly') return false;
  return true;
}

export function canTrackPresence(ctx: AuthContext, channel: string): boolean {
  if (!canSubscribe(ctx, channel)) return false;
  return ctx.role !== 'anonymous';
}

/**
 * Row-level receive check for database change events (engine-level RLS twin).
 * Mirrors the data-plane owner rule: tables carrying `user_id` deliver to
 * the owning customer only — admins/service see everything. Returns the
 * (possibly redacted) record, or null when delivery is forbidden.
 */
export function canReceive(
  ctx: AuthContext,
  tableColumns: string[],
  row: Record<string, unknown> | null,
  opts?: { ownerColumn?: string },
): boolean {
  // Operators and service credentials see project data (membership verified
  // upstream — same rule as the data plane).
  if (ctx.role !== 'authenticated') return true;
  // Customer users: owner-scoped tables deliver only the owner's rows.
  const ownerColumn = opts?.ownerColumn ?? 'user_id';
  if (!tableColumns.includes(ownerColumn)) return true;
  if (!row || ctx.userId === null) return false;
  return String(row[ownerColumn] ?? '') === ctx.userId;
}

/** Table subscription policy: which tables may be watched at all. */
export function canWatchTable(table: string, allowedTables: readonly string[] | null): boolean {
  if (allowedTables === null) return true;
  return allowedTables.includes(table);
}

/**
 * Equality-filter match for table subscriptions. Pure JS, no SQL: every
 * filter entry must equal the row's value (stringified comparison so integer
 * ids match their string filter form). Null rows never match.
 */
export function matchesFilter(
  row: Record<string, unknown> | null,
  filter: Record<string, string | number | boolean | null> | null | undefined,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (!row || typeof row !== 'object') return false;
  for (const [k, v] of Object.entries(filter)) {
    const actual = row[k];
    if (v === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (String(actual ?? '') !== String(v)) return false;
  }
  return true;
}

export { tableOfTopic };
