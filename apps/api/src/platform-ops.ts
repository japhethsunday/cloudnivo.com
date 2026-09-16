import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { ApiError, checkRateLimit, isUniqueViolation, ok, parseBody, toPublicError } from '@cloudnivo/api-core';
import { resolvesToPublicAddress } from './ssrf.js';
import { bearerFromHeader } from '@cloudnivo/auth';
import {
  customDomains,
  logDrains,
  statusIncidents,
  type Database,
} from '@cloudnivo/database';
import type { Logger } from '@cloudnivo/logging';
import type { ApiContext } from './v1.js';
import { sendJson } from './projects.js';
import { rateLimitIp } from './client-ip.js';

/**
 * Platform operations: public status/incidents, custom domains (DNS
 * verification), and log drains (signed audit export). Domains and drains
 * are org-owned with membership enforcement; incidents are operator-managed
 * (any org owner) and publicly readable.
 */

// ── Incidents ───────────────────────────────────────────────────

export type IncidentStatus = 'open' | 'monitoring' | 'resolved';
export type IncidentSeverity = 'minor' | 'major' | 'critical';

export interface StatusIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  message: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'monitoring', 'resolved'];
const INCIDENT_SEVERITIES: IncidentSeverity[] = ['minor', 'major', 'critical'];

