import { connect, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { buildEmail, buildMagicLinkEmail, buildOtpEmailContent, buildResetEmail, buildSecurityEmail, buildVerifyEmail, buildWelcomeEmail, type BrandContext, type EmailKind, type EmailReceipt, type EmailService, type WelcomeInput } from './email.js';

/**
 * Production email drivers behind the EmailService interface.
 *
 * - `ResendEmailService`: Transactional API over HTTPS (api.resend.com).
 *   The API key lives server-side in env — never in code, logs, or responses.
 * - `SmtpEmailService`: minimal RFC 5321 submission client (EHLO, STARTTLS
 *   when offered/required, AUTH LOGIN/PLAIN, MAIL/RCPT/DATA, QUIT).
 *
 * Both report `delivered` honestly (provider accepted) and throw redacted
 * errors otherwise — callers never mistake a failure for delivery.
 */

export interface ResendConfig {
  apiKey: string;
  from: string;
  timeoutMs?: number;
}

export class ResendEmailService implements EmailService {
  readonly driver = 'resend';
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  /** List-Unsubscribe identity derived from the configured sender (no invented addresses). */
  private unsubscribeHeaders(): Record<string, string> {
    const m = /<([^<>@\s]+@[^<>@\s]+)>/.exec(this.config.from);
    const addr = (m?.[1] ?? this.config.from).trim();
    return addr.includes('@') ? { 'List-Unsubscribe': `<mailto:${addr}>` } : {};
  }
  private async send(to: string, kind: EmailKind, payload: Record<string, string>): Promise<EmailReceipt> {
    if (!this.config.apiKey || !this.config.from) {
      throw new Error('Resend is not configured (apiKey/from required)');
    }
    const { subject, text } = buildEmail(kind, payload);
    return this.sendRaw(to, subject, text);
  }
  private async sendRaw(to: string, subject: string, text: string, html?: string): Promise<EmailReceipt> {
    const unsub = this.unsubscribeHeaders();
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.config.from,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(Object.keys(unsub).length > 0 ? { headers: unsub } : {}),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000),
    });
    if (!res.ok) throw new Error(`Resend rejected the message (${res.status})`);
    const json = (await res.json().catch(() => ({}))) as { id?: unknown };
    return {
      delivered: true,
      queued: true,
      id: typeof json.id === 'string' ? json.id : `resend_${Date.now()}`,
    };
  }
  sendVerificationEmail(to: string, verifyUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildVerifyEmail(verifyUrl, brand);
      return this.sendRaw(to, built.subject, built.text, built.html);
    }
    return this.send(to, 'verify', { url: verifyUrl });
  }
  sendPasswordResetEmail(to: string, resetUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildResetEmail(resetUrl, brand);
      return this.sendRaw(to, built.subject, built.text, built.html);
    }
    return this.send(to, 'reset', { url: resetUrl });
  }
  sendSecurityNotification(to: string, text: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildSecurityEmail(text, brand);
      return this.sendRaw(to, built.subject, built.text, built.html);
    }
    return this.send(to, 'security', { text });
  }
  sendMagicLink(to: string, url: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildMagicLinkEmail(url, brand);
      return this.sendRaw(to, built.subject, built.text, built.html);
    }
    return this.send(to, 'magic', { url });
  }
  sendOtpEmail(to: string, code: string, purpose: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildOtpEmailContent(code, purpose, brand);
      return this.sendRaw(to, built.subject, built.text, built.html);
    }
    return this.send(to, 'otp', { code, purpose });
  }
  async sendWelcomeEmail(to: string, input: WelcomeInput): Promise<EmailReceipt> {
    if (!this.config.apiKey || !this.config.from) {
      throw new Error('Resend is not configured (apiKey/from required)');
    }
    const { subject, text, html } = buildWelcomeEmail(input);
    return this.sendRaw(to, subject, text, html);
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  /** 'starttls' (default, fails when unavailable), 'tls', or 'plain' (local dev only). */
  secure?: 'starttls' | 'tls' | 'plain';
  timeoutMs?: number;
}

function smtpEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

