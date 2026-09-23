/**
 * Postgres-backed customer auth storage: per-project isolated `auth` schema
 * inside the CUSTOMER project database (never the control plane).
 *
 * Operates through an injected `PgRunner` so it works under any
 * `DatabaseProvisioner` (Docker today, Railway/VPS later) with zero changes.
 * `ensureAuthSchema()` is idempotent — safe to run on every boot/enable.
 */

import type {
  CustomerSession,
  CustomerUser,
  OneTimeToken,
  PasskeyChallenge,
  PasskeyCredential,
} from './types.js';

export interface PgRunner {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

export const AUTH_SCHEMA_DDL = `
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email citext NOT NULL,
  phone text,
  password_hash text,
  email_verified boolean NOT NULL DEFAULT false,
  phone_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  user_metadata jsonb NOT NULL DEFAULT '{}',
  app_metadata jsonb NOT NULL DEFAULT '{"role":"authenticated"}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_unique
  ON auth.users (email) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS auth_users_updated_idx ON auth.users (updated_at);

CREATE TABLE IF NOT EXISTS auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  used_refresh_hashes text[] NOT NULL DEFAULT '{}',
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth.sessions (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify', 'reset')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth.one_time_tokens (user_id);

-- Idempotent evolution for MFA / anonymous / magic-link / phone-OTP.
-- IF NOT EXISTS keeps this safe to run on every boot/enable, including
-- databases created before these columns existed.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS backup_code_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE auth.one_time_tokens DROP CONSTRAINT IF EXISTS one_time_tokens_kind_check;
ALTER TABLE auth.one_time_tokens ADD CONSTRAINT one_time_tokens_kind_check
  CHECK (kind IN ('verify', 'reset', 'magic', 'mfa'));

-- Passkeys (WebAuthn). The public key is not a secret, but the credential id
-- is an identifier an attacker could enumerate users with, so neither is ever
-- returned to an unauthenticated caller.
CREATE TABLE IF NOT EXISTS auth.passkeys (
  credential_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  public_key text NOT NULL,
  algorithm integer NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  aaguid text,
  fmt text NOT NULL DEFAULT 'none',
  label text,
  backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_passkeys_user_idx ON auth.passkeys (user_id);

-- A challenge is single-use and short-lived: storing it server-side is what
-- stops an assertion being replayed, so it cannot live in a cookie or be
-- echoed back by the client.
CREATE TABLE IF NOT EXISTS auth.passkey_challenges (
  challenge text PRIMARY KEY,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('register', 'authenticate')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_passkey_challenges_expiry_idx
  ON auth.passkey_challenges (expires_at);
`.trim();

/** Split DDL into single statements (no `;` inside literals here by construction). */
export function splitDdl(ddl: string): string[] {
  return ddl
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

export async function ensureAuthSchema(run: PgRunner): Promise<string[]> {
  const applied: string[] = [];
  for (const stmt of splitDdl(AUTH_SCHEMA_DDL)) {
    await run.query(stmt, []);
    applied.push(stmt.slice(0, 60));
  }
  return applied;
}

function rowToUser(r: Record<string, unknown>): CustomerUser {
  return {
    id: String(r['id']),
    projectId: '',
    email: String(r['email']),
    phone: (r['phone'] as string | null) ?? null,
    passwordHash: (r['password_hash'] as string | null) ?? null,
    emailVerified: r['email_verified'] === true,
    phoneVerified: r['phone_verified'] === true,
    status: (r['status'] as 'active' | 'disabled' | 'deleted') ?? 'active',
    isAnonymous: r['is_anonymous'] === true,
    totpSecret: (r['totp_secret'] as string | null) ?? null,
    totpEnabled: r['totp_enabled'] === true,
    backupCodeHashes: Array.isArray(r['backup_code_hashes'])
      ? (r['backup_code_hashes'] as string[]).map(String)
      : [],
    userMetadata: (r['user_metadata'] as Record<string, unknown>) ?? {},
    appMetadata: (r['app_metadata'] as Record<string, unknown>) ?? {},
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
    lastSignInAt: r['last_sign_in_at'] ? String(r['last_sign_in_at']) : null,
  };
}

function rowToSession(r: Record<string, unknown>, projectId: string): CustomerSession {
  return {
    id: String(r['id']),
    userId: String(r['user_id']),
    projectId,
    refreshTokenHash: String(r['refresh_token_hash']),
    usedRefreshHashes: (r['used_refresh_hashes'] as string[]) ?? [],
    ipAddress: (r['ip_address'] as string | null) ?? null,
    userAgent: (r['user_agent'] as string | null) ?? null,
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
    expiresAt: String(r['expires_at']),
    lastActiveAt: String(r['last_active_at']),
    revokedAt: r['revoked_at'] ? String(r['revoked_at']) : null,
  };
}

export class PostgresCustomerAuthStore {
  constructor(
    private readonly run: PgRunner,
    private readonly projectId: string,
  ) {}

  private withProject<T extends { projectId?: string }>(row: T): T {
    return { ...row, projectId: this.projectId };
  }

  async createUser(input: {
    email: string;
    passwordHash: string | null;
    userMetadata: Record<string, unknown>;
    isAnonymous?: boolean;
    phone?: string | null;
  }): Promise<CustomerUser> {
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    try {
      const rows = await this.run.query(
        `INSERT INTO auth.users (id, email, password_hash, user_metadata, is_anonymous, phone)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          id,
          input.email.toLowerCase(),
          input.passwordHash,
          JSON.stringify(input.userMetadata),
          input.isAnonymous ?? false,
          input.phone ?? null,
        ],
      );
      return this.withProject(rowToUser(rows[0] as Record<string, unknown>));
    } catch (err) {
      if (/duplicate|unique/i.test(err instanceof Error ? err.message : '')) {
        const taken = new Error('Email already registered') as Error & { code: string };
        taken.code = 'EMAIL_TAKEN';
        throw taken;
      }
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<CustomerUser | null> {
    const rows = await this.run.query(
      `SELECT * FROM auth.users WHERE email = $1 AND status <> 'deleted'`,
      [email.toLowerCase()],
    );
    const row = rows[0];
    return row ? this.withProject(rowToUser(row)) : null;
  }

  async findUserById(userId: string): Promise<CustomerUser | null> {
    const rows = await this.run.query(
      `SELECT * FROM auth.users WHERE id = $1 AND status <> 'deleted'`,
      [userId],
    );
    const row = rows[0];
    return row ? this.withProject(rowToUser(row)) : null;
  }

  async findUserByPhone(phone: string): Promise<CustomerUser | null> {
    const rows = await this.run.query(
      `SELECT * FROM auth.users WHERE phone = $1 AND status <> 'deleted'`,
      [phone],
    );
    const row = rows[0];
    return row ? this.withProject(rowToUser(row)) : null;
  }

  async updateUser(userId: string, patch: Record<string, unknown>): Promise<CustomerUser | null> {
    const allowed = [
      'email',
      'phone',
      'emailVerified',
      'phoneVerified',
      'status',
      'userMetadata',
      'appMetadata',
      'passwordHash',
      'lastSignInAt',
      'isAnonymous',
      'totpSecret',
      'totpEnabled',
      'backupCodeHashes',
    ] as const;
    const colOf: Record<string, string> = {
      email: 'email',
      phone: 'phone',
      emailVerified: 'email_verified',
      phoneVerified: 'phone_verified',
      status: 'status',
      userMetadata: 'user_metadata',
      appMetadata: 'app_metadata',
      passwordHash: 'password_hash',
      lastSignInAt: 'last_sign_in_at',
      isAnonymous: 'is_anonymous',
      totpSecret: 'totp_secret',
      totpEnabled: 'totp_enabled',
      backupCodeHashes: 'backup_code_hashes',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        const value =
          key === 'userMetadata' || key === 'appMetadata'
            ? JSON.stringify(patch[key])
            : key === 'backupCodeHashes'
              ? (patch[key] as string[])
              : key === 'email' && typeof patch[key] === 'string'
                ? (patch[key] as string).toLowerCase()
                : (patch[key] as unknown);
        params.push(value);
        sets.push(`"${colOf[key]}" = $${params.length}`);
      }
    }
    if (sets.length === 0) return this.findUserById(userId);
    sets.push('updated_at = now()');
    const rows = await this.run.query(
      `UPDATE auth.users SET ${sets.join(', ')} WHERE id = $${params.length + 1} AND status <> 'deleted' RETURNING *`,
      [...params, userId],
    );
    const row = rows[0];
    return row ? this.withProject(rowToUser(row)) : null;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const rows = await this.run.query(
      `UPDATE auth.users SET status = 'deleted', updated_at = now()
       WHERE id = $1 AND status <> 'deleted' RETURNING id`,
      [userId],
    );
    return rows.length > 0;
  }

  async listUsers(): Promise<CustomerUser[]> {
    const rows = await this.run.query(
      `SELECT * FROM auth.users WHERE status <> 'deleted' ORDER BY created_at DESC LIMIT 500`,
      [],
    );
    return rows.map(r => this.withProject(rowToUser(r)));
  }

  async createSession(input: {
    userId: string;
    refreshTokenHash: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<CustomerSession> {
    const { randomUUID } = await import('node:crypto');
    const rows = await this.run.query(
      `INSERT INTO auth.sessions (id, user_id, refresh_token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.refreshTokenHash,
        input.expiresAt,
        input.ipAddress,
        input.userAgent,
      ],
    );
    return rowToSession(rows[0] as Record<string, unknown>, this.projectId);
  }

  async findSession(sessionId: string): Promise<CustomerSession | null> {
    const rows = await this.run.query(`SELECT * FROM auth.sessions WHERE id = $1`, [sessionId]);
    const row = rows[0];
    return row ? rowToSession(row, this.projectId) : null;
  }

  async findSessionByRefreshHash(hash: string): Promise<CustomerSession | null> {
    const rows = await this.run.query(
      `SELECT * FROM auth.sessions WHERE refresh_token_hash = $1 OR $1 = ANY (used_refresh_hashes)`,
      [hash],
    );
    const row = rows[0];
    return row ? rowToSession(row, this.projectId) : null;
  }

  async touchSession(sessionId: string, refreshTokenHash: string): Promise<void> {
    await this.run.query(
      `UPDATE auth.sessions SET refresh_token_hash = $1, last_active_at = now(), updated_at = now() WHERE id = $2`,
      [refreshTokenHash, sessionId],
    );
  }

  async markRefreshUsed(sessionId: string, oldHash: string): Promise<void> {
    await this.run.query(
      `UPDATE auth.sessions
       SET used_refresh_hashes = CASE
             WHEN cardinality(used_refresh_hashes) >= 20
             THEN used_refresh_hashes[2:20] || $1::text
             ELSE used_refresh_hashes || $1::text
           END,
           updated_at = now() WHERE id = $2`,
      [oldHash, sessionId],
    );
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const rows = await this.run.query(
      `UPDATE auth.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [sessionId],
    );
    return rows.length > 0;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const rows = await this.run.query(
      `UPDATE auth.sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId],
    );
    return rows.length;
  }

  async listSessions(userId: string): Promise<CustomerSession[]> {
    const rows = await this.run.query(
      `SELECT id, user_id, '' AS refresh_token_hash, '{}' AS used_refresh_hashes,
              ip_address, user_agent, created_at, updated_at, expires_at, last_active_at, revoked_at
       FROM auth.sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(r => rowToSession(r, this.projectId));
  }

  async saveToken(input: {
    tokenHash: string;
    userId: string;
    kind: 'verify' | 'reset' | 'magic' | 'mfa';
    expiresAt: string;
  }): Promise<void> {
    await this.run.query(
      `INSERT INTO auth.one_time_tokens (token_hash, user_id, kind, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [input.tokenHash, input.userId, input.kind, input.expiresAt],
    );
  }

  async findToken(
    hash: string,
    kind: 'verify' | 'reset' | 'magic' | 'mfa',
  ): Promise<OneTimeToken | null> {
    const rows = await this.run.query(
      `SELECT * FROM auth.one_time_tokens
       WHERE token_hash = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()`,
      [hash, kind],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      tokenHash: String(r['token_hash']),
      userId: String(r['user_id']),
      projectId: this.projectId,
      kind,
      expiresAt: String(r['expires_at']),
      consumedAt: null,
      createdAt: String(r['created_at']),
    };
  }

  async consumeToken(hash: string): Promise<boolean> {
    const rows = await this.run.query(
      `UPDATE auth.one_time_tokens SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL RETURNING token_hash`,
      [hash],
    );
    return rows.length > 0;
  }

  async deleteUserTokens(userId: string): Promise<void> {
    await this.run.query(`DELETE FROM auth.one_time_tokens WHERE user_id = $1`, [userId]);
  }

  // ── Passkeys ──

  async savePasskey(cred: Omit<PasskeyCredential, 'projectId'>): Promise<void> {
    await this.run.query(
      `INSERT INTO auth.passkeys
         (credential_id, user_id, public_key, algorithm, sign_count, aaguid, fmt, label, backed_up)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (credential_id) DO NOTHING`,
      [
        cred.credentialId,
        cred.userId,
        cred.publicKey,
        cred.algorithm,
        cred.signCount,
        cred.aaguid,
        cred.fmt,
        cred.label,
        cred.backedUp,
      ],
    );
  }

  async findPasskey(credentialId: string): Promise<PasskeyCredential | null> {
    const [r] = await this.run.query(`SELECT * FROM auth.passkeys WHERE credential_id = $1`, [
      credentialId,
    ]);
    return r ? this.rowToPasskey(r) : null;
  }

  async listPasskeys(userId: string): Promise<PasskeyCredential[]> {
    const rows = await this.run.query(
      `SELECT * FROM auth.passkeys WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(r => this.rowToPasskey(r));
  }

  async touchPasskey(credentialId: string, signCount: number): Promise<void> {
    await this.run.query(
      `UPDATE auth.passkeys SET sign_count = $2, last_used_at = now() WHERE credential_id = $1`,
      [credentialId, signCount],
    );
  }

  async deletePasskey(userId: string, credentialId: string): Promise<boolean> {
    // user_id is in the WHERE clause, not checked afterwards: one user must
    // not be able to delete another's credential by knowing its id.
    const rows = await this.run.query(
      `DELETE FROM auth.passkeys WHERE credential_id = $1 AND user_id = $2 RETURNING credential_id`,
      [credentialId, userId],
    );
    return rows.length > 0;
  }

  async savePasskeyChallenge(challenge: Omit<PasskeyChallenge, 'projectId'>): Promise<void> {
    await this.run.query(
      `INSERT INTO auth.passkey_challenges (challenge, user_id, kind, expires_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (challenge) DO NOTHING`,
      [challenge.challenge, challenge.userId, challenge.kind, challenge.expiresAt],
    );
  }

  async consumePasskeyChallenge(
    challenge: string,
    kind: 'register' | 'authenticate',
  ): Promise<PasskeyChallenge | null> {
    /**
     * DELETE ... RETURNING makes read-and-spend one atomic statement. A
     * SELECT followed by a DELETE would let two concurrent requests both
     * observe the same live challenge and both succeed — which is exactly
     * the replay the challenge exists to prevent.
     */
    const [r] = await this.run.query(
      `DELETE FROM auth.passkey_challenges
         WHERE challenge = $1 AND kind = $2 AND expires_at > now()
       RETURNING challenge, user_id, kind, expires_at`,
      [challenge, kind],
    );
    if (!r) return null;
    return {
      projectId: this.projectId,
      challenge: String(r['challenge']),
      userId: r['user_id'] ? String(r['user_id']) : null,
      kind: String(r['kind']) as 'register' | 'authenticate',
      expiresAt: String(r['expires_at']),
    };
  }

  /** Also prunes expired challenges; called opportunistically. */
  async purgeExpiredChallenges(): Promise<number> {
    const rows = await this.run.query(
      `DELETE FROM auth.passkey_challenges WHERE expires_at <= now() RETURNING challenge`,
      [],
    );
    return rows.length;
  }

  private rowToPasskey(r: Record<string, unknown>): PasskeyCredential {
    return {
      projectId: this.projectId,
      credentialId: String(r['credential_id']),
      userId: String(r['user_id']),
      publicKey: String(r['public_key']),
      algorithm: Number(r['algorithm']),
      signCount: Number(r['sign_count']),
      aaguid: r['aaguid'] ? String(r['aaguid']) : null,
      fmt: String(r['fmt']),
      label: r['label'] ? String(r['label']) : null,
      backedUp: Boolean(r['backed_up']),
      createdAt: String(r['created_at']),
      lastUsedAt: r['last_used_at'] ? String(r['last_used_at']) : null,
    };
  }
}