export interface IncidentStore {
  create(input: { title: string; severity: IncidentSeverity; message: string }): Promise<StatusIncident>;
  list(limit: number): Promise<StatusIncident[]>;
  update(id: string, patch: { status?: IncidentStatus; message?: string }): Promise<StatusIncident | null>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function incidentToPublic(row: {
  id: string;
  title: string;
  status: string | null;
  severity: string | null;
  message: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt: Date | string | null;
}): StatusIncident {
  return {
    id: row.id,
    title: row.title,
    status: INCIDENT_STATUSES.includes(row.status as IncidentStatus)
      ? (row.status as IncidentStatus)
      : 'open',
    severity: INCIDENT_SEVERITIES.includes(row.severity as IncidentSeverity)
      ? (row.severity as IncidentSeverity)
      : 'minor',
    message: row.message ?? '',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
  };
}

export class MemoryIncidents implements IncidentStore {
  private readonly rows = new Map<string, StatusIncident>();
  async create(input: { title: string; severity: IncidentSeverity; message: string }): Promise<StatusIncident> {
    const { randomUUID } = await import('node:crypto');
    const now = new Date().toISOString();
    const incident: StatusIncident = {
      id: randomUUID(),
      title: input.title.slice(0, 200),
      status: 'open',
      severity: input.severity,
      message: input.message.slice(0, 5000),
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    this.rows.set(incident.id, incident);
    return { ...incident };
  }
  async list(limit: number): Promise<StatusIncident[]> {
    return [...this.rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(r => ({ ...r }));
  }
  async update(id: string, patch: { status?: IncidentStatus; message?: string }): Promise<StatusIncident | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next: StatusIncident = {
      ...row,
      status: patch.status ?? row.status,
      message: patch.message !== undefined ? patch.message.slice(0, 5000) : row.message,
      updatedAt: new Date().toISOString(),
      resolvedAt: patch.status === 'resolved' ? new Date().toISOString() : row.resolvedAt,
    };
    this.rows.set(id, next);
    return { ...next };
  }
}

export class DrizzleIncidents implements IncidentStore {
  constructor(private readonly db: Database) {}
  async create(input: { title: string; severity: IncidentSeverity; message: string }): Promise<StatusIncident> {
    const rows = await this.db
      .insert(statusIncidents)
      .values({ title: input.title.slice(0, 200), severity: input.severity, message: input.message.slice(0, 5000) })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Incident insert failed');
    return incidentToPublic(row);
  }
  async list(limit: number): Promise<StatusIncident[]> {
    const rows = await this.db
      .select()
      .from(statusIncidents)
      .orderBy(desc(statusIncidents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map(incidentToPublic);
  }
  async update(id: string, patch: { status?: IncidentStatus; message?: string }): Promise<StatusIncident | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status) {
      set['status'] = patch.status;
      if (patch.status === 'resolved') set['resolvedAt'] = new Date();
    }
    if (patch.message !== undefined) set['message'] = patch.message.slice(0, 5000);
    const rows = await this.db.update(statusIncidents).set(set).where(eq(statusIncidents.id, id)).returning();
    const row = rows[0];
    return row ? incidentToPublic(row) : null;
  }
}

// ── Custom domains (DNS TXT verification, no cert provisioning) ──

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/;

export interface CustomDomain {
  id: string;
  organizationId: string;
  projectId: string | null;
  domain: string;
  purpose: string;
  status: string;
  verifiedAt: string | null;
  dnsRecord: string;
  createdAt: string;
}

export interface DomainStore {
  create(input: {
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string;
    verifyToken: string;
  }): Promise<CustomDomain>;
  listByOrg(organizationId: string): Promise<CustomDomain[]>;
  findById(id: string): Promise<(CustomDomain & { verifyToken: string }) | null>;
  markVerified(id: string): Promise<CustomDomain | null>;
  remove(id: string): Promise<boolean>;
}

function domainToPublic(
  row: {
    id: string;
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string | null;
    verifiedAt: Date | string | null;
    status: string | null;
    verifyToken: string;
    createdAt: Date | string;
  },
  withToken: true,
): CustomDomain & { verifyToken: string };
function domainToPublic(
  row: {
    id: string;
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string | null;
    verifiedAt: Date | string | null;
    status: string | null;
    verifyToken: string;
    createdAt: Date | string;
  },
  withToken?: false,
): CustomDomain;
function domainToPublic(
  row: {
    id: string;
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string | null;
    verifiedAt: Date | string | null;
    status: string | null;
    verifyToken: string;
    createdAt: Date | string;
  },
  withToken = false,
): CustomDomain & { verifyToken?: string } {
  const base = {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    domain: row.domain,
    purpose: row.purpose ?? 'api',
    status: row.status ?? 'pending',
    verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
    dnsRecord: `cloudnivo-verify=${row.verifyToken}`,
    createdAt: iso(row.createdAt),
  };
  return withToken ? { ...base, verifyToken: row.verifyToken } : base;
}

export function newVerifyToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Real DNS check: TXT at the apex must contain the verification token. */
export async function verifyDomainDns(domain: string, token: string): Promise<{ ok: boolean; detail: string }> {
  let records: string[][];
  try {
    records = await resolveTxt(domain);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { ok: false, detail: 'No TXT record found — publish the verification record and retry' };
    }
    return { ok: false, detail: 'DNS lookup failed — retry shortly' };
  }
  const flat = records.map(r => r.join(''));
  if (flat.some(txt => txt.includes(token))) return { ok: true, detail: 'Verified' };
  return { ok: false, detail: 'TXT record present but token not found' };
}

export class MemoryDomains implements DomainStore {
  private readonly rows = new Map<string, CustomDomain & { verifyToken: string }>();
  async create(input: {
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string;
    verifyToken: string;
  }): Promise<CustomDomain> {
    const domain = input.domain.toLowerCase();
    for (const r of this.rows.values()) {
      if (r.domain === domain) {
        const err = new Error('Domain already registered') as Error & { code: string };
        err.code = 'DOMAIN_TAKEN';
        throw err;
      }
    }
    const { randomUUID } = await import('node:crypto');
    const full: CustomDomain & { verifyToken: string } = {
      ...input,
      id: randomUUID(),
      domain,
      status: 'pending',
      verifiedAt: null,
      dnsRecord: `cloudnivo-verify=${input.verifyToken}`,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(full.id, full);
    const { verifyToken: _drop, ...pub } = full;
    void _drop;
    return pub;
  }
  async listByOrg(organizationId: string): Promise<CustomDomain[]> {
    return [...this.rows.values()]
      .filter(r => r.organizationId === organizationId)
      .map(({ verifyToken: _drop, ...pub }) => {
        void _drop;
        return pub;
      });
  }
  async findById(id: string): Promise<(CustomDomain & { verifyToken: string }) | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async markVerified(id: string): Promise<CustomDomain | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, status: 'verified', verifiedAt: new Date().toISOString() };
    this.rows.set(id, next);
    const { verifyToken: _drop, ...pub } = next;
    void _drop;
    return pub;
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class DrizzleDomains implements DomainStore {
  constructor(private readonly db: Database) {}
  async create(input: {
    organizationId: string;
    projectId: string | null;
    domain: string;
    purpose: string;
    verifyToken: string;
  }): Promise<CustomDomain> {
    try {
      const rows = await this.db
        .insert(customDomains)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          domain: input.domain.toLowerCase(),
          purpose: input.purpose,
          verifyToken: input.verifyToken,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Domain insert failed');
      return domainToPublic(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const taken = new Error('Domain already registered') as Error & { code: string };
        taken.code = 'DOMAIN_TAKEN';
        throw taken;
      }
      throw err;
    }
  }
  async listByOrg(organizationId: string): Promise<CustomDomain[]> {
    const rows = await this.db
      .select()
      .from(customDomains)
      .where(eq(customDomains.organizationId, organizationId));
    return rows.map(r => domainToPublic(r));
  }
  async findById(id: string): Promise<(CustomDomain & { verifyToken: string }) | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db.select().from(customDomains).where(eq(customDomains.id, id)).limit(1);
    const row = rows[0];
    return row ? domainToPublic(row, true) : null;
  }
  async markVerified(id: string): Promise<CustomDomain | null> {
    const rows = await this.db
      .update(customDomains)
      .set({ status: 'verified', verifiedAt: new Date() })
      .where(eq(customDomains.id, id))
      .returning();
    const row = rows[0];
    return row ? domainToPublic(row) : null;
  }
  async remove(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await this.db.delete(customDomains).where(eq(customDomains.id, id)).returning();
    return rows.length > 0;
  }
}

// ── Log drains (signed audit export) ────────────────────────────

export interface LogDrain {
  id: string;
  organizationId: string;
  projectId: string | null;
  url: string;
  events: string[];
  enabled: boolean;
  lastStatus: string;
  lastError: string | null;
  createdAt: string;
}

export interface DrainStore {
  create(input: {
    organizationId: string;
    projectId: string | null;
    url: string;
    events: string[];
    secretPrefix: string;
    secretHash: string;
  }): Promise<{ drain: LogDrain; secret: string } | { drain: LogDrain; secret?: undefined }>;
  listByOrg(organizationId: string): Promise<LogDrain[]>;
  getWithSecret(id: string): Promise<(LogDrain & { secretHash: string; cursor: string | null }) | null>;
  setStatus(id: string, status: string, error: string | null, cursor: string | null): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<LogDrain | null>;
  remove(id: string): Promise<boolean>;
  listAll(): Promise<(LogDrain & { secretHash: string })[]>;
}

export function newDrainSecret(): { raw: string; prefix: string; hash: string } {
  const raw = `drsec_${randomBytes(24).toString('base64url')}`;
  return {
    raw,
    prefix: raw.slice(0, 10),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
}

export function signDrainPayload(secretHash: string, body: string): string {
  return createHmac('sha256', secretHash).update(body).digest('hex');
}

function drainToPublic(row: {
  id: string;
  organizationId: string;
  projectId: string | null;
  url: string;
  events: unknown;
  enabled: boolean | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: Date | string;
}): LogDrain {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    url: row.url,
    events: Array.isArray(row.events) ? (row.events as string[]).map(String) : [],
    enabled: row.enabled ?? true,
    lastStatus: row.lastStatus ?? 'never',
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
  };
}

/** Drain targets must be public HTTPS (same SSRF posture as webhooks). */
export function assertDrainUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Drain URL must be absolute https', 400);
  }
  if (parsed.protocol !== 'https:') {
    throw new ApiError('VALIDATION_ERROR', 'Drain URL must be https', 400);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // A non-dotted numeric host (decimal or hex, e.g. 2130706433 / 0x7f000001)
  // is another spelling of a literal address and never a real drain endpoint.
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) {
    throw new ApiError('VALIDATION_ERROR', 'Drain URL must be publicly reachable', 400);
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host) ||
    host === '::1' ||
    host.startsWith('fe80') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new ApiError('VALIDATION_ERROR', 'Drain URL must be publicly reachable', 400);
  }
  return parsed;
}

