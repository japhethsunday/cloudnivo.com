import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  checkRateLimit,
  isUniqueViolation,
  ok,
  parseBody,
  toPublicError,
} from '@cloudnivo/api-core';
import {
  bearerFromHeader,
  buildAuthorizeUrl,
  checkPasswordPolicy,
  discoverOidc,
  exchangeOidcCode,
  generateBackupCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  newOpaqueToken,
  PLATFORM_BASELINE_PASSWORD_POLICY,
  mergePasswordPolicy,
  pkcePair,
  revokeSession,
  signSession,
  ssoIssuerFor,
  SSO_PRESETS,
  totpProvisionUri,
  verifyCaptcha,
  verifyOidcIdToken,
  verifyPassword,
  verifySession,
  verifyTotp,
  type PasswordPolicy,
} from '@cloudnivo/auth';
import {
  organizationInvites,
  organizationPolicies,
  platformPasswordResets,
  ssoConnections,
  users,
  type Database,
} from '@cloudnivo/database';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendPlatformPasswordReset, sendSignupWelcome } from './platform-mail.js';
import { applyStaffAllowlist } from './admin.js';
import { sendJson } from './projects.js';
import { readCheckedJson } from './body.js';
import { verifyPlatformSession } from './sessions.js';
import { clientIpOf, rateLimitIp } from './client-ip.js';

/**
 * Platform control-plane auth: developer signup/login, session identity
 * (`GET /me`), and org invites. Customer (per-project application-user) auth
 * lives in customer-auth.ts against project databases; THIS module is the
 * CloudNivo developer account plane backed by the control `users` table
 * (drizzle) or an in-memory store (dev/test default).
 *
 * Passwords are scrypt-hashed (per-user salt); sessions are short-lived
 * signed JWTs delivered as JSON AND an httpOnly `cn_session` cookie.
 * Invite tokens are opaque random values — only sha256 is stored, the raw
 * token is shown once at creation (same pattern as API keys).
 */

export interface PlatformUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  totpEnabled: boolean;
  /** Platform staff (see users.isPlatformAdmin). Drives the operator console. */
  isPlatformAdmin: boolean;
  /** ISO timestamp when an operator suspended the account, else null. */
  suspendedAt: string | null;
}

interface StoredPlatformUser extends PlatformUser {
  passwordHash: string;
  /** Operator note recorded with a suspension. Never exposed to the user. */
  suspendedReason?: string | null;
  /** TOTP secret — server-side only, never exposed (see expose). */
  totpSecret: string | null;
  totpEnabled: boolean;
  backupCodeHashes: string[];
}

export interface PlatformUserStore {
  createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser>;
  findByEmail(email: string): Promise<StoredPlatformUser | null>;
  findById(id: string): Promise<StoredPlatformUser | null>;
  /** Update display name, password hash, and/or MFA material. Returns null when unknown. */
  updateUser(
    id: string,
    patch: {
      displayName?: string | null;
      passwordHash?: string;
      totpSecret?: string | null;
      totpEnabled?: boolean;
      backupCodeHashes?: string[];
      email?: string;
    },
  ): Promise<StoredPlatformUser | null>;
  /**
   * Cross-tenant enumeration for the operator console. Bounded by `limit`,
   * newest first. Only ever reached through the staff gate in admin.ts.
   */
  listAll(limit: number): Promise<StoredPlatformUser[]>;
  /** Total user count (cheap on durable stores; used by the operator KPIs). */
  countAll(): Promise<number>;
  /**
   * Suspend or restore an account. Operator action — the caller is
   * responsible for the staff gate and the audit record. Returns null when
   * the user is unknown.
   */
  setSuspended(id: string, suspended: boolean, reason: string | null): Promise<StoredPlatformUser | null>;
  /**
   * Bootstrap grant from PLATFORM_ADMIN_EMAILS. Grants only — never demotes —
   * and returns true when this call changed the row.
   */
  grantPlatformAdmin(email: string): Promise<boolean>;
}

export class MemoryPlatformUsers implements PlatformUserStore {
  private readonly users = new Map<string, StoredPlatformUser>();

  async createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser> {
    const email = input.email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email === email) {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
    }
    const { randomUUID } = await import('node:crypto');
    const user: StoredPlatformUser = {
      id: randomUUID(),
      email,
      displayName: input.displayName,
      createdAt: new Date().toISOString(),
      passwordHash: input.passwordHash,
      totpSecret: null,
      totpEnabled: false,
      backupCodeHashes: [],
      isPlatformAdmin: false,
      suspendedAt: null,
    };
    this.users.set(user.id, user);
    return stripSecrets(user);
  }

  async findByEmail(email: string): Promise<StoredPlatformUser | null> {
    const want = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email === want) return stripSecrets(u);
    }
    return null;
  }

  async findById(id: string): Promise<StoredPlatformUser | null> {
    const u = this.users.get(id);
    return u ? stripSecrets(u) : null;
  }

  async updateUser(
    id: string,
    patch: {
      displayName?: string | null;
      passwordHash?: string;
      totpSecret?: string | null;
      totpEnabled?: boolean;
      backupCodeHashes?: string[];
      email?: string;
    },
  ): Promise<StoredPlatformUser | null> {
    const u = this.users.get(id);
    if (!u) return null;
    if (patch.email !== undefined) {
      const want = patch.email.toLowerCase();
      for (const other of this.users.values()) {
        if (other.id !== id && other.email === want) {
          throw new ApiError('CONFLICT', 'Email already registered', 409);
        }
      }
    }
    const next: StoredPlatformUser = {
      ...u,
      email: patch.email !== undefined ? patch.email.toLowerCase() : u.email,
      displayName: patch.displayName !== undefined ? patch.displayName : u.displayName,
      passwordHash: patch.passwordHash ?? u.passwordHash,
      totpSecret: patch.totpSecret !== undefined ? patch.totpSecret : u.totpSecret,
      totpEnabled: patch.totpEnabled ?? u.totpEnabled,
      backupCodeHashes: patch.backupCodeHashes ?? u.backupCodeHashes,
    };
    this.users.set(id, next);
    return stripSecrets(next);
  }

  async listAll(limit: number): Promise<StoredPlatformUser[]> {
    return [...this.users.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit))
      .map(stripSecrets);
  }

  async countAll(): Promise<number> {
    return this.users.size;
  }

  async setSuspended(
    id: string,
    suspended: boolean,
    reason: string | null,
  ): Promise<StoredPlatformUser | null> {
    const u = this.users.get(id);
    if (!u) return null;
    const next: StoredPlatformUser = {
      ...u,
      suspendedAt: suspended ? new Date().toISOString() : null,
      suspendedReason: suspended ? reason : null,
    };
    this.users.set(id, next);
    return stripSecrets(next);
  }

  async grantPlatformAdmin(email: string): Promise<boolean> {
    const want = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email !== want) continue;
      if (u.isPlatformAdmin) return false;
      this.users.set(u.id, { ...u, isPlatformAdmin: true });
      return true;
    }
    return false;
  }
}

/** Copy without secret material (totp secrets stay server-side). */
function stripSecrets(u: StoredPlatformUser): StoredPlatformUser {
  return { ...u, backupCodeHashes: [...u.backupCodeHashes] };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToStored(row: {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date | string;
  passwordHash: string | null;
  totpSecret?: string | null;
  totpEnabled?: boolean | null;
  backupCodeHashes?: string[] | null;
  isPlatformAdmin?: boolean | null;
  suspendedAt?: Date | string | null;
  suspendedReason?: string | null;
}): StoredPlatformUser | null {
  if (!row.passwordHash) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: iso(row.createdAt),
    passwordHash: row.passwordHash,
    totpSecret: row.totpSecret ?? null,
    totpEnabled: row.totpEnabled ?? false,
    backupCodeHashes: Array.isArray(row.backupCodeHashes) ? [...row.backupCodeHashes] : [],
    isPlatformAdmin: row.isPlatformAdmin ?? false,
    suspendedAt: row.suspendedAt ? iso(row.suspendedAt) : null,
    suspendedReason: row.suspendedReason ?? null,
  };
}

export class DrizzlePlatformUsers implements PlatformUserStore {
  constructor(private readonly db: Database) {}

