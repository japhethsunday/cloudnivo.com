import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { expiryPreset, isKnownScope } from './scopes.js';
import { parseIpAllowlist } from './ip.js';

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
  /**
   * Environment slugs this token may act on. Empty = every NON-production
   * environment. Production is never implied and must be listed explicitly,
   * so a token holding a dangerous scope still cannot reach production
   * unless someone granted it that environment on purpose.
   */
  environments: string[];
  approvalRequired: boolean;
  /** Empty = unrestricted. CIDR (v4) or exact IPs, max 20. */
  ipAllowlist: string[];
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
  /** Environment slugs (empty = all non-production). */
  environments?: string[];
  approvalRequired?: boolean;
  /** Preset id (7d/30d/90d/365d/never). Defaults to 30d. */
  expiresIn?: string;
  /** IP/CIDR allowlist (empty = unrestricted). */
  ipAllowlist?: string[];
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
  const environments = [...new Set((input.environments ?? []).map(e => e.trim().toLowerCase()))]
    .filter(e => e.length > 0 && e.length <= 63)
    .slice(0, 20);
  const preset = expiryPreset(input.expiresIn ?? '30d');
  if (!preset) throw new AgentTokenError('VALIDATION_ERROR', 'Unknown expiry preset', 400);
  const ipAllowlist = parseIpAllowlist(input.ipAllowlist);
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
    environments,
    approvalRequired: input.approvalRequired ?? false,
    ipAllowlist,
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

/**
 * May this token act on `environmentSlug`?
 *
 * Production is deliberately asymmetric. An empty allowlist means "every
 * ordinary environment", which keeps existing tokens working, but it never
 * means production: reaching production takes an explicit grant. The caller
 * passes `isProduction` from the stored environment row, never from a request
 * body — otherwise the check could be talked out of firing by renaming.
 */
export function environmentAllowed(
  token: Pick<AgentToken, 'environments'>,
  environmentSlug: string,
  isProduction: boolean,
): boolean {
  const slug = environmentSlug.trim().toLowerCase();
  const allowed = token.environments.map(e => e.trim().toLowerCase());
  if (isProduction) return allowed.includes(slug);
  return allowed.length === 0 || allowed.includes(slug);
}
