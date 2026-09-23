/**
 * Customer identity model — application end-users inside ONE CloudNivo project.
 *
 * Critical distinction: a CloudNivo platform user (owns projects) is NOT
 * automatically a customer user (uses an application). Customer users live in
 * per-project auth storage (isolated Postgres `auth` schema, or an isolated
 * memory namespace in dev/test) and can never cross into another project.
 */

import type { PasswordPolicy } from '../password-policy.js';

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
  /** Passwordless/anonymous accounts carry no password until converted. */
  isAnonymous: boolean;
  /** TOTP secret — server-side only, NEVER exposed (see exposeUser). */
  totpSecret: string | null;
  totpEnabled: boolean;
  /** sha256 of single-use MFA recovery codes — never raw codes. */
  backupCodeHashes: string[];
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
  isAnonymous: boolean;
  totpEnabled: boolean;
  userMetadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export function exposeUser(user: CustomerUser): ExposedCustomerUser {
  const role =
    user.appMetadata['role'] === 'admin'
      ? 'admin'
      : user.isAnonymous
        ? 'anonymous'
        : ('authenticated' as CustomerRole);
  const {
    passwordHash: _drop,
    projectId: _drop2,
    totpSecret: _drop3,
    backupCodeHashes: _drop4,
    ...rest
  } = user;
  void _drop;
  void _drop2;
  void _drop3;
  void _drop4;
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
  kind: 'verify' | 'reset' | 'magic' | 'mfa';
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
  /** Null = legacy length-only check (back-compat); set to enforce a policy. */
  passwordPolicy?: PasswordPolicy | null;
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
  'user.anonymous_created',
  'user.converted',
  'user.otp_requested',
  'user.otp_verified',
  'user.magic_requested',
  'user.magic_consumed',
  'user.mfa_enrolled',
  'user.mfa_disabled',
  'user.mfa_challenged',
  'user.mfa_verified',
  'user.passkey_registered',
  'user.passkey_authenticated',
  'user.passkey_removed',
  'user.passkey_clone_suspected',
  'user.phone_verified',
] as const;
export type CustomerAuditEvent = (typeof CUSTOMER_AUDIT_EVENTS)[number];

/** A registered passkey. `publicKey` is SPKI DER, base64. */
export interface PasskeyCredential {
  projectId: string;
  credentialId: string;
  userId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  aaguid: string | null;
  fmt: string;
  label: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * A pending WebAuthn challenge. Held server-side and single-use: that is what
 * makes an assertion unreplayable, so it must never round-trip through the
 * client as its own proof.
 */
export interface PasskeyChallenge {
  projectId: string;
  challenge: string;
  userId: string | null;
  kind: 'register' | 'authenticate';
  expiresAt: string;
}

/** What the client may see: never the public key or the credential id. */
export function toPublicPasskey(cred: PasskeyCredential): {
  id: string;
  label: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
} {
  return {
    // A short stable handle, not the credential id itself.
    id: cred.credentialId.slice(0, 16),
    label: cred.label,
    backedUp: cred.backedUp,
    createdAt: cred.createdAt,
    lastUsedAt: cred.lastUsedAt,
  };
}
