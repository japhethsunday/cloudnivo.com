/**
 * SMS provider abstraction for phone OTP (and WhatsApp via provider-specific
 * `channel` where supported). Drivers:
 * - `memory`/dev: records into an inspectable outbox, honestly undelivered.
 * - `http`: generic JSON webhook driver (Twilio-shaped or any gateway) —
 *   credentials stay server-side in env, never in code/logs/responses.
 *
 * Phone delivery REQUIRES provider credentials, so production phone OTP is
 * gated on configuration; without it the API refuses with a clear error
 * instead of pretending to send.
 */

export interface SmsMessage {
  to: string;
  body: string;
  channel: 'sms' | 'whatsapp';
}

export interface SmsReceipt {
  delivered: boolean;
  queued: boolean;
  id: string;
  driver: string;
}

export interface SmsService {
  readonly driver: string;
  send(message: SmsMessage): Promise<SmsReceipt>;
}

let smsCounter = 0;

export class MemorySmsService implements SmsService {
  readonly driver = 'memory';
  readonly outbox: (SmsMessage & { id: string; at: string })[] = [];
  async send(message: SmsMessage): Promise<SmsReceipt> {
    smsCounter += 1;
    const id = `sms_${smsCounter}`;
    this.outbox.push({ ...message, id, at: new Date().toISOString() });
    return { delivered: false, queued: true, id, driver: this.driver };
  }
  lastTo(to: string): { id: string; body: string } | null {
    const found = [...this.outbox].reverse().find(m => m.to === to);
    return found ? { id: found.id, body: found.body } : null;
  }
}

export interface HttpSmsConfig {
  endpoint: string;
  apiKey: string;
  /** Template with {{to}}, {{body}}, {{channel}} placeholders. */
  bodyTemplate?: string;
  timeoutMs?: number;
}

/** Generic HTTP SMS gateway. Throws honestly when unconfigured. */
export class HttpSmsService implements SmsService {
  readonly driver = 'http';
  constructor(private readonly config: HttpSmsConfig) {}
  async send(message: SmsMessage): Promise<SmsReceipt> {
    if (!this.config.endpoint || !this.config.apiKey) {
      throw new Error('SMS provider not configured (endpoint/apiKey required)');
    }
    const payload = (this.config.bodyTemplate ??
      '{"to":"{{to}}","body":"{{body}}","channel":"{{channel}}"}')
      .replace('{{to}}', message.to)
      .replace('{{body}}', message.body)
      .replace('{{channel}}', message.channel);
    const res = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: payload,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
    });
    if (!res.ok) throw new Error(`SMS provider rejected the message (${res.status})`);
    smsCounter += 1;
    return { delivered: true, queued: true, id: `sms_${smsCounter}`, driver: this.driver };
  }
}

export function isValidPhone(to: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(to.trim());
}