export class MemoryDrains implements DrainStore {
  private readonly rows = new Map<string, LogDrain & { secretHash: string; cursor: string | null }>();
  async create(input: {
    organizationId: string;
    projectId: string | null;
    url: string;
    events: string[];
    secretPrefix: string;
    secretHash: string;
  }): Promise<{ drain: LogDrain; secret: string }> {
    const { randomUUID } = await import('node:crypto');
    const secret = newDrainSecret();
    const full = {
      id: randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      url: input.url,
      events: [...input.events],
      secretHash: secret.hash,
      enabled: true,
      lastStatus: 'never',
      lastError: null as string | null,
      cursor: null as string | null,
      createdAt: new Date().toISOString(),
    };
    void input.secretPrefix;
    void input.secretHash;
    this.rows.set(full.id, full);
    const { secretHash: _drop, ...pub } = full;
    void _drop;
    return { drain: pub, secret: secret.raw };
  }
  async listByOrg(organizationId: string): Promise<LogDrain[]> {
    return [...this.rows.values()]
      .filter(r => r.organizationId === organizationId)
      .map(({ secretHash: _drop, ...pub }) => {
        void _drop;
        return pub;
      });
  }
  async getWithSecret(id: string): Promise<(LogDrain & { secretHash: string; cursor: string | null }) | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async setStatus(id: string, status: string, error: string | null, cursor: string | null): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, lastStatus: status, lastError: error, cursor: cursor ?? row.cursor });
  }
  async setEnabled(id: string, enabled: boolean): Promise<LogDrain | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, enabled };
    this.rows.set(id, next);
    const { secretHash: _drop, ...pub } = next;
    void _drop;
    return pub;
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
  async listAll(): Promise<(LogDrain & { secretHash: string })[]> {
    return [...this.rows.values()].map(r => ({ ...r }));
  }
}

