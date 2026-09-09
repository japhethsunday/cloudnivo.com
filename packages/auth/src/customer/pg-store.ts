/**
 * Postgres-backed customer auth storage: per-project isolated `auth` schema
 * inside the CUSTOMER project database (never the control plane).
 *
 * Operates through an injected `PgRunner` so it works under any
 * `DatabaseProvisioner` (Docker today, Railway/VPS later) with zero changes.
 * `ensureAuthSchema()` is idempotent — safe to run on every boot/enable.
 */

import type { CustomerSession, CustomerUser, OneTimeToken } from './types.js';

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
  }): Promise<CustomerUser> {
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    try {
      const rows = await this.run.query(
        `INSERT INTO auth.users (id, email, password_hash, user_metadata)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, input.email.toLowerCase(), input.passwordHash, JSON.stringify(input.userMetadata)],
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

  async updateUser(userId: string, patch: Record<string, unknown>): Promise<CustomerUser | null> {
    const allowed = [
      'emailVerified',
      'phoneVerified',
      'status',
      'userMetadata',
      'appMetadata',
      'passwordHash',
      'lastSignInAt',
    ] as const;
    const colOf: Record<string, string> = {
      emailVerified: 'email_verified',
      phoneVerified: 'phone_verified',
      status: 'status',
      userMetadata: 'user_metadata',
      appMetadata: 'app_metadata',
      passwordHash: 'password_hash',
      lastSignInAt: 'last_sign_in_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        params.push(
          key === 'userMetadata' || key === 'appMetadata'
            ? JSON.stringify(patch[key])
            : (patch[key] as unknown),
        );
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
    kind: 'verify' | 'reset';
    expiresAt: string;
  }): Promise<void> {
    await this.run.query(
      `INSERT INTO auth.one_time_tokens (token_hash, user_id, kind, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [input.tokenHash, input.userId, input.kind, input.expiresAt],
    );
  }

  async findToken(hash: string, kind: 'verify' | 'reset'): Promise<OneTimeToken | null> {
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
}
