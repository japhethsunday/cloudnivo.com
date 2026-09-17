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
  html?: string;
  kind: 'verify' | 'reset' | 'security' | 'otp' | 'magic' | 'welcome';
}

export interface EmailReceipt {
  /** True only when a real provider accepted the message. */
  delivered: boolean;
  queued: boolean;
  id: string;
}

export interface EmailService {
  readonly driver: string;
  sendVerificationEmail(to: string, verifyUrl: string, brand?: BrandContext): Promise<EmailReceipt>;
  sendPasswordResetEmail(to: string, resetUrl: string, brand?: BrandContext): Promise<EmailReceipt>;
  sendSecurityNotification(to: string, text: string, brand?: BrandContext): Promise<EmailReceipt>;
  sendMagicLink(to: string, url: string, brand?: BrandContext): Promise<EmailReceipt>;
  sendOtpEmail(to: string, code: string, purpose: string, brand?: BrandContext): Promise<EmailReceipt>;
  sendWelcomeEmail(to: string, input: WelcomeInput): Promise<EmailReceipt>;
}

export interface WelcomeInput {
  /** Display name for the greeting; falls back to a neutral greeting. */
  displayName?: string | null;
  /** Absolute URL of the production application (CTA target). */
  appUrl: string;
  /** Absolute URL of the CloudNivo mark for email clients. */
  logoUrl: string;
}

/** Branding context for transactional templates (logo + real links). */
export interface BrandContext {
  appUrl: string;
  logoUrl: string;
}

function brandFooterText(appUrl: string): string[] {
  return [
    'Helpful links:',
    `Documentation: ${appUrl}/developer`,
    `Security: ${appUrl}/#security`,
    '',
    'Questions? Just reply to this email.',
  ];
}

function brandFooterHtml(appUrl: string): string {
  return `<a href="${appUrl}/developer" style="color:#2e6fe8;text-decoration:none;">Documentation</a> &nbsp;·&nbsp; <a href="${appUrl}/#security" style="color:#2e6fe8;text-decoration:none;">Security</a><div style="margin-top:8px;">Questions? Just reply to this email.</div>`;
}

interface ActionContent {
  subject: string;
  intro: string[];
  bullets?: string[];
  code?: string;
  action?: { label: string; url: string };
  closing?: string[];
}

/**
 * Shared premium shell for transactional emails: light card, brand blue,
 * logo header, single CTA, real-link footer. Email-safe table HTML, no JS.
 */
/**
 * Intro and closing paragraphs are authored as HTML fragments (a builder may
 * bold an organization name), and the same strings feed the plain-text part.
 * Without this, a text-only client received "<strong>Northwind</strong>"
 * literally. Tags go, entities come back to their characters.
 */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function buildActionEmail(content: ActionContent, brand: BrandContext): WelcomeContent {
  const { subject } = content;
  const text: string[] = [subject, '', ...content.intro.map(toPlainText), ''];
  if (content.bullets) {
    text.push(...content.bullets.map(b => `• ${toPlainText(b)}`), '');
  }
  if (content.code) {
    text.push(`Code: ${content.code}`, '');
  }
  if (content.action) {
    text.push(`${content.action.label}: ${content.action.url}`, '');
  }
  if (content.closing) {
    text.push(...content.closing.map(toPlainText), '');
  }
  text.push(...brandFooterText(brand.appUrl));
  const bullets = content.bullets
    ? `<ul style="margin:8px 0 0;padding-left:20px;">${content.bullets.map(b => `<li style="margin:0 0 6px;">${b}</li>`).join('')}</ul>`
    : '';
  const code = content.code
    ? `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:0.2em;color:#101828;background-color:#f1f5f9;border:1px solid #e6ebf2;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">${escapeHtml(content.code)}</div>`
    : '';
  const action = content.action
    ? `<tr><td style="padding:24px 32px;"><a href="${content.action.url}" style="display:inline-block;background-color:#2e6fe8;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">${content.action.label}</a></td></tr>`
    : '';
  const closing = (content.closing ?? [])
    .map(p => `<tr><td style="padding:8px 32px 0;font-size:14px;line-height:22px;color:#667085;">${p}</td></tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background-color:#f4f6fb;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fb;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e6ebf2;border-radius:12px;overflow:hidden;"><tr><td style="padding:32px 32px 8px;"><img src="${brand.logoUrl}" alt="CloudNivo" width="36" height="36" style="display:block;border:0;border-radius:8px;"><div style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#101828;margin-top:12px;">CloudNivo</div></td></tr><tr><td style="padding:8px 32px 0;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#101828;">${subject}</td></tr>${content.intro.map(p => `<tr><td style="padding:12px 32px 0;font-size:15px;line-height:24px;color:#344054;">${p}</td></tr>`).join('')}${bullets ? `<tr><td style="padding:8px 32px 0;font-size:15px;line-height:24px;color:#344054;">${bullets}</td></tr>` : ''}${code ? `<tr><td style="padding:8px 32px 0;">${code}</td></tr>` : ''}${action}${closing}<tr><td style="padding:24px 32px 32px;font-size:13px;line-height:20px;color:#667085;border-top:1px solid #e6ebf2;">${brandFooterHtml(brand.appUrl)}</td></tr></table></td></tr></table></body></html>`;
  return { subject, text: text.join('\n'), html };
}

/** Email verification link. */
export function buildVerifyEmail(url: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    {
      subject: 'Verify your email',
      intro: ['Confirm this address to finish setting up your account. The link expires soon and can only be used once.'],
      action: { label: 'Verify email', url },
    },
    brand,
  );
}