  async createUser(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
  }): Promise<StoredPlatformUser> {
    try {
      const rows = await this.db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        })
        .returning();
      const row = rows[0];
      const stored = row ? rowToStored(row as unknown as Parameters<typeof rowToStored>[0]) : null;
      if (!stored) throw new Error('User insert failed');
      return stored;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
      throw err;
    }
  }

  async findByEmail(email: string): Promise<StoredPlatformUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    const row = rows[0];
    return row ? rowToStored(row as unknown as Parameters<typeof rowToStored>[0]) : null;
  }

  async findById(id: string): Promise<StoredPlatformUser | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? rowToStored(row as unknown as Parameters<typeof rowToStored>[0]) : null;
  }

  async updateUser(
    id: string,
    patch: {
      displayName?: string | null;
      passwordHash?: string;
      totpSecret?: string | null;
      totpEnabled?: boolean;
      backupCodeHashes?: string[];
      email?: string;
    },
  ): Promise<StoredPlatformUser | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const set: Record<string, unknown> = {};
    if (patch.displayName !== undefined) set['displayName'] = patch.displayName;
    if (patch.passwordHash !== undefined) set['passwordHash'] = patch.passwordHash;
    if (patch.totpSecret !== undefined) set['totpSecret'] = patch.totpSecret;
    if (patch.totpEnabled !== undefined) set['totpEnabled'] = patch.totpEnabled;
    if (patch.backupCodeHashes !== undefined) set['backupCodeHashes'] = patch.backupCodeHashes;
    if (patch.email !== undefined) set['email'] = patch.email.toLowerCase();
    if (Object.keys(set).length === 0) return this.findById(id);
    const rows = await this.db.update(users).set(set).where(eq(users.id, id)).returning();
    const row = rows[0];
    return row ? rowToStored(row as unknown as Parameters<typeof rowToStored>[0]) : null;
  }

  async listAll(limit: number): Promise<StoredPlatformUser[]> {
    const rows = await this.db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(Math.max(0, limit));
    return rows
      .map(r => rowToStored(r as unknown as Parameters<typeof rowToStored>[0]))
      .filter((u): u is StoredPlatformUser => u !== null);
  }

  async countAll(): Promise<number> {
    const rows = await this.db.select({ n: count() }).from(users);
    return Number(rows[0]?.n ?? 0);
  }

  async grantPlatformAdmin(email: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ isPlatformAdmin: true })
      .where(and(eq(users.email, email.toLowerCase()), eq(users.isPlatformAdmin, false)))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async setSuspended(
    id: string,
    suspended: boolean,
    reason: string | null,
  ): Promise<StoredPlatformUser | null> {
    const rows = await this.db
      .update(users)
      .set({
        suspendedAt: suspended ? new Date() : null,
        suspendedReason: suspended ? (reason ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        createdAt: users.createdAt,
        passwordHash: users.passwordHash,
        totpSecret: users.totpSecret,
        totpEnabled: users.totpEnabled,
        isPlatformAdmin: users.isPlatformAdmin,
        suspendedAt: users.suspendedAt,
        suspendedReason: users.suspendedReason,
      });
    const row = rows[0];
    // backupCodeHashes is deliberately not selected: a suspend/restore has
    // no business reading MFA recovery material.
    return row ? rowToStored({ ...row, backupCodeHashes: [] }) : null;
  }
}

/**
 * Platform password resets.
 *
 * Same contract as the per-project customer flow: an opaque token is emailed,
 * only its hash is stored, it expires, and it can be spent exactly once. The
 * store never sees the raw token, so a leak of this table resets nothing.
 */
export interface PasswordResetRecord {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface PasswordResetStore {
  save(rec: PasswordResetRecord): Promise<void>;
  /** Unconsumed and unexpired only — an old token is simply not found. */
  findUsable(tokenHash: string, now: Date): Promise<PasswordResetRecord | null>;
  consume(tokenHash: string): Promise<void>;
  /** Invalidate every outstanding token for a user (after a successful reset). */
  deleteForUser(userId: string): Promise<void>;
}

export class MemoryPasswordResets implements PasswordResetStore {
  private readonly rows = new Map<string, PasswordResetRecord>();

  async save(rec: PasswordResetRecord): Promise<void> {
    this.rows.set(rec.tokenHash, { ...rec });
  }

  async findUsable(tokenHash: string, now: Date): Promise<PasswordResetRecord | null> {
    const rec = this.rows.get(tokenHash);
    if (!rec || rec.consumedAt) return null;
    if (new Date(rec.expiresAt).getTime() <= now.getTime()) return null;
    return { ...rec };
  }

  async consume(tokenHash: string): Promise<void> {
    const rec = this.rows.get(tokenHash);
    if (rec) this.rows.set(tokenHash, { ...rec, consumedAt: new Date().toISOString() });
  }

  async deleteForUser(userId: string): Promise<void> {
    for (const [hash, rec] of this.rows) {
      if (rec.userId === userId) this.rows.delete(hash);
    }
  }
}

export class DrizzlePasswordResets implements PasswordResetStore {
  constructor(private readonly db: Database) {}

  async save(rec: PasswordResetRecord): Promise<void> {
    await this.db.insert(platformPasswordResets).values({
      tokenHash: rec.tokenHash,
      userId: rec.userId,
      expiresAt: new Date(rec.expiresAt),
      consumedAt: rec.consumedAt ? new Date(rec.consumedAt) : null,
    });
  }

  async findUsable(tokenHash: string, now: Date): Promise<PasswordResetRecord | null> {
    const rows = await this.db
      .select()
      .from(platformPasswordResets)
      .where(
        and(
          eq(platformPasswordResets.tokenHash, tokenHash),
          isNull(platformPasswordResets.consumedAt),
          gt(platformPasswordResets.expiresAt, now),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      tokenHash: row.tokenHash,
      userId: row.userId,
      expiresAt: row.expiresAt.toISOString(),
      consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    };
  }

  async consume(tokenHash: string): Promise<void> {
    await this.db
      .update(platformPasswordResets)
      .set({ consumedAt: new Date() })
      .where(eq(platformPasswordResets.tokenHash, tokenHash));
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.delete(platformPasswordResets).where(eq(platformPasswordResets.userId, userId));
  }
}

// ── Invites ─────────────────────────────────────────────────────────

export interface Invite {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface InviteStore {
  create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite>;
  findByTokenHash(hash: string): Promise<Invite | null>;
  markAccepted(id: string): Promise<void>;
}

export class MemoryInvites implements InviteStore {
  private readonly invites = new Map<string, Invite & { tokenHash: string }>();

  async create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite> {
    const { randomUUID } = await import('node:crypto');
    const invite: Invite & { tokenHash: string } = {
      id: randomUUID(),
      organizationId: input.organizationId,
      email: input.email.toLowerCase(),
      role: input.role,
      expiresAt: input.expiresAt.toISOString(),
      acceptedAt: null,
      createdAt: new Date().toISOString(),
      tokenHash: input.tokenHash,
    };
    void input.createdBy;
    this.invites.set(invite.id, invite);
    const { tokenHash: _drop, ...rest } = invite;
    void _drop;
    return rest;
  }

  async findByTokenHash(hash: string): Promise<Invite | null> {
    for (const inv of this.invites.values()) {
      if (inv.tokenHash === hash) {
        const { tokenHash: _drop, ...rest } = inv;
        void _drop;
        return rest;
      }
    }
    return null;
  }

  async markAccepted(id: string): Promise<void> {
    const inv = this.invites.get(id);
    if (inv) inv.acceptedAt = new Date().toISOString();
  }
}

export class DrizzleInvites implements InviteStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string | null;
  }): Promise<Invite> {
    const rows = await this.db
      .insert(organizationInvites)
      .values({
        organizationId: input.organizationId,
        email: input.email.toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Invite insert failed');
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      expiresAt: iso(row.expiresAt),
      acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null,
      createdAt: iso(row.createdAt),
    };
  }

  async findByTokenHash(hash: string): Promise<Invite | null> {
    const rows = await this.db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.tokenHash, hash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      expiresAt: iso(row.expiresAt),
      acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null,
      createdAt: iso(row.createdAt),
    };
  }

  async markAccepted(id: string): Promise<void> {
    await this.db
      .update(organizationInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(organizationInvites.id, id));
  }
}

// ── Organization security policies ─────────────────────────────

export interface OrgPolicy {
  organizationId: string;
  allowedEmailDomains: string[];
  requireMfa: boolean;
  passwordMinLength: number | null;
  passwordMinClasses: number | null;
  logRetentionDays: number | null;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  organizationId: '',
  allowedEmailDomains: [],
  requireMfa: false,
  passwordMinLength: null,
  passwordMinClasses: null,
  logRetentionDays: null,
};

function cleanDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const d of input.slice(0, 20)) {
    const s = String(d ?? '').trim().toLowerCase().replace(/^\.+/, '');
    if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Email domain gate: empty allowlist = open; otherwise exact-or-subdomain match. */
export function emailAllowedByPolicy(email: string, policy: OrgPolicy): boolean {
  if (policy.allowedEmailDomains.length === 0) return true;
  const domain = email.toLowerCase().split('@')[1] ?? '';
  return policy.allowedEmailDomains.some(
    d => domain === d || domain.endsWith(`.${d}`),
  );
}

export interface OrgPolicyStore {
  getPolicy(organizationId: string): Promise<OrgPolicy>;
  setPolicy(organizationId: string, patch: Partial<Omit<OrgPolicy, 'organizationId'>>): Promise<OrgPolicy>;
}

export class MemoryOrgPolicies implements OrgPolicyStore {
  private readonly policies = new Map<string, OrgPolicy>();
  async getPolicy(organizationId: string): Promise<OrgPolicy> {
    return (
      this.policies.get(organizationId) ?? {
        ...DEFAULT_ORG_POLICY,
        organizationId,
        allowedEmailDomains: [],
      }
    );
  }
  async setPolicy(
    organizationId: string,
    patch: Partial<Omit<OrgPolicy, 'organizationId'>>,
  ): Promise<OrgPolicy> {
    const current = await this.getPolicy(organizationId);
    const next: OrgPolicy = {
      organizationId,
      allowedEmailDomains:
        patch.allowedEmailDomains === undefined
          ? current.allowedEmailDomains
          : cleanDomains(patch.allowedEmailDomains),
      requireMfa: patch.requireMfa ?? current.requireMfa,
      passwordMinLength: patch.passwordMinLength ?? current.passwordMinLength,
      passwordMinClasses: patch.passwordMinClasses ?? current.passwordMinClasses,
      logRetentionDays: patch.logRetentionDays ?? current.logRetentionDays,
    };
    this.policies.set(organizationId, next);
    return { ...next, allowedEmailDomains: [...next.allowedEmailDomains] };
  }
}

export class DrizzleOrgPolicies implements OrgPolicyStore {
  constructor(private readonly db: Database) {}
  async getPolicy(organizationId: string): Promise<OrgPolicy> {
    const rows = await this.db
      .select()
      .from(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, organizationId))
      .limit(1);
    const row = rows[0];
    if (!row) return { ...DEFAULT_ORG_POLICY, organizationId, allowedEmailDomains: [] };
    return {
      organizationId,
      allowedEmailDomains: cleanDomains(row.allowedEmailDomains),
      requireMfa: row.requireMfa ?? false,
      passwordMinLength: row.passwordMinLength,
      passwordMinClasses: row.passwordMinClasses,
      logRetentionDays: row.logRetentionDays ?? null,
    };
  }
  async setPolicy(
    organizationId: string,
    patch: Partial<Omit<OrgPolicy, 'organizationId'>>,
  ): Promise<OrgPolicy> {
    const current = await this.getPolicy(organizationId);
    const next: OrgPolicy = {
      organizationId,
      allowedEmailDomains:
        patch.allowedEmailDomains === undefined
          ? current.allowedEmailDomains
          : cleanDomains(patch.allowedEmailDomains),
      requireMfa: patch.requireMfa ?? current.requireMfa,
      passwordMinLength:
        patch.passwordMinLength === undefined
          ? current.passwordMinLength
          : patch.passwordMinLength,
      passwordMinClasses:
        patch.passwordMinClasses === undefined
          ? current.passwordMinClasses
          : patch.passwordMinClasses,
      logRetentionDays:
        patch.logRetentionDays === undefined ? current.logRetentionDays : patch.logRetentionDays,
    };
    await this.db
      .insert(organizationPolicies)
      .values({
        organizationId,
        allowedEmailDomains: next.allowedEmailDomains,
        requireMfa: next.requireMfa,
        passwordMinLength: next.passwordMinLength,
        passwordMinClasses: next.passwordMinClasses,
        logRetentionDays: next.logRetentionDays,
      })
      .onConflictDoUpdate({
        target: organizationPolicies.organizationId,
        set: {
          allowedEmailDomains: next.allowedEmailDomains,
          requireMfa: next.requireMfa,
          passwordMinLength: next.passwordMinLength,
          passwordMinClasses: next.passwordMinClasses,
          logRetentionDays: next.logRetentionDays,
          updatedAt: new Date(),
        },
      });
    return this.getPolicy(organizationId);
  }
}

// ── SSO connections (OIDC metadata; secrets encrypted at rest) ──

export interface SsoConnection {
  id: string;
  organizationId: string;
  provider: string;
  displayName: string;
  issuer: string;
  clientId: string;
  defaultRole: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** AES-256-GCM envelope for IdP client secrets (key = JWT_SECRET-derived). */
export function encryptSecret(plaintext: string, jwtSecret: string): string {
  const key = createHash('sha256').update(`sso:${jwtSecret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(envelope: string, jwtSecret: string): string {
  const [ivB, tagB, dataB] = envelope.split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Malformed secret envelope');
  const key = createHash('sha256').update(`sso:${jwtSecret}`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export interface SsoStore {
  create(input: {
    organizationId: string;
    provider: string;
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecretEnc: string;
    defaultRole: string;
  }): Promise<SsoConnection>;
  list(organizationId: string): Promise<SsoConnection[]>;
  findById(id: string): Promise<(SsoConnection & { clientSecretEnc: string }) | null>;
  remove(id: string): Promise<boolean>;
}

function ssoRowToPublic(row: {
  id: string;
  organizationId: string;
  provider: string | null;
  displayName: string | null;
  issuer: string;
  clientId: string;
  defaultRole: string | null;
  enabled: boolean | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): SsoConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider ?? 'oidc',
    displayName: row.displayName ?? 'SSO',
    issuer: row.issuer,
    clientId: row.clientId,
    defaultRole: row.defaultRole ?? 'member',
    enabled: row.enabled ?? true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export class MemorySsoStore implements SsoStore {
  private readonly rows = new Map<string, SsoConnection & { clientSecretEnc: string }>();
  async create(input: {
    organizationId: string;
    provider: string;
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecretEnc: string;
    defaultRole: string;
  }): Promise<SsoConnection> {
    const { randomUUID } = await import('node:crypto');
    const now = new Date().toISOString();
    const full = { ...input, id: randomUUID(), enabled: true, createdAt: now, updatedAt: now };
    this.rows.set(full.id, full);
    const { clientSecretEnc: _drop, ...pub } = full;
    void _drop;
    return pub;
  }
  async list(organizationId: string): Promise<SsoConnection[]> {
    return [...this.rows.values()]
      .filter(r => r.organizationId === organizationId)
      .map(({ clientSecretEnc: _drop, ...pub }) => {
        void _drop;
        return pub;
      });
  }
  async findById(id: string): Promise<(SsoConnection & { clientSecretEnc: string }) | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class DrizzleSsoStore implements SsoStore {
  constructor(private readonly db: Database) {}
  async create(input: {
    organizationId: string;
    provider: string;
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecretEnc: string;
    defaultRole: string;
  }): Promise<SsoConnection> {
    const rows = await this.db
      .insert(ssoConnections)
      .values({
        organizationId: input.organizationId,
        provider: input.provider,
        displayName: input.displayName,
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretEnc: input.clientSecretEnc,
        defaultRole: input.defaultRole,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('SSO insert failed');
    return ssoRowToPublic(row);
  }
  async list(organizationId: string): Promise<SsoConnection[]> {
    const rows = await this.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.organizationId, organizationId));
    return rows.map(ssoRowToPublic);
  }
  async findById(id: string): Promise<(SsoConnection & { clientSecretEnc: string }) | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db.select().from(ssoConnections).where(eq(ssoConnections.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...ssoRowToPublic(row), clientSecretEnc: row.clientSecretEnc };
  }
  async remove(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await this.db.delete(ssoConnections).where(eq(ssoConnections.id, id)).returning();
    return rows.length > 0;
  }
}

// ── Service wiring ──────────────────────────────────────────────────

export interface PlatformAuth {
  users: PlatformUserStore;
  invites: InviteStore;
  policies: OrgPolicyStore;
  sso: SsoStore;
  resets: PasswordResetStore;
}

export function platformAuthFor(ctx: ApiContext): PlatformAuth {
  const existing = (ctx as unknown as { __platform?: PlatformAuth }).__platform;
  if (existing) return existing;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const controlDb = ctx.controlDb;
  const auth: PlatformAuth =
    durable && controlDb
      ? {
          users: new DrizzlePlatformUsers(controlDb.db),
          invites: new DrizzleInvites(controlDb.db),
          policies: new DrizzleOrgPolicies(controlDb.db),
          sso: new DrizzleSsoStore(controlDb.db),
          resets: new DrizzlePasswordResets(controlDb.db),
        }
      : {
          users: new MemoryPlatformUsers(),
          invites: new MemoryInvites(),
          policies: new MemoryOrgPolicies(),
          sso: new MemorySsoStore(),
          resets: new MemoryPasswordResets(),
        };
  (ctx as unknown as { __platform?: PlatformAuth }).__platform = auth;
  return auth;
}

function expose(user: StoredPlatformUser): PlatformUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
    totpEnabled: user.totpEnabled,
    isPlatformAdmin: user.isPlatformAdmin,
    suspendedAt: user.suspendedAt,
  };
}

/**
 * The suspension gate.
 *
 * A suspension that only hid the account from an operator console would be
 * decoration: every token already issued would keep working, and the account
 * could still sign in. This runs at sign-in AND on every authenticated
 * request, so an account suspended mid-session stops working on its next
 * call rather than at token expiry.
 *
 * The reason is never returned — it is an internal operator note.
 */
export function assertNotSuspended(user: { suspendedAt: string | null }): void {
  if (user.suspendedAt) {
    throw new ApiError('FORBIDDEN', 'This account is suspended. Contact CloudNivo support.', 403);
  }
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `cn_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

async function issueSession(
  ctx: ApiContext,
  user: StoredPlatformUser,
  meta?: { ip: string | null; agent: string | null },
): Promise<{ token: string; cookie: string }> {
  const token = await signSession(
    { sub: user.id, email: user.email },
    {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
      expiresInSeconds: ctx.config.JWT_EXPIRES_IN,
    },
  );
  // Device record for session management (best-effort; never breaks login).
  try {
    const session = await verifySession(token, {
      jwtSecret: ctx.config.JWT_SECRET,
      issuer: ctx.config.JWT_ISSUER,
    });
    if (session.jti) {
      const ttl = Math.max(60, ctx.config.JWT_EXPIRES_IN);
      await ctx.sessionRevocations
        .set(
          `sess-meta:${session.jti}`,
          JSON.stringify({
            userId: user.id,
            ip: meta?.ip ?? null,
            agent: (meta?.agent ?? '').slice(0, 200),
            createdAt: new Date().toISOString(),
          }),
          ttl,
        )
        .catch(() => undefined);
      const listKey = `sess-user:${user.id}`;
      const raw = await ctx.sessionRevocations.get(listKey).catch(() => null);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      if (!list.includes(session.jti)) {
        list.push(session.jti);
        await ctx.sessionRevocations.set(listKey, JSON.stringify(list.slice(-20)), ttl).catch(() => undefined);
      }
    }
  } catch {
    // Metadata is auxiliary — the session itself is already issued.
  }
  const secure = ctx.config.APP_URL.startsWith('https://');
  return { token, cookie: sessionCookie(token, ctx.config.JWT_EXPIRES_IN, secure) };
}

/** Bot gate for platform signup/login (open + honest when unconfigured). */
async function checkPlatformCaptcha(
  ctx: ApiContext,
  req: IncomingMessage,
  raw: unknown,
): Promise<void> {
  const ip = clientIpOf(req, ctx.config.TRUSTED_PROXY_HOPS);
  const token = (raw as { captcha_token?: unknown } | undefined)?.captcha_token;
  let result: { ok: boolean; enforced: boolean };
  try {
    result = await verifyCaptcha(
      { provider: ctx.config.CAPTCHA_PROVIDER, secretKey: ctx.config.CAPTCHA_SECRET_KEY },
      typeof token === 'string' ? token : null,
      ip,
    );
  } catch (err) {
    throw new ApiError('CAPTCHA_UNAVAILABLE', err instanceof Error ? err.message : 'Try again', 503);
  }
  if (result.enforced && !result.ok) {
    throw new ApiError('CAPTCHA_FAILED', 'Bot verification failed', 403);
  }
}

/**
 * Effective password policy: legacy length check by default (back-compat),
 * strictest member-org override wins when any org sets one.
 */
async function effectivePasswordPolicy(
  ctx: ApiContext,
  store: PlatformAuth,
  userId: string | null,
): Promise<PasswordPolicy> {
  // The baseline applies to everyone, including signup (no user yet).
  if (!userId) return { ...PLATFORM_BASELINE_PASSWORD_POLICY };
  try {
    const memberships = await ctx.registry.membershipsFor(userId);
    let minLength = 0;
    let minClasses = 0;
    for (const m of memberships) {
      const policy = await store.policies.getPolicy(m.organizationId).catch(() => null);
      if (!policy) continue;
      if (typeof policy.passwordMinLength === 'number') {
        minLength = Math.max(minLength, policy.passwordMinLength);
      }
      if (typeof policy.passwordMinClasses === 'number') {
        minClasses = Math.max(minClasses, policy.passwordMinClasses);
      }
    }
    // Organization policy can only tighten the baseline, never loosen it.
    const base = PLATFORM_BASELINE_PASSWORD_POLICY;
    return mergePasswordPolicy({
      ...base,
      minLength: Math.max(minLength, base.minLength),
      minClasses: Math.max(minClasses, base.minClasses),
    });
  } catch {
    // Registry unreachable: fail closed on the baseline, never below it.
    return { ...PLATFORM_BASELINE_PASSWORD_POLICY };
  }
}

/** True when any of the user's orgs mandates MFA. Fail-closed: registry
 *  errors assume MFA is required rather than skipping enrollment. */
async function orgRequiresMfa(
  ctx: ApiContext,
  store: PlatformAuth,
  userId: string,
): Promise<boolean> {
  try {
    const memberships = await ctx.registry.membershipsFor(userId);
    for (const m of memberships) {
      const policy = await store.policies.getPolicy(m.organizationId).catch(() => null);
      if (policy?.requireMfa) return true;
    }
  } catch (err) {
    ctx.logger.warn('platform.mfa_policy_degraded', {
      error: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    });
    return true;
  }
  return false;
}

function clientMeta(
  req: IncomingMessage,
  trustedProxyHops = 1,
): { ip: string | null; agent: string | null } {
  const ip = clientIpOf(req, trustedProxyHops);
  const agent = req.headers['user-agent'];
  return { ip, agent: Array.isArray(agent) ? (agent[0] ?? null) : (agent ?? null) };
}

/**
 * MFA identity: a live session OR a one-time org-mandated setup ticket.
 * Returns the userId plus the setup ticket (null for session auth) so
 * confirmation can complete an interrupted login.
 */
async function mfaIdentity(
  ctx: ApiContext,
  req: IncomingMessage,
  raw: unknown,
): Promise<{ userId: string; setupTicket: string | null }> {
  const ticket = (raw as { setupTicket?: unknown } | undefined)?.setupTicket;
  if (typeof ticket === 'string' && ticket.length >= 10) {
    const userId = await ctx.sessionRevocations.get(`platform-mfa-setup:${ticket}`).catch(() => null);
    if (!userId) throw new ApiError('UNAUTHORIZED', 'Setup ticket expired — sign in again', 401);
    return { userId, setupTicket: ticket };
  }
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const session = await verifyPlatformSession(ctx, token);
  return { userId: session.sub, setupTicket: null };
}

interface PlatformSessionInfo {
  jti: string;
  ip: string | null;
  agent: string | null;
  createdAt: string | null;
  current: boolean;
}

async function sessionJtisFor(ctx: ApiContext, userId: string): Promise<string[]> {
  const raw = await ctx.sessionRevocations.get(`sess-user:${userId}`).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((j): j is string => typeof j === 'string') : [];
  } catch {
    return [];
  }
}

async function listPlatformSessions(
  ctx: ApiContext,
  userId: string,
  currentJti: string | null,
): Promise<PlatformSessionInfo[]> {
  const jtis = await sessionJtisFor(ctx, userId);
  const out: PlatformSessionInfo[] = [];
  for (const jti of jtis.slice(-20)) {
    const raw = await ctx.sessionRevocations.get(`sess-meta:${jti}`).catch(() => null);
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw) as { ip?: unknown; agent?: unknown; createdAt?: unknown; userId?: unknown };
      if (meta.userId !== userId) continue;
      out.push({
        jti,
        ip: typeof meta.ip === 'string' ? meta.ip : null,
        agent: typeof meta.agent === 'string' ? meta.agent : null,
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
        current: jti === currentJti,
      });
    } catch {
      continue;
    }
  }
  return out;
}