class SmtpConversation {
  private buffer = '';
  private queue: ((line: string) => void)[] = [];
  private failed: ((err: Error) => void)[] = [];
  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += String(chunk);
      let idx: number;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        // Multiline replies (250-...) — wait for the final line (250 ...).
        if (/^\d{3}-/.test(line)) continue;
        const next = this.queue.shift();
        if (next) next(line);
      }
    });
    socket.on('error', err => {
      const next = this.failed.shift();
      if (next) next(err instanceof Error ? err : new Error(String(err)));
    });
  }
  command(cmd: string, expectCode: number, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP timeout on ${cmd.split(' ')[0]}`)), timeoutMs);
      this.queue.push(line => {
        clearTimeout(timer);
        if (Number(line.slice(0, 3)) !== expectCode) {
          reject(new Error(`SMTP rejected command (${line.slice(0, 60)})`));
          return;
        }
        resolve(line);
      });
      this.failed.push(err => {
        clearTimeout(timer);
        reject(err);
      });
      this.socket.write(`${cmd}\r\n`);
    });
  }
  readGreeting(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP greeting timeout')), timeoutMs);
      this.queue.push(line => {
        clearTimeout(timer);
        resolve(line);
      });
      this.failed.push(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  upgradeToTls(host: string): void {
    const tls = connectTls({ socket: this.socket, host, servername: host });
    (this as unknown as { socket: Socket }).socket = tls as unknown as Socket;
    tls.setEncoding('utf8');
    tls.on('data', chunk => {
      this.buffer += String(chunk);
      let idx: number;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue;
        const next = this.queue.shift();
        if (next) next(line);
      }
    });
    tls.on('error', err => {
      const next = this.failed.shift();
      if (next) next(err instanceof Error ? err : new Error(String(err)));
    });
  }
}

export class SmtpEmailService implements EmailService {
  readonly driver = 'smtp';
  constructor(private readonly config: SmtpConfig) {}
  private async sendRaw(to: string, subject: string, text: string, html?: string): Promise<void> {
    const { host, port, username, password, from, secure = 'starttls', timeoutMs = 15000 } = this.config;
    if (!host || !from) throw new Error('SMTP is not configured (host/from required)');
    const initialTls = secure === 'tls';
    const socket: Socket = initialTls
      ? (connectTls({ host, port, servername: host }) as unknown as Socket)
      : connect({ host, port });
    const convo = new SmtpConversation(socket);
    const done = (): void => {
      socket.removeAllListeners();
      socket.destroy();
    };
    try {
      await convo.readGreeting(timeoutMs);
      await convo.command(`EHLO ${host}`, 250, timeoutMs);
      if (secure === 'starttls') {
        await convo.command('STARTTLS', 220, timeoutMs);
        convo.upgradeToTls(host);
        await convo.command(`EHLO ${host}`, 250, timeoutMs);
      }
      if (username) {
        await convo.command('AUTH LOGIN', 334, timeoutMs);
        await convo.command(smtpEncode(username), 334, timeoutMs);
        await convo.command(smtpEncode(password), 235, timeoutMs);
      }
      await convo.command(`MAIL FROM:<${from}>`, 250, timeoutMs);
      await convo.command(`RCPT TO:<${to}>`, 250, timeoutMs);
      await convo.command('DATA', 354, timeoutMs);
      const date = new Date().toUTCString();
      /**
       * Dot-stuffing: a line that begins with "." would end the DATA section
       * early, so each one is doubled (RFC 5321 §4.5.2). This applies to the
       * HTML part too, which is why the escaping is a helper now.
       */
      const stuff = (body: string): string => body.replace(/\r?\n\./g, '\n..');
      const headers = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMIME-Version: 1.0\r\n`;
      /**
       * With HTML, send multipart/alternative so the branded template renders
       * where the client supports it and the plain text stands in where it
       * does not. Without it, SMTP dropped every template on the floor and
       * delivered bare text.
       */
      const body = html
        ? (() => {
            const boundary = `cn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            return (
              `${headers}Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
              `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${stuff(text)}\r\n` +
              `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${stuff(html)}\r\n` +
              `--${boundary}--`
            );
          })()
        : `${headers}Content-Type: text/plain; charset=utf-8\r\n\r\n${stuff(text)}`;
      await convo.command(`${body}\r\n.`, 250, timeoutMs);
      await convo.command('QUIT', 221, timeoutMs).catch(() => undefined);
    } finally {
      done();
    }
  }
  private async send(to: string, kind: EmailKind, payload: Record<string, string>): Promise<EmailReceipt> {
    const { subject, text } = buildEmail(kind, payload);
    await this.sendRaw(to, subject, text);
    return { delivered: true, queued: true, id: `smtp_${Date.now()}` };
  }
  sendVerificationEmail(to: string, verifyUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) return this.sendBuilt(buildVerifyEmail(verifyUrl, brand), to);
    return this.send(to, 'verify', { url: verifyUrl });
  }
  sendPasswordResetEmail(to: string, resetUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) return this.sendBuilt(buildResetEmail(resetUrl, brand), to);
    return this.send(to, 'reset', { url: resetUrl });
  }
  sendSecurityNotification(to: string, text: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) return this.sendBuilt(buildSecurityEmail(text, brand), to);
    return this.send(to, 'security', { text });
  }
  sendMagicLink(to: string, url: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) return this.sendBuilt(buildMagicLinkEmail(url, brand), to);
    return this.send(to, 'magic', { url });
  }
  sendOtpEmail(
    to: string,
    code: string,
    purpose: string,
    brand?: BrandContext,
  ): Promise<EmailReceipt> {
    if (brand) return this.sendBuilt(buildOtpEmailContent(code, purpose, brand), to);
    return this.send(to, 'otp', { code, purpose });
  }
  async sendWelcomeEmail(to: string, input: WelcomeInput): Promise<EmailReceipt> {
    return this.sendBuilt(buildWelcomeEmail(input), to);
  }

  /** One place where a built template becomes an SMTP message. */
  private async sendBuilt(
    built: { subject: string; text: string; html?: string },
    to: string,
  ): Promise<EmailReceipt> {
    await this.sendRaw(to, built.subject, built.text, built.html);
    return { delivered: true, queued: true, id: `smtp_${Date.now()}` };
  }
}

export type EmailDriver = 'memory' | 'resend' | 'smtp';