/** Password reset link. */
export function buildResetEmail(url: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    {
      subject: 'Reset your password',
      intro: ['Someone requested a password reset. If that was you, choose a new password with the button below. The link expires soon and can only be used once.'],
      action: { label: 'Reset password', url },
      closing: ['Didn’t ask for this? Your password stays unchanged — you can ignore this email.'],
    },
    brand,
  );
}

/** One-time passcode. */
export function buildOtpEmailContent(code: string, purpose: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    {
      subject: 'Your verification code',
      intro: [`Your CloudNivo code for ${escapeHtml(purpose)} is below. It expires in 10 minutes and allows 5 attempts.`],
      code,
    },
    brand,
  );
}

/** Passwordless magic link. */
export function buildMagicLinkEmail(url: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    {
      subject: 'Your sign-in link',
      intro: ['Click below to sign in — no password needed. The link expires soon and can only be used once.'],
      action: { label: 'Sign in', url },
    },
    brand,
  );
}

/** Free-form security notice. */
export function buildSecurityEmail(text: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    { subject: 'Security notice', intro: [escapeHtml(text)] },
    brand,
  );
}

/**
 * New-address verification (dormant template: the email-change flow returns
 * its token directly today; use this if that flow ever mails the link).
 */
export function buildEmailChangeEmail(newEmail: string, url: string, brand: BrandContext): WelcomeContent {
  return buildActionEmail(
    {
      subject: 'Confirm your new email address',
      intro: [`You asked to change your CloudNivo sign-in address to ${escapeHtml(newEmail)}. Confirm it with the button below — the link expires in 15 minutes.`],
      action: { label: 'Confirm new address', url },
    },
    brand,
  );
}

/**
 * Organization invitation (dormant template: invites return a token for
 * manual sharing today; use this if invites ever mail the link).
 */
export function buildInviteEmail(input: { orgName: string; inviter?: string | null; acceptUrl: string; role?: string }, brand: BrandContext): WelcomeContent {
  const who = input.inviter ? `${escapeHtml(input.inviter)} invited you` : 'You were invited';
  return buildActionEmail(
    {
      subject: `Join ${input.orgName} on CloudNivo`,
      intro: [`${who} to collaborate${input.role ? ` as ${escapeHtml(input.role)}` : ''} in the <strong>${escapeHtml(input.orgName)}</strong> organization. Accept the invitation to get access to its projects.`],
      action: { label: 'Accept invitation', url: input.acceptUrl },
    },
    brand,
  );
}

export interface WelcomeContent {
  subject: string;
  text: string;
  html: string;
}

/** Minimal HTML escaping for user-controlled values inside the template. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const WELCOME_CAPABILITIES = [
  'PostgreSQL — an isolated database per project',
  'Authentication — users, sessions, OTP and MFA',
  'API — auto-generated REST with live OpenAPI docs',
  'Storage — buckets, files and signed URLs',
  'Realtime — channels, presence and change feeds',
  'Functions — versioned serverless deploys with rollback',
  'AI — plan, review and apply backend changes safely',
  'Security — posture scans, scoped credentials, approval gates',
  'Observability — metrics, logs and metered usage',
];

/**
 * Premium branded welcome email (text + email-safe table HTML, no JS).
 * Only real product capabilities, only caller-supplied links — no invented
 * company details, addresses, or claims.
 */
