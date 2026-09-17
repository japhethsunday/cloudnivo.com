import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { ApiError } from '@cloudnivo/api-core';
import { platformEmails, type Database } from '@cloudnivo/database';
import { buildActionEmail, type BrandContext } from '@cloudnivo/auth';
import type { ApiContext } from './v1.js';

/**
 * The Email Center's storage and templates.
 *
 * What this module will not do, in order of how tempting each one is:
 *
 * - It never reports a status CloudNivo did not observe. Resend returning
 *   202 means the message was ACCEPTED, so the row says `sent`. It does not
 *   say `delivered`: delivery is something only a later webhook can tell us,
 *   and a console that prints "delivered" on an accepted message is lying to
 *   the operator about the one thing they opened it to check.
 * - It never stores or returns the provider API key. The key lives in
 *   config, is read inside the sender, and never crosses a route boundary.
 * - It never invents a bounce or complaint. Those states exist in the schema
 *   because Resend can report them over a webhook; until one arrives, no row
 *   is ever written with them.
 */

/** Hard ceiling on recipients in one send, before any rate limit applies. */
export const MAX_RECIPIENTS = 200;
/** Operator sends allowed per staff account per hour. */
export const SEND_RATE_LIMIT = 30;
export const SEND_RATE_WINDOW_SECONDS = 3600;

export type EmailStatus = 'draft' | 'queued' | 'sent' | 'failed' | 'bounced' | 'complained';

export interface EmailRecord {
  id: string;
  actorUserId: string | null;
  actorEmail: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  template: string | null;
  status: EmailStatus;
  provider: string | null;
  providerId: string | null;
  error: string | null;
  isTest: boolean;
  sentAt: string | null;
  createdAt: string;
}

export interface EmailLogInput {
  actorUserId: string | null;
  actorEmail: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  template: string | null;
  status: EmailStatus;
  provider: string | null;
  providerId: string | null;
  error: string | null;
  isTest: boolean;
}

