/**
 * Customer identity model — application end-users inside ONE CloudNivo project.
 *
 * Critical distinction: a CloudNivo platform user (owns projects) is NOT
 * automatically a customer user (uses an application). Customer users live in
 * per-project auth storage (isolated Postgres `auth` schema, or an isolated
 * memory namespace in dev/test) and can never cross into another project.
 */

export const CUSTOMER_ROLES = ['authenticated', 'admin', 'service_role', 'anonymous'] as const;
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];

export type CustomerStatus = 'active' | 'disabled' | 'deleted';

export interface CustomerUser {
  id: string;
  projectId: string;
  email: string;
  phone: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: CustomerStatus;
  /** Developer/app-writable claims. Never roles/permissions (see metadata.ts). */
  userMetadata: Record<string, unknown>;
  /** Server-only claims (role, flags). Users can never write these. */
  appMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

/** Safe shape — password hashes and token material never leave the service. */
export interface ExposedCustomerUser {
  id: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: CustomerStatus;
  role: CustomerRole;
  userMetadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export function exposeUser(user: CustomerUser): ExposedCustomerUser {
  const role = user.appMetadata['role'] === 'admin' ? 'admin' : ('authenticated' as CustomerRole);
  const { passwordHash: _drop, projectId: _drop2, ...rest } = user;
  void _drop;
  void _drop2;
  return { ...rest, role };
}

export interface CustomerSession {
  id: string;
  userId: string;
  projectId: string;
  refreshTokenHash: string;
  usedRefreshHashes: string[];
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
}

export interface OneTimeToken {
  tokenHash: string;
  userId: string;
  projectId: string;
  kind: 'verify' | 'reset';
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'bearer';
}

export interface CustomerAuthConfig {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  resetTtlSeconds: number;
  verifyTtlSeconds: number;
  emailDriver: 'memory';
  jwtSecret: string;
  issuer: string;
}

export const CUSTOMER_AUDIT_EVENTS = [
  'user.signup',
  'user.login',
  'user.login_failed',
  'user.logout',
  'user.password_changed',
  'user.password_reset_requested',
  'user.password_reset_completed',
  'user.email_verified',
  'user.session_created',
  'user.session_revoked',
  'user.disabled',
  'user.deleted',
] as const;
export type CustomerAuditEvent = (typeof CUSTOMER_AUDIT_EVENTS)[number];
