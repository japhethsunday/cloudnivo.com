import type { Bucket, StorageCaller, StorageOp } from './types.js';

/**
 * Server-side storage authorization. Pure functions — every route decision
 * goes through `authorize()`. Frontend state is never consulted.
 *
 * - Platform owner/admin: everything in their org's projects.
 * - Platform member: read + write objects, manage buckets? No — buckets need
 *   `projects:update`; members read/write objects, list, sign.
 * - Platform viewer: read-only (download/list/metadata of private too).
 * - Service/admin project keys: full object access (service_role equivalent);
 *   public keys: read-only. Keys never manage buckets.
 * - Customer users: owner-prefix (`<userId>/...`) when the bucket enforces
 *   owner isolation (default); admins bypass. Anonymous: public-bucket
 *   download only, exact path (no listing).
 */

export function authorize(
  bucket: Bucket,
  caller: StorageCaller,
  op: StorageOp,
  path: string | null,
): { allowed: boolean; reason?: string } {
  const deny = (reason: string): { allowed: boolean; reason?: string } => ({
    allowed: false,
    reason,
  });

  if (caller.kind === 'anonymous') {
    if (op === 'object:download' && bucket.visibility === 'public' && path)
      return { allowed: true };
    return deny('Anonymous access is limited to public downloads');
  }

  if (caller.kind === 'session') {
    if (caller.role === 'owner' || caller.role === 'admin') return { allowed: true };
    if (op.startsWith('bucket:')) {
      return op === 'bucket:read' ? { allowed: true } : deny('Bucket management requires admin');
    }
    if (caller.role === 'viewer') {
      return op === 'object:download' || op === 'object:list' || op === 'object:sign'
        ? { allowed: true }
        : deny('Viewers cannot mutate storage');
    }
    return { allowed: true };
  }

  if (caller.kind === 'key') {
    if (op.startsWith('bucket:')) return deny('API keys cannot manage buckets');
    if (caller.role === 'public') {
      return op === 'object:download' || op === 'object:list' || op === 'object:sign'
        ? { allowed: true }
        : deny('Read-only key');
    }
    return { allowed: true };
  }

  // Customer users: owner-prefix enforcement (admins bypass).
  if (!bucket.ownerIsolation || caller.role === 'admin') return { allowed: true };
  if (!path) return deny('Customer access requires an object path');
  if (!caller.userId) return deny('No identity');
  const prefix = `${caller.userId}/`;
  if (path === caller.userId || path.startsWith(prefix)) return { allowed: true };
  return deny('Outside your storage folder');
}

/** Owner-prefix for forced scoping (mirrors data-plane ownerFilterFor). */
export function ownerPrefix(userId: string | null): string | null {
  if (!userId) return null;
  return `${userId}/`;
}
