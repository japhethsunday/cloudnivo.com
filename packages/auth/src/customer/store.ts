import { randomUUID } from 'node:crypto';
import type { CustomerSession, CustomerUser, OneTimeToken } from './types.js';

/**
 * Per-project customer auth storage. Memory adapter = dev/test namespaces
 * keyed by projectId (isolated by construction). Postgres adapter =
 * per-project `auth` schema (see pg-store.ts). Same interface, no caller
 * changes — and Project B's adapter can never see Project A's rows.
 */

export interface CustomerAuthStore {
  createUser(input: {
    projectId: string;
    email: string;
    passwordHash: string | null;
    userMetadata: Record<string, unknown>;
  }): Promise<CustomerUser>;
  findUserByEmail(projectId: string, email: string): Promise<CustomerUser | null>;
  findUserById(projectId: string, userId: string): Promise<CustomerUser | null>;
  updateUser(
    projectId: string,
    userId: string,
    patch: Partial<
      Pick<
        CustomerUser,
        | 'emailVerified'
        | 'phoneVerified'
        | 'status'
        | 'userMetadata'
        | 'appMetadata'
        | 'passwordHash'
        | 'lastSignInAt'
      >
    >,
  ): Promise<CustomerUser | null>;
  deleteUser(projectId: string, userId: string): Promise<boolean>;
  listUsers(projectId: string): Promise<CustomerUser[]>;
  createSession(
    session: Omit<CustomerSession, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomerSession>;
  findSession(projectId: string, sessionId: string): Promise<CustomerSession | null>;
  findSessionByRefreshHash(projectId: string, hash: string): Promise<CustomerSession | null>;
  touchSession(projectId: string, sessionId: string, refreshTokenHash: string): Promise<void>;
  markRefreshUsed(projectId: string, sessionId: string, oldHash: string): Promise<void>;
  revokeSession(projectId: string, sessionId: string): Promise<boolean>;
  revokeUserSessions(projectId: string, userId: string): Promise<number>;
  listSessions(projectId: string, userId: string): Promise<CustomerSession[]>;
  saveToken(token: Omit<OneTimeToken, 'createdAt'>): Promise<void>;
  findToken(
    projectId: string,
    hash: string,
    kind: 'verify' | 'reset',
  ): Promise<OneTimeToken | null>;
  consumeToken(projectId: string, hash: string): Promise<boolean>;
  deleteUserTokens(projectId: string, userId: string): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

export class MemoryCustomerAuthStore implements CustomerAuthStore {
  private readonly users = new Map<string, CustomerUser>();
  private readonly sessions = new Map<string, CustomerSession>();
  private readonly tokens = new Map<string, OneTimeToken>();

  private userKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  async createUser(input: {
    projectId: string;
    email: string;
    passwordHash: string | null;
    userMetadata: Record<string, unknown>;
  }): Promise<CustomerUser> {
    const email = input.email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.projectId === input.projectId && u.email === email && u.status !== 'deleted') {
        const err = new Error('Email already registered') as Error & { code: string };
        err.code = 'EMAIL_TAKEN';
        throw err;
      }
    }
    const user: CustomerUser = {
      id: randomUUID(),
      projectId: input.projectId,
      email,
      phone: null,
      passwordHash: input.passwordHash,
      emailVerified: false,
      phoneVerified: false,
      status: 'active',
      userMetadata: input.userMetadata,
      appMetadata: { role: 'authenticated' },
      createdAt: now(),
      updatedAt: now(),
      lastSignInAt: null,
    };
    this.users.set(this.userKey(input.projectId, user.id), user);
    return { ...user };
  }