export class DrizzleDrains implements DrainStore {
  constructor(private readonly db: Database) {}
  async create(input: {
    organizationId: string;
    projectId: string | null;
    url: string;
    events: string[];
    secretPrefix: string;
    secretHash: string;
  }): Promise<{ drain: LogDrain; secret: string }> {
    const secret = newDrainSecret();
    const rows = await this.db
      .insert(logDrains)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        url: input.url,
        events: [...input.events],
        secretPrefix: secret.prefix,
        secretHash: secret.hash,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Drain insert failed');
    return { drain: drainToPublic(row), secret: secret.raw };
  }
  async listByOrg(organizationId: string): Promise<LogDrain[]> {
    const rows = await this.db
      .select()
      .from(logDrains)
      .where(eq(logDrains.organizationId, organizationId));
    return rows.map(drainToPublic);
  }
  async getWithSecret(id: string): Promise<(LogDrain & { secretHash: string; cursor: string | null }) | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.db.select().from(logDrains).where(eq(logDrains.id, id)).limit(1);
    const row = rows[0];
    return row ? { ...drainToPublic(row), secretHash: row.secretHash, cursor: row.cursor } : null;
  }
  async setStatus(id: string, status: string, error: string | null, cursor: string | null): Promise<void> {
    await this.db
      .update(logDrains)
      .set({ lastStatus: status, lastError: error, cursor })
      .where(eq(logDrains.id, id));
  }
  async setEnabled(id: string, enabled: boolean): Promise<LogDrain | null> {
    const rows = await this.db
      .update(logDrains)
      .set({ enabled })
      .where(eq(logDrains.id, id))
      .returning();
    const row = rows[0];
    return row ? drainToPublic(row) : null;
  }
  async remove(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await this.db.delete(logDrains).where(eq(logDrains.id, id)).returning();
    return rows.length > 0;
  }
  async listAll(): Promise<(LogDrain & { secretHash: string })[]> {
    const rows = await this.db.select().from(logDrains).where(eq(logDrains.enabled, true));
    return rows.map(row => ({ ...drainToPublic(row), secretHash: row.secretHash }));
  }
}

// ── Wiring + routes ─────────────────────────────────────────────

export interface PlatformOps {
  incidents: IncidentStore;
  domains: DomainStore;
  drains: DrainStore;
}

