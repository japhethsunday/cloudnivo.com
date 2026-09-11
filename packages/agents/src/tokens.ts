import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { expiryPreset, isKnownScope } from './scopes.js';

/**
 * Agent tokens — dedicated credentials for AI/developer agents, separate
 * from project API keys and session JWTs. Only sha256 hashes are stored;
 * the raw `cn_agent_…` value is shown once at creation and never logged.
 */

export const AGENT_TOKEN_PREFIX = 'cn_agent_';

export class AgentTokenError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AgentTokenError';
    this.code = code;
    this.status = status;
  }
}

export interface AgentToken {
  id: string;
  userId: string;
  /** Null = all organizations the user belongs to. */
  organizationId: string | null;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  /** Empty = all projects in scope. */
  projectIds: string[];
  approvalRequired: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  requestCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ExposedAgentToken = Omit<AgentToken, 'hash'>;

export interface AgentTokenStore {
  save(token: AgentToken): Promise<AgentToken>;
  findByHash(hash: string): Promise<AgentToken | null>;
  get(id: string): Promise<AgentToken | null>;
  listByUser(userId: string): Promise<ExposedAgentToken[]>;
  revoke(id: string): Promise<ExposedAgentToken | null>;
  touch(id: string): Promise<void>;
}

export function exposeToken(token: AgentToken): ExposedAgentToken {
  const { hash: _dropped, ...rest } = token;
  void _dropped;
  return rest;
}

/** Fast routing: only `cn_agent_` bearers enter agent verification. */
export function looksLikeAgentToken(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith(AGENT_TOKEN_PREFIX) && raw.length <= 200;
}

export function hashAgentToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function createAgentTokenValue(): { raw: string; prefix: string; hash: string } {
  const raw = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 16), hash: hashAgentToken(raw) };
}

export interface CreateTokenInput {
  userId: string;
  organizationId: string | null;
  name: string;
  scopes: string[];
  projectIds: string[];
  approvalRequired?: boolean;
  /** Preset id (7d/30d/90d/365d/never). Defaults to 30d. */
  expiresIn?: string;
}

let tokenCounter = 0;

export function buildTokenRecord(input: CreateTokenInput, now: Date = new Date()): AgentToken {
  if (!input.userId) throw new AgentTokenError('VALIDATION_ERROR', 'userId is required', 400);
  if (!input.name || input.name.length > 100) {
    throw new AgentTokenError('VALIDATION_ERROR', 'Token name is required (max 100 chars)', 400);
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new AgentTokenError('VALIDATION_ERROR', 'At least one scope is required', 400);
  for (const scope of scopes) {
    if (!isKnownScope(scope)) {
      throw new AgentTokenError('VALIDATION_ERROR', `Unknown scope: ${scope.slice(0, 60)}`, 400);
    }
  }
  const projectIds = [...new Set(input.projectIds)].slice(0, 200);
  const preset = expiryPreset(input.expiresIn ?? '30d');
  if (!preset) throw new AgentTokenError('VALIDATION_ERROR', 'Unknown expiry preset', 400);
  tokenCounter += 1;
  return {
    id: `agent_${now.getTime().toString(36)}_${tokenCounter}`,
    userId: input.userId,
    organizationId: input.organizationId,
    name: input.name.slice(0, 100),
    prefix: '',
    hash: '',
    scopes,
    projectIds,
    approvalRequired: input.approvalRequired ?? false,
    expiresAt: preset.days === null ? null : new Date(now.getTime() + preset.days * 86_400_000).toISOString(),
    revokedAt: null,
    requestCount: 0,
    lastUsedAt: null,
    createdAt: now.toISOString(),
  };
}

export class MemoryAgentTokenStore implements AgentTokenStore {
  private readonly tokens = new Map<string, AgentToken>();

  async save(token: AgentToken): Promise<AgentToken> {
    this.tokens.set(token.id, { ...token });
    return { ...token };
  }

  async findByHash(hash: string): Promise<AgentToken | null> {
    if (!hash) return null;
    const want = Buffer.from(hash, 'utf8');
    for (const token of this.tokens.values()) {
      const have = Buffer.from(token.hash, 'utf8');
      // Constant-time comparison so hash prefixes leak nothing measurable.
      if (have.length === want.length && timingSafeEqual(have, want)) {
        return { ...token };
      }
    }
    return null;
  }

  async get(id: string): Promise<AgentToken | null> {
    const token = this.tokens.get(id);
    return token ? { ...token } : null;
  }

  async listByUser(userId: string): Promise<ExposedAgentToken[]> {
    return [...this.tokens.values()]
      .filter(t => t.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(exposeToken);
  }

  async revoke(id: string): Promise<ExposedAgentToken | null> {
    const token = this.tokens.get(id);
    if (!token || token.revokedAt) return null;
    const next = { ...token, revokedAt: new Date().toISOString() };
    this.tokens.set(id, next);
    return exposeToken(next);
  }

  async touch(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (!token) return;
    this.tokens.set(id, {
      ...token,
      requestCount: token.requestCount + 1,
      lastUsedAt: new Date().toISOString(),
    });
  }
}
