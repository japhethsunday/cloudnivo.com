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
  kind: 'verify' | 'reset' | 'security';
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
}

let emailCounter = 0;

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
    return this.push({
      to,
      subject: 'Verify your email',
      text: `Verify your email: ${verifyUrl}`,
      kind: 'verify',
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<EmailReceipt> {
    return this.push({
      to,
      subject: 'Reset your password',
      text: `Reset your password: ${resetUrl}`,
      kind: 'reset',
    });
  }

  async sendSecurityNotification(to: string, text: string): Promise<EmailReceipt> {
    return this.push({ to, subject: 'Security notice', text, kind: 'security' });
  }

  async sendMagicLink(to: string, url: string): Promise<EmailReceipt> {
    return this.push({ to, subject: 'Your sign-in link', text: `Sign in: ${url}`, kind: 'verify' });
  }

  lastTo(to: string): { id: string; text: string } | null {
    const found = [...this.outbox].reverse().find(m => m.to === to);
    return found ? { id: found.id, text: found.text } : null;
  }
}
