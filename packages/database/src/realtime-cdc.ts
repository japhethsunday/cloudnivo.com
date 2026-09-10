import postgres from 'postgres';

/**
 * PostgreSQL change-data-capture over LISTEN/NOTIFY — no polling.
 *
 * `ensureTableFeed()` installs an idempotent per-table trigger that NOTIFYs
 * row changes as JSON; `PostgresNotifyListener` multiplexes one LISTEN
 * connection per project database with bounded reconnects. The realtime
 * gateway subscribes to the listener output and applies per-subscriber
 * authorization at fan-out time (row-level rules live in @cloudnivo/realtime).
 */

export type ChangeOp = 'INSERT' | 'UPDATE' | 'DELETE';

export interface ChangeNotification {
  table: string;
  schema: string;
  op: ChangeOp;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

export const CHANGE_CHANNEL = 'cloudnivo_changes';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid ${what}: ${name.slice(0, 60)}`);
  return `"${name}"`;
}

/** Idempotent trigger installer for one table (safe to call on subscribe). */
export function changeFeedDdl(schema: string, table: string): string[] {
  const s = ident(schema, 'schema');
  const t = ident(table, 'table');
  const safe = `${schema}_${table}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
  return [
    `CREATE OR REPLACE FUNCTION "cloudnivo_notify_${safe}"() RETURNS trigger AS $$
     BEGIN
       PERFORM pg_notify('cloudnivo_changes', json_build_object(
         'schema', TG_TABLE_SCHEMA,
         'table', TG_TABLE_NAME,
         'op', TG_OP,
         'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END,
         'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE row_to_json(OLD) END
       )::text);
       RETURN COALESCE(NEW, OLD);
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "cloudnivo_realtime_${safe}" ON ${s}.${t}`,
    `CREATE TRIGGER "cloudnivo_realtime_${safe}"
     AFTER INSERT OR UPDATE OR DELETE ON ${s}.${t}
     FOR EACH ROW EXECUTE FUNCTION "cloudnivo_notify_${safe}"()`,
  ];
}

export interface NotifyListener {
  onChange(handler: (n: ChangeNotification) => void): () => void;
  close(): Promise<void>;
  readonly state: 'connecting' | 'listening' | 'reconnecting' | 'closed' | 'failed';
}

export interface NotifyListenerOptions {
  maxReconnects?: number;
  baseDelayMs?: number;
  onError?: (err: unknown) => void;
}

/** Parse + validate one NOTIFY payload (malformed payloads → null, never throw). */
export function parseNotification(raw: string): ChangeNotification | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { table, schema, op, record, old_record } = parsed;
  if (typeof table !== 'string' || !IDENT.test(table)) return null;
  if (typeof schema !== 'string' || !IDENT.test(schema)) return null;
  if (op !== 'INSERT' && op !== 'UPDATE' && op !== 'DELETE') return null;
  const rec = record === null || record === undefined ? null : (record as Record<string, unknown>);
  const old =
    old_record === null || old_record === undefined
      ? null
      : (old_record as Record<string, unknown>);
  if (rec !== null && (typeof rec !== 'object' || Array.isArray(rec))) return null;
  if (old !== null && (typeof old !== 'object' || Array.isArray(old))) return null;
  return { table, schema, op, record: rec, old_record: old };
}

export class PostgresNotifyListener implements NotifyListener {
  private sql: ReturnType<typeof postgres> | null = null;
  private handlers = new Set<(n: ChangeNotification) => void>();
  private reconnects = 0;
  private _state: NotifyListener['state'] = 'connecting';
  private readonly maxReconnects: number;
  private readonly baseDelayMs: number;
  private readonly onError?: (err: unknown) => void;

  constructor(
    private readonly connectionString: string,
    opts: NotifyListenerOptions = {},
  ) {
    this.maxReconnects = opts.maxReconnects ?? 8;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.onError = opts.onError;
    void this.connect().catch(err => this.onError?.(err));
  }

  get state(): NotifyListener['state'] {
    return this._state;
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private async connect(): Promise<void> {
    if (this._state === 'closed' || this._state === 'failed') return;
    try {
      this.sql = postgres(this.connectionString, {
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        onclose: () => {
          // Later drops re-enter the bounded reconnect cycle (no silent death).
          if (this._state === 'listening') {
            this._state = 'reconnecting';
            void this.scheduleReconnect();
          }
        },
      });
      await this.sql.listen(CHANGE_CHANNEL, (payload: string) => {
        const n = parseNotification(payload);
        if (!n) return;
        for (const h of [...this.handlers]) {
          try {
            h(n);
          } catch {
            // Isolate subscriber faults.
          }
        }
      });
      this._state = 'listening';
      this.reconnects = 0;
    } catch (err) {
      await this.sql?.end({ timeout: 2 }).catch(() => undefined);
      this.sql = null;
      await this.scheduleReconnect(err);
    }
  }

  private async scheduleReconnect(cause?: unknown): Promise<void> {
    if (this._state === 'closed' || this._state === 'failed') return;
    if (this.reconnects >= this.maxReconnects) {
      this._state = 'failed';
      this.onError?.(cause ?? new Error('LISTEN reconnect budget exhausted'));
      return;
    }
    this._state = 'reconnecting';
    this.reconnects += 1;
    const delay = Math.min(30_000, this.baseDelayMs * 2 ** (this.reconnects - 1));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(e => this.onError?.(e));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  onChange(handler: (n: ChangeNotification) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this._state = 'closed';
    this.handlers.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.sql?.end({ timeout: 2 }).catch(() => undefined);
    this.sql = null;
  }
}