async function revokeSessionByJti(ctx: ApiContext, jti: string): Promise<void> {
  await ctx.sessionRevocations.set(`sess-revoked:jti:${jti}`, '1', Math.max(60, ctx.config.JWT_EXPIRES_IN)).catch(() => undefined);
  await ctx.sessionRevocations.del(`sess-meta:${jti}`).catch(() => undefined);
}

async function platformSessionOwnedBy(
  ctx: ApiContext,
  userId: string,
  jti: string,
): Promise<boolean> {
  const jtis = await sessionJtisFor(ctx, userId);
  return jtis.includes(jti);
}

async function revokeOtherPlatformSessions(
  ctx: ApiContext,
  userId: string,
  currentJti: string | null,
): Promise<number> {
  const jtis = await sessionJtisFor(ctx, userId);
  let revoked = 0;
  const remaining: string[] = [];
  for (const jti of jtis) {
    if (jti === currentJti) {
      remaining.push(jti);
      continue;
    }
    await revokeSessionByJti(ctx, jti);
    revoked += 1;
  }
  await ctx.sessionRevocations
    .set(`sess-user:${userId}`, JSON.stringify(remaining), Math.max(60, ctx.config.JWT_EXPIRES_IN))
    .catch(() => undefined);
  return revoked;
}

/** Email is the unique login key: rename directly with uniqueness enforced. */
async function renamePlatformEmail(
  ctx: ApiContext,
  store: PlatformAuth,
  userId: string,
  newEmail: string,
): Promise<void> {
  void ctx;
  try {
    await store.users.updateUser(userId, { email: newEmail.toLowerCase() });
  } catch (err) {
    // Drizzle unique violation surfaces as a driver error — normalize it.
    if (isUniqueViolation(err)) {
      throw new ApiError('CONFLICT', 'Email already registered', 409);
    }
    throw err;
  }
}

// ── Routes ──────────────────────────────────────────────────────────

const SignupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

const InviteBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
});

