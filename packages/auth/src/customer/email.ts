/**
 * Email provider abstraction.
 *
 * `MemoryEmailService` is the local/dev driver: messages land in an inspectable
 * outbox and are honestly reported as queued-not-delivered. Production wires an
 * SMTP/transactional driver behind the same interface — no caller changes.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  kind: 'verify' | 'reset' | 'security' | 'otp' | 'magic';
}

export interface EmailReceipt {
  /** True only when a real provider accepted the message. */
  delivered: boolean;
  queued: boolean;
  id: string;
}

export interface EmailService {
  readonly driver: string;
  sendVerificationEmail(to: string, verifyUrl: string): Promise<EmailReceipt>;
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<EmailReceipt>;
  sendSecurityNotification(to: string, text: string): Promise<EmailReceipt>;
  sendMagicLink(to: string, url: string): Promise<EmailReceipt>;
  sendOtpEmail(to: string, code: string, purpose: string): Promise<EmailReceipt>;
}

let emailCounter = 0;

export type EmailKind = EmailMessage['kind'];

/** Shared templates — every driver sends identical content. */
export function buildEmail(
  kind: EmailKind,
  payload: { url?: string; code?: string; purpose?: string; text?: string },
): { subject: string; text: string } {
  switch (kind) {
    case 'verify':
      return { subject: 'Verify your email', text: `Verify your email: ${payload.url ?? ''}` };
    case 'reset':
      return { subject: 'Reset your password', text: `Reset your password: ${payload.url ?? ''}` };
    case 'magic':
      return { subject: 'Your sign-in link', text: `Sign in: ${payload.url ?? ''}` };
    case 'otp':
      return {
        subject: 'Your verification code',
        text: `Your CloudNivo code for ${payload.purpose ?? 'verification'} is: ${payload.code ?? ''}. It expires in 10 minutes.`,
      };
    case 'security':
      return { subject: 'Security notice', text: payload.text ?? '' };
  }
}

export class MemoryEmailService implements EmailService {
  readonly driver = 'memory';
  readonly outbox: (EmailMessage & { id: string; at: string })[] = [];

  private push(msg: EmailMessage): EmailReceipt {
    emailCounter += 1;
    const id = `email_${emailCounter}`;
    this.outbox.push({ ...msg, id, at: new Date().toISOString() });
    // Honest: queued locally, NOT delivered. Never claim otherwise.
    return { delivered: false, queued: true, id };
  }

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<EmailReceipt> {
    const { subject, text } = buildEmail('verify', { url: verifyUrl });
    return this.push({ to, subject, text, kind: 'verify' });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<EmailReceipt> {
    const { subject, text } = buildEmail('reset', { url: resetUrl });
    return this.push({ to, subject, text, kind: 'reset' });
  }

  async sendSecurityNotification(to: string, text: string): Promise<EmailReceipt> {
    const built = buildEmail('security', { text });
    return this.push({ to, subject: built.subject, text: built.text, kind: 'security' });
  }

  async sendMagicLink(to: string, url: string): Promise<EmailReceipt> {
    const { subject, text } = buildEmail('magic', { url });
    return this.push({ to, subject, text, kind: 'magic' });
  }

  async sendOtpEmail(to: string, code: string, purpose: string): Promise<EmailReceipt> {
    const { subject, text } = buildEmail('otp', { code, purpose });
    return this.push({ to, subject, text, kind: 'otp' });
  }

  lastTo(to: string): { id: string; text: string } | null {
    const found = [...this.outbox].reverse().find(m => m.to === to);
    return found ? { id: found.id, text: found.text } : null;
  }
}