export interface EmailStore {
  create(input: EmailLogInput): Promise<EmailRecord>;
  update(
    id: string,
    patch: Partial<Pick<EmailRecord, 'status' | 'provider' | 'providerId' | 'error' | 'sentAt'>>,
  ): Promise<EmailRecord | null>;
  list(filter: {
    status?: EmailStatus | null;
    query?: string | null;
    limit: number;
  }): Promise<EmailRecord[]>;
  get(id: string): Promise<EmailRecord | null>;
  remove(id: string): Promise<boolean>;
  /** Counts by status, for the Email Center's header. */
  counts(): Promise<Record<string, number>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryEmailStore implements EmailStore {
  private readonly rows = new Map<string, EmailRecord>();

  async create(input: EmailLogInput): Promise<EmailRecord> {
    const row: EmailRecord = {
      id: randomUUID(),
      ...input,
      sentAt: input.status === 'sent' ? nowIso() : null,
      createdAt: nowIso(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async update(
    id: string,
    patch: Partial<Pick<EmailRecord, 'status' | 'provider' | 'providerId' | 'error' | 'sentAt'>>,
  ): Promise<EmailRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async list(filter: {
    status?: EmailStatus | null;
    query?: string | null;
    limit: number;
  }): Promise<EmailRecord[]> {
    const q = filter.query?.trim().toLowerCase() ?? '';
    return [...this.rows.values()]
      .filter(r => (filter.status ? r.status === filter.status : true))
      .filter(r =>
        q === ''
          ? true
          : r.subject.toLowerCase().includes(q) ||
            r.recipients.some(to => to.toLowerCase().includes(q)) ||
            r.actorEmail.toLowerCase().includes(q),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit)
      .map(r => ({ ...r }));
  }

  async get(id: string): Promise<EmailRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
}

function toRecord(row: {
  id: string;
  actorUserId: string | null;
  actorEmail: string;
  recipients: unknown;
  cc: unknown;
  bcc: unknown;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  template: string | null;
  status: string;
  provider: string | null;
  providerId: string | null;
  error: string | null;
  isTest: boolean;
  sentAt: Date | null;
  createdAt: Date;
}): EmailRecord {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    recipients: arr(row.recipients),
    cc: arr(row.cc),
    bcc: arr(row.bcc),
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    template: row.template,
    status: row.status as EmailStatus,
    provider: row.provider,
    providerId: row.providerId,
    error: row.error,
    isTest: row.isTest,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleEmailStore implements EmailStore {
  constructor(private readonly db: Database) {}

  async create(input: EmailLogInput): Promise<EmailRecord> {
    const rows = await this.db
      .insert(platformEmails)
      .values({
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        recipients: input.recipients,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        template: input.template,
        status: input.status,
        provider: input.provider,
        providerId: input.providerId,
        error: input.error,
        isTest: input.isTest,
        sentAt: input.status === 'sent' ? new Date() : null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new ApiError('INTERNAL', 'Could not record the email', 500);
    return toRecord(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<EmailRecord, 'status' | 'provider' | 'providerId' | 'error' | 'sentAt'>>,
  ): Promise<EmailRecord | null> {
    const rows = await this.db
      .update(platformEmails)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt ? new Date(patch.sentAt) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(platformEmails.id, id))
      .returning();
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async list(filter: {
    status?: EmailStatus | null;
    query?: string | null;
    limit: number;
  }): Promise<EmailRecord[]> {
    const q = filter.query?.trim();
    const clauses = [];
    if (filter.status) clauses.push(eq(platformEmails.status, filter.status));
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      clauses.push(
        or(
          sql`lower(${platformEmails.subject}) like ${like}`,
          sql`lower(${platformEmails.actorEmail}) like ${like}`,
          sql`lower(${platformEmails.recipients}::text) like ${like}`,
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(platformEmails)
      .where(clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses))
      .orderBy(desc(platformEmails.createdAt))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<EmailRecord | null> {
    const rows = await this.db
      .select()
      .from(platformEmails)
      .where(eq(platformEmails.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(platformEmails)
      .where(and(eq(platformEmails.id, id), eq(platformEmails.status, 'draft')))
      .returning({ id: platformEmails.id });
    return rows.length > 0;
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: platformEmails.status, n: sql<number>`count(*)` })
      .from(platformEmails)
      .groupBy(platformEmails.status);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}

const memoryStores = new WeakMap<object, MemoryEmailStore>();

export function emailStoreFor(ctx: ApiContext): EmailStore {
  if (ctx.controlDb) return new DrizzleEmailStore(ctx.controlDb.db as unknown as Database);
  let store = memoryStores.get(ctx);
  if (!store) {
    store = new MemoryEmailStore();
    memoryStores.set(ctx, store);
  }
  return store;
}

// ── Templates ───────────────────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  /** Paragraphs. `{{name}}` is substituted per recipient where known. */
  intro: string;
  bullets: string[];
  closing: string;
  cta: { label: string; path: string } | null;
}

/**
 * The templates an operator can start from.
 *
 * These are ANNOUNCEMENT templates — the ones a human composes and sends.
 * Transactional mail (verification, password reset, welcome, security
 * notices) is deliberately absent: those are sent by the flows that own
 * them, with tokens only the server can mint, and a console that appeared to
 * "send a verification email" would either be lying or minting credentials
 * from a text box. The Email Center links to those flows instead.
 */
export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'announcement',
    name: 'Product announcement',
    description: 'A new capability is live. Neutral, factual, one action.',
    subject: 'What’s new in CloudNivo',
    intro: 'We’ve shipped an update to your CloudNivo control plane.',
    bullets: ['What changed', 'Why it matters', 'What you need to do (if anything)'],
    closing: 'As always, nothing changes on your projects without your approval.',
    cta: { label: 'Open the console', path: '/dashboard' },
  },
  {
    id: 'maintenance',
    name: 'Maintenance window',
    description: 'Planned work with a stated window and expected impact.',
    subject: 'Scheduled CloudNivo maintenance',
    intro: 'We have scheduled maintenance on CloudNivo infrastructure.',
    bullets: ['Window: <start> – <end> UTC', 'Expected impact: <impact>', 'Action required: none'],
    closing: 'We will update the status page as the work progresses.',
    cta: { label: 'Status page', path: '/status' },
  },
  {
    id: 'incident',
    name: 'Incident update',
    description: 'An incident is open or resolved. State facts, not reassurance.',
    subject: 'CloudNivo incident update',
    intro: 'We are writing with an update on a service incident.',
    bullets: ['What happened', 'Who is affected', 'Current status', 'Next update'],
    closing: 'We will follow up with a full write-up once the incident is closed.',
    cta: { label: 'Status page', path: '/status' },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Blank, on CloudNivo letterhead.',
    subject: '',
    intro: '',
    bullets: [],
    closing: '',
    cta: null,
  },
];

/**
 * Renders an operator email on the SAME branded letterhead every
 * transactional CloudNivo email already uses, so an announcement cannot be
 * told apart from a password reset by its chrome. Reuses buildActionEmail
 * rather than introducing a second template system.
 */
export function renderOperatorEmail(input: {
  subject: string;
  intro: string;
  bullets: string[];
  closing: string;
  cta: { label: string; url: string } | null;
  brand: BrandContext;
}): { subject: string; text: string; html: string } {
  const built = buildActionEmail(
    {
      subject: input.subject,
      intro: input.intro.split(/\n{2,}/).map(p => p.trim()).filter(Boolean),
      ...(input.bullets.length > 0 ? { bullets: input.bullets } : {}),
      ...(input.cta ? { action: { label: input.cta.label, url: input.cta.url } } : {}),
      ...(input.closing.trim()
        ? { closing: input.closing.split(/\n{2,}/).map(p => p.trim()).filter(Boolean) }
        : {}),
    },
    input.brand,
  );
  return { subject: input.subject, text: built.text, html: built.html };
}

/** Rough address check. The provider is the real authority; this stops typos. */
export function parseRecipients(raw: unknown, field: string): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim().toLowerCase();
    if (value === '') continue;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) {
      throw new ApiError('VALIDATION_ERROR', `${field} contains an invalid address: ${value}`, 400);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export { inArray };