export function platformOpsFor(ctx: ApiContext): PlatformOps {
  const existing = (ctx as unknown as { __ops?: PlatformOps }).__ops;
  if (existing) return existing;
  const durable = ctx.config.CONTROL_STORE === 'drizzle' && ctx.controlDb !== null;
  const db = durable && ctx.controlDb ? ctx.controlDb.db : null;
  const ops: PlatformOps = db
    ? { incidents: new DrizzleIncidents(db), domains: new DrizzleDomains(db), drains: new DrizzleDrains(db) }
    : { incidents: new MemoryIncidents(), domains: new MemoryDomains(), drains: new MemoryDrains() };
  (ctx as unknown as { __ops?: PlatformOps }).__ops = ops;
  return ops;
}

export function isPlatformOpsRoute(pathname: string, method: string): boolean {
  void method;
  return (
    pathname === '/api/v1/status' ||
    pathname.startsWith('/api/v1/status/') ||
    /^\/api\/v1\/organizations\/[^/]+\/(domains|drains)(\/[^/]+(\/[^/]+)?)?\/?$/.test(pathname)
  );
}

async function requireOperator(
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<{ userId: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const { verifyPlatformSession } = await import('./sessions.js');
  const session = await verifyPlatformSession(ctx, token);
  const memberships = await ctx.registry.membershipsFor(session.sub);
  if (!memberships.some(m => m.role === 'owner')) {
    throw new ApiError('FORBIDDEN', 'Operator role (org owner) required', 403);
  }
  return { userId: session.sub };
}

async function requireOrgManager(
  ctx: ApiContext,
  req: IncomingMessage,
  organizationId: string,
): Promise<{ userId: string; role: string }> {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing bearer token', 401);
  const { verifyPlatformSession } = await import('./sessions.js');
  const session = await verifyPlatformSession(ctx, token);
  const memberships = await ctx.registry.membershipsFor(session.sub);
  const mine = memberships.find(m => m.organizationId === organizationId);
  if (!mine) throw new ApiError('TENANT_FORBIDDEN', 'Access denied', 403);
  if (mine.role !== 'owner' && mine.role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Owner or admin required', 403);
  }
  return { userId: session.sub, role: mine.role };
}

const IncidentBody = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['minor', 'major', 'critical']).default('minor'),
  message: z.string().max(5000).default(''),
});
const IncidentPatchBody = z.object({
  status: z.enum(['open', 'monitoring', 'resolved']).optional(),
  message: z.string().max(5000).optional(),
});
const DomainBody = z.object({
  domain: z.string().min(3).max(255),
  purpose: z.enum(['api', 'storage', 'functions', 'app']).default('api'),
  projectId: z.string().uuid().nullable().optional(),
});
const DrainBody = z.object({
  url: z.string().url().max(2000),
  projectId: z.string().uuid().nullable().optional(),
  events: z.array(z.enum(['audit', 'billing', 'auth', 'errors'])).min(1).max(4).default(['audit']),
});

