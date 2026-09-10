/**
 * Realtime domain types. Wire envelopes are JSON text frames; error shapes
 * follow the platform `{ error: { code, message } }` convention (requestId
 * rides the message `id` for correlation).
 */

export type DbChangeOp = 'INSERT' | 'UPDATE' | 'DELETE';

export interface DbChangeEvent {
  type: DbChangeOp;
  project_id: string;
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  timestamp: string;
}

export type ClientMessageType =
  'subscribe' | 'unsubscribe' | 'broadcast' | 'presence.set' | 'presence.remove' | 'ping';

export interface ClientMessage {
  id?: string;
  type: ClientMessageType;
  channel?: string;
  event?: string;
  data?: unknown;
  /**
   * Optional equality filter for `table:<name>` subscriptions, e.g.
   * `{ user_id: "123" }`. Validated allow-list-side (never SQL): column keys
   * must match `^[a-z_][a-z0-9_]{0,62}$`, values are primitives only, max 8
   * entries. Non-matching rows are silently skipped at fan-out.
   */
  filter?: SubscriptionFilter;
}

export type ServerMessageType =
  'subscribed' | 'unsubscribed' | 'event' | 'broadcast' | 'presence' | 'pong' | 'error';

export interface ServerMessage {
  id?: string;
  type: ServerMessageType;
  channel?: string;
  event?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface PresenceEntry {
  user_id: string;
  status: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export type PresenceState = Record<string, PresenceEntry[]>;

export interface ConnectionInfo {
  id: string;
  projectId: string;
  organizationId: string;
  userId: string | null;
  role: string;
  channels: string[];
  connectedAt: string;
  lastHeartbeat: string;
  remoteAddress: string | null;
}

export class RealtimeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RealtimeError';
    this.code = code;
    this.status = status;
  }
}

/** Channel grammar: `project:<uuid>:<topic>` — project binding is structural. */
const CHANNEL_RE = /^project:([0-9a-f-]{36}):([A-Za-z0-9_.:-]{1,160})$/;

export interface ParsedChannel {
  projectId: string;
  topic: string;
}

export function parseChannel(channel: string): ParsedChannel {
  const m = CHANNEL_RE.exec(channel);
  if (!m?.[1] || !m[2]) {
    throw new RealtimeError(
      'INVALID_CHANNEL',
      'Channel must look like project:<uuid>:<topic>',
      400,
    );
  }
  return { projectId: m[1], topic: m[2] };
}

/** Table topics are `table:<name>`; everything else is an app channel. */
export function tableOfTopic(topic: string): string | null {
  const m = /^table:([A-Za-z_][A-Za-z0-9_]{0,62})$/.exec(topic);
  return m?.[1] ?? null;
}

/**
 * Safe subscription filter: pure equality over a small allow-listed key set.
 * Never interpolated into SQL — enforced in JS at fan-out time only.
 */
export type SubscriptionFilter = Record<string, string | number | boolean | null>;

const FILTER_KEY_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function parseSubscriptionFilter(value: unknown): SubscriptionFilter | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RealtimeError('INVALID_FILTER', 'Subscription filter must be an object', 400);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) {
    throw new RealtimeError('INVALID_FILTER', 'Subscription filter holds at most 8 fields', 400);
  }
  const out: SubscriptionFilter = {};
  for (const [k, v] of entries) {
    if (!FILTER_KEY_RE.test(k)) {
      throw new RealtimeError('INVALID_FILTER', `Bad filter column: ${k.slice(0, 40)}`, 400);
    }
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new RealtimeError('INVALID_FILTER', `Bad filter value for ${k}`, 400);
    }
    if (typeof v === 'string' && v.length > 256) {
      throw new RealtimeError('INVALID_FILTER', `Filter value too long for ${k}`, 400);
    }
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new RealtimeError('INVALID_FILTER', `Bad filter value for ${k}`, 400);
    }
    out[k] = v;
  }
  return out;
}

export interface RealtimeMetrics {
  connections: number;
  subscriptions: number;
  channels: number;
  eventsPublished: number;
  eventsDelivered: number;
  eventsDropped: number;
  broadcasts: number;
  presenceEntries: number;
  connectionErrors: number;
  authFailures: number;
  totalLatencyMs: number;
  deliveredCount: number;
}
