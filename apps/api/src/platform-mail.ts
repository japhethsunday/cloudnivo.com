import { createHash } from 'node:crypto';
import {
  MemoryEmailService,
  ResendEmailService,
  SmtpEmailService,
  type EmailService,
} from '@cloudnivo/auth';
import type { ApiContext } from './v1.js';

/**
 * Centralized server-side mailer for PLATFORM users (signup welcome,
 * security notices). Customer (per-project) mail flows through the
 * per-project `emailServiceFor` in customer-auth.ts — same drivers, same
 * honesty contract. No email logic lives in the frontend.
 *
 * Rules enforced here:
 * - Resend/SMTP are the only real senders (existing integrations, reused).
 * - Without a configured sender the welcome is SKIPPED and reported as
 *   not-delivered — delivery is never faked.
 * - Sending never throws into the caller: signup must succeed regardless.
 * - Logs carry a recipient hash + provider message id, never addresses or
 *   secrets. The welcome fires exactly once per successful account create;
 *   duplicate signups fail before this hook runs.
 */

function emailServiceFor(ctx: ApiContext): EmailService {
  const c = ctx.config;
  if (c.EMAIL_DRIVER === 'resend' && c.RESEND_API_KEY && c.RESEND_FROM) {
    return new ResendEmailService({ apiKey: c.RESEND_API_KEY, from: c.RESEND_FROM });
  }
  if (c.EMAIL_DRIVER === 'smtp' && c.SMTP_HOST && c.SMTP_FROM) {
    return new SmtpEmailService({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      username: c.SMTP_USERNAME,
      password: c.SMTP_PASSWORD,
      from: c.SMTP_FROM,
      secure: c.SMTP_SECURE,
    });
  }
  if (c.EMAIL_DRIVER !== 'memory') {
    ctx.logger.warn('platform.email_driver_fallback', {
      driver: c.EMAIL_DRIVER,
      note: 'Email sender misconfigured (missing key/host) — welcome email will NOT be delivered',
    });
  }
  return new MemoryEmailService();
}

function recipientHash(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 32);
}

export interface WelcomeResult {
  delivered: boolean;
  provider: string;
  providerId: string | null;
  skipped: boolean;
  reason: string | null;
}

export async function sendSignupWelcome(
  ctx: ApiContext,
  input: { to: string; displayName?: string | null; userId: string },
): Promise<WelcomeResult> {
  const fail = (reason: string): WelcomeResult => {
    ctx.logger.info('platform.welcome_email', {
      type: 'welcome',
      recipient: recipientHash(input.to),
      provider: 'none',
      providerId: null,
      delivered: false,
      reason,
    });
    return { delivered: false, provider: 'none', providerId: null, skipped: true, reason };
  };
  try {
    const email = emailServiceFor(ctx);
    if (email instanceof MemoryEmailService) {
      return fail('no sender configured (set EMAIL_DRIVER=resend with RESEND_API_KEY/RESEND_FROM)');
    }
    const appUrl = (ctx.config.APP_URL ?? '').replace(/\/$/, '') || 'http://localhost:3000';
    const receipt = await email.sendWelcomeEmail(input.to, {
      displayName: input.displayName ?? null,
      appUrl,
      logoUrl: `${appUrl}/icon.svg`,
    });
    ctx.logger.info('platform.welcome_email', {
      type: 'welcome',
      recipient: recipientHash(input.to),
      provider: email.driver,
      providerId: receipt.id,
      delivered: receipt.delivered,
      reason: receipt.delivered ? null : 'provider did not confirm delivery',
    });
    await ctx.registry
      .recordAudit('platform.welcome_email', {
        userId: input.userId,
      })
      .catch(() => undefined);
    return {
      delivered: receipt.delivered,
      provider: email.driver,
      providerId: receipt.id,
      skipped: false,
      reason: receipt.delivered ? null : 'provider did not confirm delivery',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 160) : 'unknown send failure';
    ctx.logger.info('platform.welcome_email', {
      type: 'welcome',
      recipient: recipientHash(input.to),
      provider: 'unknown',
      providerId: null,
      delivered: false,
      reason,
    });
    return { delivered: false, provider: 'unknown', providerId: null, skipped: true, reason };
  }
}