  async findUserByEmail(projectId: string, email: string): Promise<CustomerUser | null> {
    const needle = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.projectId === projectId && u.email === needle && u.status !== 'deleted') {
        return { ...u };
      }
    }
    return null;
  }

  async findUserById(projectId: string, userId: string): Promise<CustomerUser | null> {
    const u = this.users.get(this.userKey(projectId, userId));
    if (!u || u.status === 'deleted') return null;
    return { ...u };
  }

  async updateUser(
    projectId: string,
    userId: string,
    patch: Partial<CustomerUser>,
  ): Promise<CustomerUser | null> {
    const u = this.users.get(this.userKey(projectId, userId));
    if (!u || u.status === 'deleted') return null;
    const next = { ...u, ...patch, id: u.id, projectId: u.projectId, updatedAt: now() };
    this.users.set(this.userKey(projectId, userId), next);
    return { ...next };
  }

  async deleteUser(projectId: string, userId: string): Promise<boolean> {
    const u = this.users.get(this.userKey(projectId, userId));
    if (!u || u.status === 'deleted') return false;
    this.users.set(this.userKey(projectId, userId), { ...u, status: 'deleted', updatedAt: now() });
    return true;
  }

  async listUsers(projectId: string): Promise<CustomerUser[]> {
    return [...this.users.values()]
      .filter(u => u.projectId === projectId && u.status !== 'deleted')
      .map(u => ({ ...u }));
  }

  async createSession(
    session: Omit<CustomerSession, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<CustomerSession> {
    const full: CustomerSession = {
      ...session,
      id: randomUUID(),
      usedRefreshHashes: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.sessions.set(`${session.projectId}:${full.id}`, full);
    return { ...full };
  }

  async findSession(projectId: string, sessionId: string): Promise<CustomerSession | null> {
    const s = this.sessions.get(`${projectId}:${sessionId}`);
    return s ? { ...s, usedRefreshHashes: [...s.usedRefreshHashes] } : null;
  }

  async findSessionByRefreshHash(projectId: string, hash: string): Promise<CustomerSession | null> {
    for (const s of this.sessions.values()) {
      if (
        s.projectId === projectId &&
        (s.refreshTokenHash === hash || s.usedRefreshHashes.includes(hash))
      ) {
        return { ...s, usedRefreshHashes: [...s.usedRefreshHashes] };
      }
    }
    return null;
  }

  async touchSession(
    projectId: string,
    sessionId: string,
    refreshTokenHash: string,
  ): Promise<void> {
    const s = this.sessions.get(`${projectId}:${sessionId}`);
    if (!s) return;
    this.sessions.set(`${projectId}:${sessionId}`, {
      ...s,
      refreshTokenHash,
      lastActiveAt: now(),
      updatedAt: now(),
    });
  }

  async markRefreshUsed(projectId: string, sessionId: string, oldHash: string): Promise<void> {
    const s = this.sessions.get(`${projectId}:${sessionId}`);
    if (!s) return;
    this.sessions.set(`${projectId}:${sessionId}`, {
      ...s,
      usedRefreshHashes: [...s.usedRefreshHashes, oldHash].slice(-10),
      updatedAt: now(),
    });
  }

  async revokeSession(projectId: string, sessionId: string): Promise<boolean> {
    const s = this.sessions.get(`${projectId}:${sessionId}`);
    if (!s || s.revokedAt) return false;
    this.sessions.set(`${projectId}:${sessionId}`, { ...s, revokedAt: now() });
    return true;
  }

  async revokeUserSessions(projectId: string, userId: string): Promise<number> {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.projectId === projectId && s.userId === userId && !s.revokedAt) {
        this.sessions.set(k, { ...s, revokedAt: now() });
        n += 1;
      }
    }
    return n;
  }

  async listSessions(projectId: string, userId: string): Promise<CustomerSession[]> {
    return [...this.sessions.values()]
      .filter(s => s.projectId === projectId && s.userId === userId && !s.revokedAt)
      .map(s => ({ ...s, refreshTokenHash: '', usedRefreshHashes: [] }));
  }

  async saveToken(token: Omit<OneTimeToken, 'createdAt'>): Promise<void> {
    this.tokens.set(`${token.projectId}:${token.tokenHash}`, { ...token, createdAt: now() });
  }

  async findToken(
    projectId: string,
    hash: string,
    kind: 'verify' | 'reset',
  ): Promise<OneTimeToken | null> {
    const t = this.tokens.get(`${projectId}:${hash}`);
    if (!t || t.kind !== kind || t.consumedAt) return null;
    if (Date.parse(t.expiresAt) <= Date.now()) return null;
    return { ...t };
  }

  async consumeToken(projectId: string, hash: string): Promise<boolean> {
    const t = this.tokens.get(`${projectId}:${hash}`);
    if (!t || t.consumedAt) return false;
    this.tokens.set(`${projectId}:${hash}`, { ...t, consumedAt: now() });
    return true;
  }

  async deleteUserTokens(projectId: string, userId: string): Promise<void> {
    for (const [k, t] of this.tokens) {
      if (t.projectId === projectId && t.userId === userId) this.tokens.delete(k);
    }
  }
}