export async function handlePlatformOpsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  logger: Logger,
  baseHeaders: Record<string, string>,
  requestId: string,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const start = Date.now();
  const finish = (status: number, body: unknown): true => {
    logger.info('ops.request', { route: url.pathname, method: req.method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const fail = (err: unknown): true => {
    const { status, body } = toPublicError(err, requestId);
    logger.info('ops.request', { route: url.pathname, method: req.method, status, latencyMs: Date.now() - start });
    sendJson(res, status, body, baseHeaders);
    return true;
  };
  const strictLimit = async (): Promise<void> => {
    const ip =
      rateLimitIp(req, ctx.config.TRUSTED_PROXY_HOPS);
    const rl = await checkRateLimit(ctx.rateLimitStore, `ops:${ip}`, {
      windowMs: ctx.config.RATE_LIMIT_WINDOW_MS,
      max: ctx.config.AUTH_RATE_MAX,
      keyPrefix: 'ops',
    });
    if (!rl.allowed) throw new ApiError('RATE_LIMITED', 'Too many attempts', 429);
  };
  const readJson = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
    }
  };

  try {
    const ops = platformOpsFor(ctx);

    // ── Public status (no auth; incidents only, never internals) ──
    if (url.pathname === '/api/v1/status' && req.method === 'GET') {
      const incidents = await ops.incidents.list(10);
      const open = incidents.filter(i => i.status !== 'resolved');
      return finish(
        200,
        ok(
          {
            status: open.some(i => i.severity === 'critical') ? 'major' : open.length > 0 ? 'degraded' : 'ok',
            incidents: open,
            recent: incidents.filter(i => i.status === 'resolved').slice(0, 3),
          },
          requestId,
        ),
      );
    }
    if (url.pathname === '/api/v1/status/incidents' && req.method === 'POST') {
      await strictLimit();
      const { userId } = await requireOperator(ctx, req);
      const parsed = parseBody(IncidentBody, await readJson());
      const incident = await ops.incidents.create({
        title: parsed.title,
        severity: parsed.severity ?? 'minor',
        message: parsed.message ?? '',
      });
      await ctx.registry.recordAudit('ops.incident.created', { userId });
      return finish(201, ok({ incident }, requestId));
    }
    const incidentPatch = /^\/api\/v1\/status\/incidents\/([^/]+)\/?$/.exec(url.pathname);
    if (incidentPatch?.[1] && req.method === 'PATCH') {
      const { userId } = await requireOperator(ctx, req);
      const parsed = parseBody(IncidentPatchBody, await readJson());
      const incident = await ops.incidents.update(incidentPatch[1], parsed);
      if (!incident) throw new ApiError('NOT_FOUND', 'Incident not found', 404);
      await ctx.registry.recordAudit('ops.incident.updated', { userId });
      return finish(200, ok({ incident }, requestId));
    }

    // ── Domains + drains (org managers) ──
    const orgMatch = /^\/api\/v1\/organizations\/([^/]+)\/(domains|drains)(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(
      url.pathname,
    );
    if (!orgMatch?.[1] || !orgMatch[2]) return false;
    const orgId = orgMatch[1];
    const section = orgMatch[2];
    const sub = orgMatch[3] ?? null;
    const verb = orgMatch[4] ?? null;
    const member = await requireOrgManager(ctx, req, orgId);

    if (section === 'domains' && !sub && req.method === 'GET') {
      return finish(200, ok({ domains: await ops.domains.listByOrg(orgId) }, requestId));
    }
    if (section === 'domains' && !sub && req.method === 'POST') {
      const parsed = parseBody(DomainBody, await readJson());
      const domain = parsed.domain.toLowerCase();
      if (!DOMAIN_RE.test(domain)) throw new ApiError('VALIDATION_ERROR', 'Invalid domain name', 400);
      if (parsed.projectId) {
        const project = await ctx.registry.getProject(parsed.projectId);
        if (!project || project.organizationId !== orgId) {
          throw new ApiError('NOT_FOUND', 'Project not found', 404);
        }
      }
      const created = await ops.domains.create({
        organizationId: orgId,
        projectId: parsed.projectId ?? null,
        domain,
        purpose: parsed.purpose ?? 'api',
        verifyToken: newVerifyToken(),
      }).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'DOMAIN_TAKEN') {
          throw new ApiError('CONFLICT', 'Domain already registered', 409);
        }
        throw err;
      });
      await ctx.registry.recordAudit('ops.domain.created', { organizationId: orgId, userId: member.userId });
      return finish(201, ok({ domain: created }, requestId));
    }
    if (section === 'domains' && sub && !verb && req.method === 'DELETE') {
      const existing = await ops.domains.findById(sub);
      if (!existing || existing.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'Domain not found', 404);
      }
      await ops.domains.remove(sub);
      await ctx.registry.recordAudit('ops.domain.deleted', { organizationId: orgId, userId: member.userId });
      return finish(200, ok({ deleted: true }, requestId));
    }
    if (section === 'domains' && sub && verb === 'verify' && req.method === 'POST') {
      const existing = await ops.domains.findById(sub);
      if (!existing || existing.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'Domain not found', 404);
      }
      if (existing.status === 'verified') {
        return finish(200, ok({ domain: { ...existing, verifyToken: undefined }, verified: true }, requestId));
      }
      const check = await verifyDomainDns(existing.domain, existing.verifyToken);
      if (!check.ok) {
        return finish(200, ok({ verified: false, detail: check.detail }, requestId));
      }
      const verified = await ops.domains.markVerified(sub);
      await ctx.registry.recordAudit('ops.domain.verified', { organizationId: orgId, userId: member.userId });
      return finish(200, ok({ domain: verified, verified: true }, requestId));
    }

    if (section === 'drains' && !sub && req.method === 'GET') {
      return finish(200, ok({ drains: await ops.drains.listByOrg(orgId) }, requestId));
    }
    if (section === 'drains' && !sub && req.method === 'POST') {
      const parsed = parseBody(DrainBody, await readJson());
      assertDrainUrl(parsed.url);
      if (parsed.projectId) {
        const project = await ctx.registry.getProject(parsed.projectId);
        if (!project || project.organizationId !== orgId) {
          throw new ApiError('NOT_FOUND', 'Project not found', 404);
        }
      }
      const { drain, secret } = await ops.drains.create({
        organizationId: orgId,
        projectId: parsed.projectId ?? null,
        url: parsed.url,
        events: [...new Set(parsed.events)],
        secretPrefix: '',
        secretHash: '',
      });
      await ctx.registry.recordAudit('ops.drain.created', { organizationId: orgId, userId: member.userId });
      return finish(201, ok({ drain, secret }, requestId));
    }
    if (section === 'drains' && sub && !verb && req.method === 'DELETE') {
      const existing = await ops.drains.getWithSecret(sub);
      if (!existing || existing.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'Drain not found', 404);
      }
      await ops.drains.remove(sub);
      await ctx.registry.recordAudit('ops.drain.deleted', { organizationId: orgId, userId: member.userId });
      return finish(200, ok({ deleted: true }, requestId));
    }
    if (section === 'drains' && sub && verb === 'test' && req.method === 'POST') {
      const existing = await ops.drains.getWithSecret(sub);
      if (!existing || existing.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'Drain not found', 404);
      }
      const result = await deliverDrain(ctx, existing, [
        { id: 'test', at: new Date().toISOString(), event: 'drain.test', organizationId: orgId, projectId: existing.projectId, userId: null },
      ]);
      await ops.drains.setStatus(sub, result.ok ? 'ok' : 'error', result.ok ? null : result.error, null);
      return finish(200, ok({ delivered: result.ok, error: result.error }, requestId));
    }
    if (section === 'drains' && sub && verb === 'toggle' && req.method === 'POST') {
      const existing = await ops.drains.getWithSecret(sub);
      if (!existing || existing.organizationId !== orgId) {
        throw new ApiError('NOT_FOUND', 'Drain not found', 404);
      }
      const parsed = parseBody(z.object({ enabled: z.boolean() }), await readJson());
      const updated = await ops.drains.setEnabled(sub, parsed.enabled);
      return finish(200, ok({ drain: updated }, requestId));
    }

    return finish(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId } });
  } catch (err) {
    return fail(err);
  }
}