export function buildWelcomeEmail(input: WelcomeInput): WelcomeContent {
  const name = (input.displayName ?? '').trim();
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const greetingHtml = name ? `Hi ${escapeHtml(name)},` : 'Hi there,';
  const subject = 'Welcome to CloudNivo';
  const text = [
    subject,
    '',
    greeting,
    '',
    'Your CloudNivo workspace is ready. CloudNivo is a developer platform for building backend applications — one control plane for your database, users, APIs and infrastructure.',
    '',
    'What you can do:',
    ...WELCOME_CAPABILITIES.map(c => `• ${c}`),
    '',
    `Open CloudNivo: ${input.appUrl}`,
    '',
    'Helpful links:',
    `Documentation: ${input.appUrl}/developer`,
    `Security: ${input.appUrl}/#security`,
    '',
    'Questions? Just reply to this email.',
  ].join('\n');
  const caps = WELCOME_CAPABILITIES.map(c => `<li style="margin:0 0 6px;">${c}</li>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background-color:#f4f6fb;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fb;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e6ebf2;border-radius:12px;overflow:hidden;"><tr><td style="padding:32px 32px 8px;"><img src="${input.logoUrl}" alt="CloudNivo" width="36" height="36" style="display:block;border:0;border-radius:8px;"><div style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#101828;margin-top:12px;">CloudNivo</div></td></tr><tr><td style="padding:8px 32px 0;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#101828;">${subject}</td></tr><tr><td style="padding:12px 32px 0;font-size:15px;line-height:24px;color:#344054;">${greetingHtml}</td></tr><tr><td style="padding:12px 32px 0;font-size:15px;line-height:24px;color:#344054;">Your workspace is ready. CloudNivo is a developer platform for building backend applications — one control plane for your database, users, APIs and infrastructure.</td></tr><tr><td style="padding:16px 32px 0;font-size:15px;line-height:24px;color:#344054;"><div style="font-weight:700;color:#101828;margin-bottom:8px;">What you can do</div><ul style="margin:0;padding-left:20px;">${caps}</ul></td></tr><tr><td style="padding:24px 32px;"><a href="${input.appUrl}" style="display:inline-block;background-color:#2e6fe8;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">Open CloudNivo</a></td></tr><tr><td style="padding:8px 32px 32px;font-size:13px;line-height:20px;color:#667085;border-top:1px solid #e6ebf2;"><a href="${input.appUrl}/developer" style="color:#2e6fe8;text-decoration:none;">Documentation</a> &nbsp;·&nbsp; <a href="${input.appUrl}/#security" style="color:#2e6fe8;text-decoration:none;">Security</a><div style="margin-top:8px;">Questions? Just reply to this email.</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
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
    case 'welcome':
      // Branded welcome content lives in buildWelcomeEmail (needs
      // displayName/URLs); this is only a type-level fallback, never used
      // by the dedicated sendWelcomeEmail paths.
      return { subject: 'Welcome to CloudNivo', text: payload.text ?? '' };
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

  async sendVerificationEmail(to: string, verifyUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildVerifyEmail(verifyUrl, brand);
      return this.push({ to, subject: built.subject, text: built.text, html: built.html, kind: 'verify' });
    }
    const { subject, text } = buildEmail('verify', { url: verifyUrl });
    return this.push({ to, subject, text, kind: 'verify' });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildResetEmail(resetUrl, brand);
      return this.push({ to, subject: built.subject, text: built.text, html: built.html, kind: 'reset' });
    }
    const { subject, text } = buildEmail('reset', { url: resetUrl });
    return this.push({ to, subject, text, kind: 'reset' });
  }

  async sendSecurityNotification(to: string, text: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildSecurityEmail(text, brand);
      return this.push({ to, subject: built.subject, text: built.text, html: built.html, kind: 'security' });
    }
    const built = buildEmail('security', { text });
    return this.push({ to, subject: built.subject, text: built.text, kind: 'security' });
  }

  async sendMagicLink(to: string, url: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildMagicLinkEmail(url, brand);
      return this.push({ to, subject: built.subject, text: built.text, html: built.html, kind: 'magic' });
    }
    const { subject, text } = buildEmail('magic', { url });
    return this.push({ to, subject, text, kind: 'magic' });
  }

  async sendOtpEmail(to: string, code: string, purpose: string, brand?: BrandContext): Promise<EmailReceipt> {
    if (brand) {
      const built = buildOtpEmailContent(code, purpose, brand);
      return this.push({ to, subject: built.subject, text: built.text, html: built.html, kind: 'otp' });
    }
    const { subject, text } = buildEmail('otp', { code, purpose });
    return this.push({ to, subject, text, kind: 'otp' });
  }

  async sendWelcomeEmail(to: string, input: WelcomeInput): Promise<EmailReceipt> {
    const { subject, text } = buildWelcomeEmail(input);
    return this.push({ to, subject, text, kind: 'welcome' });
  }

  lastTo(to: string): { id: string; text: string } | null {
    const found = [...this.outbox].reverse().find(m => m.to === to);
    return found ? { id: found.id, text: found.text } : null;
  }
}
