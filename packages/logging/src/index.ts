/**
 * Structured, redacting logger.
 *
 * Security rules enforced here (not left to callers):
 * - Never log values of keys matching sensitive patterns (tokens, secrets,
 *   passwords, authorization headers, connection strings with credentials).
 * - Always support a `requestId` field for tracing without PII.
 * - JSON to stdout so Vercel / Docker log collectors work unchanged.
 */

import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /(password|passwd|secret|token|api[_-]?key|auth|credential|private|session|cookie)/i;

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    // Redact embedded credentials in URLs (postgres://user:pass@host, redis://:pass@…).
    if (/^(postgres(ql)?:\/\/|redis:\/\/|rediss:\/\/)/i.test(value)) return '[REDACTED_CONNECTION]';
    if (/^Bearer\s+/i.test(value)) return '[REDACTED]';
  }
  return value;
}

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map(item =>
        item !== null && typeof item === 'object'
          ? redact(item as Record<string, unknown>)
          : redactValue(k, item),
      );
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  service?: string;
  pretty?: boolean;
}

export interface LogFields {
  requestId?: string;
  [key: string]: unknown;
}

export class Logger {
  private level: LogLevel;
  private service: string;

  constructor(opts: LoggerOptions = {}) {
    const envLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
    this.level = opts.level ?? envLevel;
    this.service = opts.service ?? 'cloudnivo';
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (!this.enabled(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg,
      ...redact(fields as Record<string, unknown>),
    };
    // error → stderr, everything else → stdout (12-factor).
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  child(defaults: LogFields): Logger {
    const childLogger = new Logger({ level: this.level, service: this.service });
    const wrap =
      (level: LogLevel) =>
      (msg: string, fields: LogFields = {}): void => {
        childLogger.emit(level, msg, { ...defaults, ...fields });
      };
    childLogger.debug = wrap('debug');
    childLogger.info = wrap('info');
    childLogger.warn = wrap('warn');
    childLogger.error = wrap('error');
    return childLogger;
  }
}

export function createLogger(opts?: LoggerOptions): Logger {
  return new Logger(opts);
}

/** Generate a request ID without external deps (Node 20+: crypto.randomUUID). */
export function newRequestId(): string {
  return randomUUID();
}