/** Signed delivery of audit entries to a drain URL (10s timeout, SSRF-safe). */
export async function deliverDrain(
  ctx: ApiContext,
  drain: { url: string; secretHash: string },
  entries: { id: string; at: string; event: string; organizationId: string | null; projectId: string | null; userId: string | null }[],
): Promise<{ ok: boolean; error: string | null }> {
  const secret = drain.secretHash;
  try {
    assertDrainUrl(drain.url);
  } catch {
    return { ok: false, error: 'Drain URL is not publicly reachable' };
  }
  // Resolve before delivering: the stored hostname passed a string check when
  // it was saved, but what it points at now is a different question (DNS
  // rebinding, or a name that always pointed inside). Fail closed.
  if (!(await resolvesToPublicAddress(new URL(drain.url).hostname))) {
    return { ok: false, error: 'Drain URL resolves to a blocked address' };
  }
  const body = JSON.stringify({ source: 'cloudnivo-log-drain', entries });
  const signature = signDrainPayload(secret, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(drain.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CloudNivo-Signature': signature,
        'X-CloudNivo-Delivery': randomBytes(8).toString('hex'),
      },
      body,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    await res.arrayBuffer().catch(() => null);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Drain endpoint replied ${res.status}` };
    }
    void ctx;
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : 'delivery failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** Timing-safe drain signature check (used by receivers; tested here). */
export function verifyDrainSignature(secretHash: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const want = signDrainPayload(secretHash, body);
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