const UpdateMeBody = z.object({
  displayName: z.string().trim().min(1).max(120).nullable(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});

const INVITE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

function newInviteToken(): { raw: string; hash: string } {
  const raw = `inv_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

export function isPlatformAuthRoute(pathname: string, method: string): boolean {
  void method;
  return (
    pathname === '/api/v1/auth/signup' ||
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/logout' ||
    pathname === '/api/v1/auth/password' ||
    pathname === '/api/v1/auth/password/forgot' ||
    pathname === '/api/v1/auth/password/reset' ||
    pathname === '/api/v1/auth/mfa-verify' ||
    pathname === '/api/v1/auth/sso/callback' ||
    pathname.startsWith('/api/v1/auth/sso/') ||
    pathname === '/api/v1/me' ||
    pathname.startsWith('/api/v1/me/') ||
    pathname.startsWith('/api/v1/invites/') ||
    /^\/api\/v1\/organizations\/[^/]+\/invites\/?$/.test(pathname) ||
    /^\/api\/v1\/organizations\/[^/]+\/policy\/?$/.test(pathname) ||
    /^\/api\/v1\/organizations\/[^/]+\/sso(\/[^/]+)?\/?$/.test(pathname)
  );
}

/** SSO callback URL: explicit env wins, else same-origin as the API request. */
function ssoCallbackUrl(ctx: ApiContext, req: IncomingMessage): string {
  const base = ctx.config.PUBLIC_API_URL || 'http://localhost:3001';
  void req;
  return `${base.replace(/\/+$/, '')}/api/v1/auth/sso/callback`;
}

export async function handlePlatformAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const start = Date.now();
  const finish = (status: number, body: unknown, extra?: Record<string, string>): true => {
    logger.info('platform.request', {
      route: url.pathname,
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, { ...baseHeaders, ...extra });
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toPublicError(err, requestId);
    logger.info('platform.request', {
      route: url.pathname,
      method: req.method,
      status,
      latencyMs: Date.now() - start,
    });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const strictLimit = async (): Promise<void> => {
    const ip =
      rateLimitIp(req, ctx.config.TRUSTED_PROXY_HOPS);
    const rl = await checkRateLimit(ctx.rateLimitStore, `platform-auth:${ip}`, {
      windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
      max: ctx.config.AUTH_RATE_MAX,
      keyPrefix: 'platform-auth',
    });
    if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many attempts', 429);
  };
  // MFA code guessing gets its own bucket (separate from login brute-force)
  // with a tighter per-code budget but no starvation of legit setup flows.
  const mfaLimit = async (): Promise<void> => {
    const ip =
      rateLimitIp(req, ctx.config.TRUSTED_PROXY_HOPS);
    const rl = await checkRateLimit(ctx.rateLimitStore, `platform-mfa:${ip}`, {
      windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
      max: ctx.config.AUTH_RATE_MAX * 3,
      keyPrefix: 'platform-mfa',
    });
    if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many attempts', 429);
  };
  // Credentials are small. The cap is enforced while streaming so an unbounded
  // body cannot be buffered by an unauthenticated caller — this is the surface
  // reachable with no token at all, so it is the one that matters most.
  const readJson = async (): Promise<unknown> => readCheckedJson(req, 131_072);
  try {
    const store = platformAuthFor(ctx);

    if (url.pathname === '/api/v1/auth/signup' && req.method === 'POST') {
      await strictLimit();
      const raw = await readJson();
      const parsed = parseBody(SignupBody, raw);
      await checkPlatformCaptcha(ctx, req, raw);
      const policy = await effectivePasswordPolicy(ctx, store, null);
      const verdict = checkPasswordPolicy(parsed.password, policy);
      if (!verdict.ok) {
        throw new ApiError('WEAK_PASSWORD', verdict.reasons[0] ?? 'Password too weak', 400);
      }
      const passwordHash = await hashPassword(parsed.password);
      const user = await store.users.createUser({
        email: parsed.email,
        passwordHash,
        displayName: parsed.displayName ?? null,
      });
      /**
       * Staff allowlist also applies at signup, not only at boot: the first
       * operator usually signs up AFTER the env var is set, and a bootstrap
       * that only ran at boot would silently skip them forever.
       */
      const promoted = await applyStaffAllowlist(ctx, user.email);
      const withStaff = promoted ? { ...user, isPlatformAdmin: true } : user;
      const { token, cookie } = await issueSession(ctx, user, clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS));
      await ctx.registry.recordAudit('platform.signup', { userId: user.id });
      // Welcome email is best-effort and centralized in platform-mail.ts: it
      // never throws, never blocks signup, and fires exactly once per
      // successful account create (duplicates fail above).
      void sendSignupWelcome(ctx, {
        to: user.email,
        displayName: user.displayName,
        userId: user.id,
      }).catch(() => undefined);
      return finish(201, ok({ user: expose(withStaff), token }, requestId), { 'Set-Cookie': cookie });
    }

    if (url.pathname === '/api/v1/auth/login' && req.method === 'POST') {
      await strictLimit();
      const raw = await readJson();
      const parsed = parseBody(LoginBody, raw);
      await checkPlatformCaptcha(ctx, req, raw);
      const user = await store.users.findByEmail(parsed.email);
      /**
       * Report the attempted account to the IP reputation tracker from HERE,
       * where the address is the one the caller actually submitted.
       *
       * The tracker's sharpest signal is "this IP is failing against accounts
       * it has not tried before" — credential stuffing looks like that and a
       * forgotten password does not. Deriving that subject from a request
       * HEADER would hand the attacker the switch: pin one value and every
       * attempt looks like the same account, which is precisely the case the
       * tracker treats as harmless. The parsed body is the only authoritative
       * source, so the scoring call lives next to the failure.
       *
       * Unknown addresses score too — enumeration is the reconnaissance step
       * before stuffing, and refusing to score it would leave the cheap half
       * of the attack free.
       */
      const failed = (): void => {
        void ctx.threat.record(
          rateLimitIp(req, ctx.config.TRUSTED_PROXY_HOPS),
          'auth_failure',
          `platform-login:${parsed.email.toLowerCase()}`,
        );
      };
      if (!user) {
        // Timing equalization: do equivalent scrypt work for unknown emails.
        await hashPassword(`dummy:${randomBytes(8).toString('hex')}:long-enough`);
        failed();
        throw new ApiError('UNAUTHORIZED', 'Invalid email or password', 401);
      }
      if (!(await verifyPassword(parsed.password, user.passwordHash))) {
        await ctx.registry.recordAudit('platform.login_failed', { userId: user.id });
        failed();
        throw new ApiError('UNAUTHORIZED', 'Invalid email or password', 401);
      }
      /**
       * Checked AFTER the password, deliberately. Refusing a suspended
       * account before verifying the password would answer "suspended" to
       * anyone who guessed the address, turning the endpoint into an
       * account-existence oracle.
       */
      if (user.suspendedAt) {
        await ctx.registry.recordAudit('platform.login_suspended', { userId: user.id });
        assertNotSuspended(user);
      }
      if (user.totpEnabled && user.totpSecret) {
        const ticket = `pmfa_${randomBytes(24).toString('base64url')}`;
        await ctx.sessionRevocations
          .set(`platform-mfa:${ticket}`, user.id, 300)
          .catch(() => undefined);
        await ctx.registry.recordAudit('platform.mfa_challenged', { userId: user.id });
        return finish(200, ok({ mfaRequired: true, mfaTicket: ticket }, requestId));
      }
      if (await orgRequiresMfa(ctx, store, user.id)) {
        const ticket = `psetup_${randomBytes(24).toString('base64url')}`;
        await ctx.sessionRevocations
          .set(`platform-mfa-setup:${ticket}`, user.id, 600)
          .catch(() => undefined);
        return finish(
          428,
          ok({ mfaSetupRequired: true, setupTicket: ticket }, requestId),
        );
      }
      const { token, cookie } = await issueSession(ctx, user, clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS));
      await ctx.registry.recordAudit('platform.login', { userId: user.id });
      return finish(200, ok({ user: expose(user), token }, requestId), { 'Set-Cookie': cookie });
    }

    /**
     * Request a reset link. The answer is ALWAYS the same, whether or not the
     * address belongs to an account: anything else turns this endpoint into a
     * way to test which emails are registered. Rate-limited like login.
     */
    if (url.pathname === '/api/v1/auth/password/forgot' && req.method === 'POST') {
      await strictLimit();
      const parsed = parseBody(
        z.object({ email: z.string().email().max(320) }),
        await readJson(),
      );
      const user = await store.users.findByEmail(parsed.email);
      if (user) {
        const raw = newOpaqueToken();
        await store.resets.save({
          tokenHash: hashToken(raw),
          userId: user.id,
          expiresAt: new Date(Date.now() + ctx.config.AUTH_RESET_TTL_S * 1000).toISOString(),
          consumedAt: null,
        });
        const appOrigin = (ctx.config.APP_URL ?? '').replace(/\/+$/, '') || 'http://localhost:3000';
        void sendPlatformPasswordReset(ctx, {
          to: user.email,
          resetUrl: `${appOrigin}/reset-password?token=${raw}`,
          userId: user.id,
        }).catch(() => undefined);
      }
      await ctx.registry.recordAudit('platform.password_reset_requested', {}).catch(() => undefined);
      return finish(202, ok({ sent: true }, requestId));
    }

    /**
     * Spend the token. The token is consumed before the password is written,
     * every other outstanding token for that user is dropped, and every live
     * session is revoked — a reset is what you do when you fear someone else
     * is in the account, so it has to end their sessions too.
     */
    if (url.pathname === '/api/v1/auth/password/reset' && req.method === 'POST') {
      await strictLimit();
      const parsed = parseBody(
        z.object({ token: z.string().min(16).max(200), password: z.string().min(1).max(200) }),
        await readJson(),
      );
      const rec = await store.resets.findUsable(hashToken(parsed.token), new Date());
      if (!rec) throw new ApiError('INVALID_TOKEN', 'This reset link is invalid or has expired', 400);
      const user = await store.users.findById(rec.userId);
      if (!user) throw new ApiError('INVALID_TOKEN', 'This reset link is invalid or has expired', 400);
      const policy = await effectivePasswordPolicy(ctx, store, null);
      const verdict = checkPasswordPolicy(parsed.password, policy);
      if (!verdict.ok) {
        throw new ApiError('WEAK_PASSWORD', verdict.reasons[0] ?? 'Password too weak', 400);
      }
      await store.resets.consume(rec.tokenHash);
      await store.users.updateUser(user.id, { passwordHash: await hashPassword(parsed.password) });
      await store.resets.deleteForUser(user.id);
      for (const jti of await sessionJtisFor(ctx, user.id)) {
        await revokeSessionByJti(ctx, jti);
      }
      await ctx.registry
        .recordAudit('platform.password_reset_completed', { userId: user.id })
        .catch(() => undefined);
      logger.info('platform.password_reset_completed', { user: user.id });
      return finish(200, ok({ reset: true }, requestId));
    }

    if (url.pathname === '/api/v1/auth/mfa-verify' && req.method === 'POST') {
      await strictLimit();
      const parsed = parseBody(
        z.object({ mfaTicket: z.string().min(10).max(200), code: z.string().min(4).max(32) }),
        await readJson(),
      );
      const userId = await ctx.sessionRevocations.get(`platform-mfa:${parsed.mfaTicket}`).catch(() => null);
      if (!userId) throw new ApiError('UNAUTHORIZED', 'Challenge expired — sign in again', 401);
      const user = await store.users.findById(userId);
      if (!user?.totpSecret || !user.totpEnabled) {
        throw new ApiError('UNAUTHORIZED', 'MFA verification failed', 401);
      }
      const presented = parsed.code.replace(/[\s-]/g, '');
      let okVerify = verifyTotp(user.totpSecret, presented);
      if (!okVerify) {
        const hash = createHash('sha256').update(presented).digest('hex');
        const remaining = user.backupCodeHashes.filter(h => h !== hash);
        if (remaining.length !== user.backupCodeHashes.length) {
          await store.users.updateUser(user.id, { backupCodeHashes: remaining });
          okVerify = true;
        }
      }
      if (!okVerify) {
        await ctx.registry.recordAudit('platform.login_failed', { userId: user.id });
        throw new ApiError('UNAUTHORIZED', 'Incorrect code', 401);
      }
      await ctx.sessionRevocations.del(`platform-mfa:${parsed.mfaTicket}`).catch(() => undefined);
      const { token, cookie } = await issueSession(ctx, user, clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS));
      await ctx.registry.recordAudit('platform.login', { userId: user.id });
      return finish(200, ok({ user: expose(user), token }, requestId), { 'Set-Cookie': cookie });
    }

    if (url.pathname === '/api/v1/auth/logout' && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (token) {
        // Server-side invalidation: the session ID (and token hash for
        // legacy tokens) lands on the shared denylist, so the token is
        // rejected on every instance from here until its natural expiry.
        // Best-effort parse — logout still clears the cookie for expired or
        // malformed tokens.
        const session = await verifySession(token, {
          jwtSecret: ctx.config.JWT_SECRET,
          issuer: ctx.config.JWT_ISSUER,
        }).catch(() => null);
        await revokeSession(
          token,
          { jwtSecret: ctx.config.JWT_SECRET, issuer: ctx.config.JWT_ISSUER },
          ctx.sessionRevocations,
        ).catch(() => ({ revoked: false, jti: null }));
        if (session) {
          await ctx.registry.recordAudit('platform.logout', { userId: session.sub });
          // Drop device metadata + user index entry (best-effort).
          if (session.jti) {
            await ctx.sessionRevocations.del(`sess-meta:${session.jti}`).catch(() => undefined);
            const raw = await ctx.sessionRevocations.get(`sess-user:${session.sub}`).catch(() => null);
            if (raw) {
              try {
                const list = (JSON.parse(raw) as unknown[]).filter(j => j !== session.jti);
                await ctx.sessionRevocations
                  .set(`sess-user:${session.sub}`, JSON.stringify(list), Math.max(60, ctx.config.JWT_EXPIRES_IN))
                  .catch(() => undefined);
              } catch {
                // Stale index — TTL reaps it.
              }
            }
          }
        }
      }
      const cleared =
        'cn_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' +
        (ctx.config.APP_URL.startsWith('https://') ? '; Secure' : '');
      return finish(200, ok({ loggedOut: true }, requestId), { 'Set-Cookie': cleared });
    }

    if (url.pathname === '/api/v1/me' && req.method === 'GET') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      const memberships = await ctx.registry.membershipsFor(user.id);
      const orgs = await ctx.registry.listOrganizations(user.id);
      const roleOf = new Map(memberships.map(m => [m.organizationId, m.role]));
      return finish(
        200,
        ok(
          {
            user: expose(user),
            organizations: orgs.map(o => ({ ...o, role: roleOf.get(o.id) ?? 'member' })),
          },
          requestId,
        ),
      );
    }

    if (url.pathname === '/api/v1/auth/password' && req.method === 'POST') {
      await strictLimit();
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const parsed = parseBody(PasswordBody, await readJson());
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      if (!(await verifyPassword(parsed.currentPassword, user.passwordHash))) {
        await ctx.registry.recordAudit('platform.password.failed', { userId: user.id });
        throw new ApiError('UNAUTHORIZED', 'Current password is incorrect', 401);
      }
      // Organization password policy (strictest member org wins; legacy default).
      const policy = await effectivePasswordPolicy(ctx, store, user.id);
      const verdict = checkPasswordPolicy(parsed.newPassword, policy);
      if (!verdict.ok) {
        throw new ApiError('WEAK_PASSWORD', verdict.reasons[0] ?? 'Password too weak', 400);
      }
      const updated = await store.users.updateUser(user.id, {
        passwordHash: await hashPassword(parsed.newPassword),
      });
      if (!updated) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      // Stolen sessions must not survive a password change: revoke all other
      // sessions, keep the current one so the user is not logged out.
      await revokeOtherPlatformSessions(ctx, user.id, session.jti ?? null);
      await ctx.registry.recordAudit('platform.password.changed', { userId: user.id });
      return finish(200, ok({ changed: true }, requestId));
    }

    // ── Platform TOTP MFA (self-service) ──
    // Enroll/confirm accept a session OR an MFA setup ticket (org-mandated
    // enrollment at login). Confirming with a setup ticket issues the
    // session directly, completing the interrupted login.
    if (url.pathname === '/api/v1/me/mfa/enroll' && req.method === 'POST') {
      await mfaLimit();
      const { userId, setupTicket } = await mfaIdentity(ctx, req, await readJson());
      const user = await store.users.findById(userId);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      const secret = generateTotpSecret();
      await store.users.updateUser(user.id, { totpSecret: secret, totpEnabled: false });
      await ctx.registry.recordAudit('platform.mfa.enrolled', { userId: user.id });
      return finish(
        200,
        ok(
          {
            secret,
            uri: totpProvisionUri({ secret, account: user.email }),
            setupTicket: setupTicket ?? undefined,
          },
          requestId,
        ),
      );
    }

    if (url.pathname === '/api/v1/me/mfa/confirm' && req.method === 'POST') {
      await mfaLimit();
      const raw = await readJson();
      const { userId, setupTicket } = await mfaIdentity(ctx, req, raw);
      const parsed = parseBody(z.object({ code: z.string().min(4).max(32) }), raw);
      const user = await store.users.findById(userId);
      if (!user?.totpSecret) throw new ApiError('CONFLICT', 'MFA enrollment not started', 409);
      if (!verifyTotp(user.totpSecret, parsed.code)) {
        throw new ApiError('UNAUTHORIZED', 'Incorrect authenticator code', 401);
      }
      const { codes, hashes } = generateBackupCodes();
      await store.users.updateUser(user.id, { totpEnabled: true, backupCodeHashes: hashes });
      await ctx.registry.recordAudit('platform.mfa.enabled', { userId: user.id });
      if (setupTicket) {
        await ctx.sessionRevocations.del(`platform-mfa-setup:${setupTicket}`).catch(() => undefined);
        const fresh = await store.users.findById(user.id);
        if (!fresh) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
        const { token, cookie } = await issueSession(ctx, fresh, clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS));
        await ctx.registry.recordAudit('platform.login', { userId: user.id });
        return finish(200, ok({ user: expose(fresh), token, backupCodes: codes }, requestId), {
          'Set-Cookie': cookie,
        });
      }
      return finish(200, ok({ enabled: true, backupCodes: codes }, requestId));
    }

    if (url.pathname === '/api/v1/me/mfa/disable' && req.method === 'POST') {
      await mfaLimit();
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const parsed = parseBody(z.object({ code: z.string().min(4).max(32) }), await readJson());
      const user = await store.users.findById(session.sub);
      if (!user?.totpSecret || !user.totpEnabled) {
        throw new ApiError('CONFLICT', 'MFA is not enabled', 409);
      }
      if (!verifyTotp(user.totpSecret, parsed.code)) {
        throw new ApiError('UNAUTHORIZED', 'Incorrect authenticator code', 401);
      }
      await store.users.updateUser(user.id, {
        totpSecret: null,
        totpEnabled: false,
        backupCodeHashes: [],
      });
      await ctx.registry.recordAudit('platform.mfa.disabled', { userId: user.id });
      return finish(200, ok({ disabled: true }, requestId));
    }

    // ── Session & device management ──
    if (url.pathname === '/api/v1/me/sessions' && req.method === 'GET') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      const sessions = await listPlatformSessions(ctx, user.id, session.jti ?? null);
      return finish(200, ok({ sessions }, requestId));
    }

    if (url.pathname === '/api/v1/me/sessions/revoke-all' && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const revoked = await revokeOtherPlatformSessions(ctx, session.sub, session.jti ?? null);
      await ctx.registry.recordAudit('platform.sessions.revoked', { userId: session.sub });
      return finish(200, ok({ revoked }, requestId));
    }

    const sessionDeleteMatch = /^\/api\/v1\/me\/sessions\/([^/]+)\/?$/.exec(url.pathname);
    if (sessionDeleteMatch?.[1] && req.method === 'DELETE') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const targetJti = sessionDeleteMatch[1];
      const owned = await platformSessionOwnedBy(ctx, session.sub, targetJti);
      if (!owned) throw new ApiError('NOT_FOUND', 'Session not found', 404);
      await revokeSessionByJti(ctx, targetJti);
      await ctx.registry.recordAudit('platform.sessions.revoked', { userId: session.sub });
      return finish(200, ok({ revoked: true }, requestId));
    }

    // ── Email change (verified, unique, domain-policy aware) ──
    if (url.pathname === '/api/v1/me/email/request' && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const parsed = parseBody(
        z.object({ newEmail: z.string().email().max(320), currentPassword: z.string().min(1).max(128) }),
        await readJson(),
      );
      const user = await store.users.findById(session.sub);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      if (!(await verifyPassword(parsed.currentPassword, user.passwordHash))) {
        throw new ApiError('UNAUTHORIZED', 'Current password is incorrect', 401);
      }
      const newEmail = parsed.newEmail.toLowerCase();
      if (await store.users.findByEmail(newEmail)) {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
      const raw = `emc_${randomBytes(24).toString('base64url')}`;
      await ctx.sessionRevocations
        .set(
          `email-change:${createHash('sha256').update(raw).digest('hex')}`,
          JSON.stringify({ userId: user.id, newEmail }),
          900,
        )
        .catch(() => undefined);
      // No platform mailer exists: the token is returned once to the
      // authenticated requester (same pattern as invite tokens).
      return finish(200, ok({ changeToken: raw, newEmail }, requestId));
    }

    if (url.pathname === '/api/v1/me/email/confirm' && req.method === 'POST') {
      const parsed = parseBody(z.object({ token: z.string().min(10).max(200) }), await readJson());
      const ref = await ctx.sessionRevocations
        .get(`email-change:${createHash('sha256').update(parsed.token).digest('hex')}`)
        .catch(() => null);
      if (!ref) throw new ApiError('NOT_FOUND', 'Change request expired or invalid', 404);
      const { userId, newEmail } = JSON.parse(ref) as { userId: string; newEmail: string };
      const user = await store.users.findById(userId);
      if (!user) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      if (await store.users.findByEmail(newEmail)) {
        throw new ApiError('CONFLICT', 'Email already registered', 409);
      }
      // Domain policy: every member org with an allowlist must accept it.
      const memberships = await ctx.registry.membershipsFor(user.id);
      for (const m of memberships) {
        const policy = await store.policies.getPolicy(m.organizationId).catch(() => null);
        if (policy && !emailAllowedByPolicy(newEmail, policy)) {
          throw new ApiError('FORBIDDEN', 'Email domain not allowed by organization policy', 403);
        }
      }
      await renamePlatformEmail(ctx, store, user.id, newEmail);
      await ctx.sessionRevocations
        .del(`email-change:${createHash('sha256').update(parsed.token).digest('hex')}`)
        .catch(() => undefined);
      await ctx.registry.recordAudit('platform.email.changed', { userId: user.id });
      const fresh = await store.users.findById(user.id);
      if (!fresh) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      return finish(200, ok({ user: expose(fresh) }, requestId));
    }

    if (url.pathname === '/api/v1/me' && req.method === 'PATCH') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const parsed = parseBody(UpdateMeBody, await readJson());
      const updated = await store.users.updateUser(session.sub, {
        displayName: parsed.displayName,
      });
      if (!updated) throw new ApiError('UNAUTHORIZED', 'Unknown session', 401);
      await ctx.registry.recordAudit('platform.profile.updated', { userId: updated.id });
      return finish(200, ok({ user: expose(updated) }, requestId));
    }

    const orgInviteMatch = /^\/api\/v1\/organizations\/([^/]+)\/invites\/?$/.exec(url.pathname);
    if (orgInviteMatch?.[1] && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const orgId = orgInviteMatch[1];
      const memberships = await ctx.registry.membershipsFor(session.sub);
      const mine = memberships.find(m => m.organizationId === orgId);
      if (!mine || (mine.role !== 'owner' && mine.role !== 'admin')) {
        throw new ApiError('FORBIDDEN', 'Only org owners/admins can invite', 403);
      }
      const parsed = parseBody(InviteBody, await readJson());
      const role = parsed.role ?? 'member';
      if (!INVITE_ROLES.includes(role)) throw new ApiError('VALIDATION_ERROR', 'Bad role', 400);
      if (role === 'owner' && mine.role !== 'owner') {
        throw new ApiError('FORBIDDEN', 'Only owners can invite owners', 403);
      }
      // Organization email-domain policy applies at invite time.
      const policy = await store.policies.getPolicy(orgId).catch(() => null);
      if (policy && !emailAllowedByPolicy(parsed.email, policy)) {
        throw new ApiError('FORBIDDEN', 'Email domain not allowed by organization policy', 403);
      }
      const { raw: inviteToken, hash } = newInviteToken();
      const invite = await store.invites.create({
        organizationId: orgId,
        email: parsed.email,
        role,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        createdBy: session.sub,
      });
      await ctx.registry.recordAudit('org.invite.created', {
        organizationId: orgId,
        userId: session.sub,
      });
      return finish(201, ok({ invite, token: inviteToken }, requestId));
    }

    const inviteMatch = /^\/api\/v1\/invites\/([^/]+)\/?$/.exec(url.pathname);
    if (inviteMatch?.[1] && req.method === 'GET') {
      const invite = await store.invites.findByTokenHash(
        createHash('sha256').update(inviteMatch[1]).digest('hex'),
      );
      if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now()) {
        throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      }
      return finish(200, ok({ invite }, requestId));
    }

    const acceptMatch = /^\/api\/v1\/invites\/([^/]+)\/accept\/?$/.exec(url.pathname);
    if (acceptMatch?.[1] && req.method === 'POST') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const invite = await store.invites.findByTokenHash(
        createHash('sha256').update(acceptMatch[1]).digest('hex'),
      );
      if (!invite) throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      if (invite.acceptedAt) throw new ApiError('CONFLICT', 'Invite already accepted', 409);
      if (Date.parse(invite.expiresAt) <= Date.now())
        throw new ApiError('NOT_FOUND', 'Invite not found', 404);
      // Invites are addressed: only the account matching the invited email may
      // accept, so a leaked token cannot be used by an unrelated account.
      const accepter = await store.users.findById(session.sub);
      if (!accepter || accepter.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ApiError('FORBIDDEN', 'This invite was sent to a different email address', 403);
      }
      await ctx.registry.addMembership(invite.organizationId, session.sub, invite.role);
      await store.invites.markAccepted(invite.id);
      await ctx.registry.recordAudit('org.invite.accepted', {
        organizationId: invite.organizationId,
        userId: session.sub,
      });
      return finish(
        200,
        ok({ organizationId: invite.organizationId, role: invite.role }, requestId),
      );
    }

    // ── Organization security policy (owner/admin) ──
    const policyMatch = /^\/api\/v1\/organizations\/([^/]+)\/policy\/?$/.exec(url.pathname);
    if (policyMatch?.[1] && (req.method === 'GET' || req.method === 'PUT')) {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const orgId = policyMatch[1];
      const memberships = await ctx.registry.membershipsFor(session.sub);
      const mine = memberships.find(m => m.organizationId === orgId);
      if (!mine) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
      if (req.method === 'GET') {
        return finish(200, ok({ policy: await store.policies.getPolicy(orgId) }, requestId));
      }
      if (mine.role !== 'owner' && mine.role !== 'admin') {
        throw new ApiError('FORBIDDEN', 'Only org owners/admins can change policy', 403);
      }
      const parsed = parseBody(
        z.object({
          allowedEmailDomains: z.array(z.string().max(255)).max(20).optional(),
          requireMfa: z.boolean().optional(),
          passwordMinLength: z.number().int().min(8).max(64).nullable().optional(),
          passwordMinClasses: z.number().int().min(0).max(4).nullable().optional(),
          logRetentionDays: z.number().int().min(7).max(365).nullable().optional(),
        }),
        await readJson(),
      );
      const policy = await store.policies.setPolicy(orgId, {
        ...(parsed.allowedEmailDomains !== undefined
          ? { allowedEmailDomains: parsed.allowedEmailDomains }
          : {}),
        ...(parsed.requireMfa !== undefined ? { requireMfa: parsed.requireMfa } : {}),
        ...(parsed.passwordMinLength !== undefined
          ? { passwordMinLength: parsed.passwordMinLength }
          : {}),
        ...(parsed.passwordMinClasses !== undefined
          ? { passwordMinClasses: parsed.passwordMinClasses }
          : {}),
        ...(parsed.logRetentionDays !== undefined
          ? { logRetentionDays: parsed.logRetentionDays }
          : {}),
      });
      await ctx.registry.recordAudit('org.policy.updated', {
        organizationId: orgId,
        userId: session.sub,
      });
      return finish(200, ok({ policy }, requestId));
    }

    // ── SSO connections (OIDC metadata; secrets encrypted, never listed) ──
    if (url.pathname === '/api/v1/auth/sso/providers' && req.method === 'GET') {
      // Public: the login page needs the list before anyone has a session,
      // and it carries no tenant data — only provider setup metadata.
      return finish(200, ok({ providers: SSO_PRESETS, callbackUrl: ssoCallbackUrl(ctx, req) }, requestId));
    }

    const ssoListMatch = /^\/api\/v1\/organizations\/([^/]+)\/sso\/?$/.exec(url.pathname);
    if (ssoListMatch?.[1] && (req.method === 'GET' || req.method === 'POST')) {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const orgId = ssoListMatch[1];
      const memberships = await ctx.registry.membershipsFor(session.sub);
      const mine = memberships.find(m => m.organizationId === orgId);
      if (!mine) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
      if (req.method === 'GET') {
        return finish(200, ok({ connections: await store.sso.list(orgId) }, requestId));
      }
      if (mine.role !== 'owner' && mine.role !== 'admin') {
        throw new ApiError('FORBIDDEN', 'Only org owners/admins can configure SSO', 403);
      }
      const parsed = parseBody(
        z
          .object({
            issuer: z.string().url().max(500).optional(),
            /** Provider preset plus its tenant value, as an alternative to a raw issuer. */
            provider: z.string().max(40).optional(),
            tenant: z.string().max(200).optional(),
            clientId: z.string().min(1).max(500),
            clientSecret: z.string().min(1).max(2000),
            displayName: z.string().min(1).max(120).optional(),
            defaultRole: z.enum(['member', 'viewer', 'admin']).default('member'),
          })
          .refine(v => Boolean(v.issuer) || Boolean(v.provider), {
            message: 'Provide an issuer, or a provider preset with its tenant',
          }),
        await readJson(),
      );
      // A preset builds the issuer through the same helper the tests cover,
      // so the console and the API cannot drift into different URLs.
      const presetIssuer = parsed.provider
        ? ssoIssuerFor(parsed.provider, parsed.tenant ?? '')
        : null;
      const issuerInput = parsed.issuer ?? presetIssuer;
      if (!issuerInput) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Could not build an issuer for that provider — check the tenant value',
          400,
        );
      }
      // Discovery validates the issuer NOW (misconfiguration fails fast,
      // never a broken connection row).
      const discovery = await discoverOidc(issuerInput).catch((err: unknown) => {
        throw new ApiError(
          'SSO_DISCOVERY_FAILED',
          err instanceof Error ? err.message : 'Provider discovery failed',
          400,
        );
      });
      const connection = await store.sso.create({
        organizationId: orgId,
        provider: parsed.provider ?? 'oidc',
        displayName: parsed.displayName ?? new URL(discovery.issuer).hostname ?? 'SSO',
        issuer: discovery.issuer,
        clientId: parsed.clientId,
        clientSecretEnc: encryptSecret(parsed.clientSecret, ctx.config.JWT_SECRET),
        defaultRole: parsed.defaultRole ?? 'member',
      });
      await ctx.registry.recordAudit('org.sso.created', {
        organizationId: orgId,
        userId: session.sub,
      });
      return finish(201, ok({ connection }, requestId));
    }

    const ssoDeleteMatch = /^\/api\/v1\/organizations\/([^/]+)\/sso\/([^/]+)\/?$/.exec(url.pathname);
    if (ssoDeleteMatch?.[1] && ssoDeleteMatch[2] && req.method === 'DELETE') {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
      const session = await verifyPlatformSession(ctx, token);
      const orgId = ssoDeleteMatch[1];
      const connId = ssoDeleteMatch[2];
      const memberships = await ctx.registry.membershipsFor(session.sub);
      const mine = memberships.find(m => m.organizationId === orgId);
      if (!mine || (mine.role !== 'owner' && mine.role !== 'admin')) {
        throw new ApiError('FORBIDDEN', 'Only org owners/admins can configure SSO', 403);
      }
      const conn = await store.sso.findById(connId);
      if (!conn || conn.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'SSO connection not found', 404);
      }
      await store.sso.remove(connId);
      await ctx.registry.recordAudit('org.sso.deleted', {
        organizationId: orgId,
        userId: session.sub,
      });
      return finish(200, ok({ deleted: true }, requestId));
    }

    // ── SSO login flow (per-organization slug) ──
    const ssoStartMatch = /^\/api\/v1\/auth\/sso\/([^/]+)\/start\/?$/.exec(url.pathname);
    if (ssoStartMatch?.[1] && req.method === 'GET') {
      await strictLimit();
      const orgSlug = ssoStartMatch[1];
      const org = await ctx.registry.getOrganizationBySlug(orgSlug).catch(() => null);
      if (!org) throw new ApiError('NOT_FOUND', 'Organization not found', 404);
      const connections = (await store.sso.list(org.id)).filter(c => c.enabled);
      const connection = connections[0];
      if (!connection) throw new ApiError('NOT_FOUND', 'SSO is not configured', 404);
      const discovery = await discoverOidc(connection.issuer).catch(() => null);
      if (!discovery) throw new ApiError('SSO_UNAVAILABLE', 'Identity provider is unreachable', 503);
      const { verifier, challenge } = pkcePair();
      const state = `sso_${randomBytes(18).toString('base64url')}`;
      const nonce = randomBytes(16).toString('base64url');
      const redirectUri = ssoCallbackUrl(ctx, req);
      await ctx.sessionRevocations
        .set(
          `sso-state:${state}`,
          JSON.stringify({
            connectionId: connection.id,
            organizationId: org.id,
            nonce,
            codeVerifier: verifier,
            redirectUri,
          }),
          600,
        )
        .catch(() => undefined);
      const authorizeUrl = buildAuthorizeUrl({
        discovery,
        clientId: connection.clientId,
        redirectUri,
        state,
        nonce,
        codeChallenge: challenge,
      });
      return finish(
        200,
        ok({ authorizeUrl, connection: { id: connection.id, displayName: connection.displayName } }, requestId),
      );
    }

    if (url.pathname === '/api/v1/auth/sso/callback' && req.method === 'GET') {
      await strictLimit();
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) throw new ApiError('VALIDATION_ERROR', 'Missing code or state', 400);
      const ref = await ctx.sessionRevocations.get(`sso-state:${state}`).catch(() => null);
      if (!ref) throw new ApiError('UNAUTHORIZED', 'Login session expired — start again', 401);
      await ctx.sessionRevocations.del(`sso-state:${state}`).catch(() => undefined);
      const { connectionId, organizationId, nonce, codeVerifier, redirectUri } = JSON.parse(ref) as {
        connectionId: string;
        organizationId: string;
        nonce: string;
        codeVerifier: string;
        redirectUri: string;
      };
      const connection = await store.sso.findById(connectionId);
      if (!connection || !connection.enabled || connection.organizationId !== organizationId) {
        throw new ApiError('NOT_FOUND', 'SSO is not configured', 404);
      }
      const discovery = await discoverOidc(connection.issuer).catch(() => null);
      if (!discovery) throw new ApiError('SSO_UNAVAILABLE', 'Identity provider is unreachable', 503);
      let clientSecret: string;
      try {
        clientSecret = decryptSecret(connection.clientSecretEnc, ctx.config.JWT_SECRET);
      } catch {
        throw new ApiError('SSO_MISCONFIGURED', 'SSO secret unreadable — re-enter credentials', 500);
      }
      const { idToken } = await exchangeOidcCode({
        discovery,
        clientId: connection.clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier,
      }).catch((err: unknown) => {
        throw new ApiError('SSO_FAILED', err instanceof Error ? err.message : 'SSO failed', 401);
      });
      const profile = await verifyOidcIdToken({
        discovery,
        clientId: connection.clientId,
        idToken,
        nonce,
      }).catch((err: unknown) => {
        throw new ApiError('SSO_FAILED', err instanceof Error ? err.message : 'SSO failed', 401);
      });
      if (!profile.email) {
        throw new ApiError('SSO_NO_EMAIL', 'Identity provider did not release an email address', 400);
      }
      const policy = await store.policies.getPolicy(organizationId).catch(() => null);
      if (policy && !emailAllowedByPolicy(profile.email, policy)) {
        throw new ApiError('FORBIDDEN', 'Email domain not allowed by organization policy', 403);
      }
      let user = await store.users.findByEmail(profile.email);
      if (!user) {
        user = await store.users.createUser({
          email: profile.email,
          // Unusable password marker (never scrypt-shaped ⇒ never verifies).
          passwordHash: `sso:${connection.id}:${profile.sub}`.slice(0, 120),
          displayName: profile.name,
        });
        await ctx.registry.recordAudit('platform.signup', { userId: user.id });
      }
      const role = connection.defaultRole === 'owner' ? 'member' : connection.defaultRole;
      try {
        await ctx.registry.addMembership(organizationId, user.id, role);
      } catch {
        // Already a member (possibly higher role) — never downgrade.
      }
      if (user.totpEnabled && user.totpSecret) {
        const ticket = `pmfa_${randomBytes(24).toString('base64url')}`;
        await ctx.sessionRevocations.set(`platform-mfa:${ticket}`, user.id, 300).catch(() => undefined);
        return finish(200, ok({ mfaRequired: true, mfaTicket: ticket }, requestId));
      }
      if (policy?.requireMfa && !user.totpEnabled) {
        const ticket = `psetup_${randomBytes(24).toString('base64url')}`;
        await ctx.sessionRevocations.set(`platform-mfa-setup:${ticket}`, user.id, 600).catch(() => undefined);
        return finish(200, ok({ mfaSetupRequired: true, setupTicket: ticket }, requestId));
      }
      const { token, cookie } = await issueSession(ctx, user, clientMeta(req, ctx.config.TRUSTED_PROXY_HOPS));
      await ctx.registry.recordAudit('platform.login', { userId: user.id });
      return finish(200, ok({ user: expose(user), token }, requestId), { 'Set-Cookie': cookie });
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}
