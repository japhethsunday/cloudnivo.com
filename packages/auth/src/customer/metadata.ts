/**
 * User-metadata guards — the mass-assignment firewall.
 *
 * `user_metadata` is developer/app-writable. `app_metadata` (roles,
 * permissions, system flags) is server-only: users can never write it, and
 * unknown top-level fields are rejected rather than silently stored.
 */

const USER_EDITABLE_KEYS = new Set([
  'display_name',
  'avatar_url',
  'locale',
  'timezone',
  'preferences',
  'profile',
]);

const PROTECTED_KEYS = new Set([
  'role',
  'roles',
  'permissions',
  'admin',
  'system',
  'flags',
  'plan',
]);

export class MetadataError extends Error {
  readonly code = 'INVALID_METADATA';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'MetadataError';
  }
}

/** Strip/validate a user-supplied metadata patch. Throws on protected keys. */
export function sanitizeUserMetadata(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new MetadataError('user_metadata must be a JSON object');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (PROTECTED_KEYS.has(key)) {
      throw new MetadataError(`Field "${key}" is protected and cannot be set by users`);
    }
    if (!USER_EDITABLE_KEYS.has(key)) {
      throw new MetadataError(`Unknown metadata field: "${key}"`);
    }
    if (value !== null && typeof value === 'object') {
      throw new MetadataError(`Field "${key}" must be a scalar or null`);
    }
    if (typeof value === 'string' && value.length > 2000) {
      throw new MetadataError(`Field "${key}" too large`);
    }
    out[key] = value;
  }
  return out;
}

/** Server-side app_metadata writes (admin paths only). Role is allow-listed. */
export function sanitizeAppMetadata(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new MetadataError('app_metadata must be a JSON object');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === 'role' && value !== 'authenticated' && value !== 'admin') {
      throw new MetadataError('role must be authenticated or admin');
    }
    if (typeof value === 'string' && value.length > 2000) {
      throw new MetadataError(`Field "${key}" too large`);
    }
    out[key] = value;
  }
  return out;
}
