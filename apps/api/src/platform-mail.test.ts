import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSignupWelcome } from './platform-mail.js';

function ctxFor(config: Record<string, unknown>): {
  ctx: Parameters<typeof sendSignupWelcome>[0];
  logs: { level: string; event: string; fields: Record<string, unknown> }[];
  audits: unknown[];
} {
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const audits: unknown[] = [];
  const ctx = {
    config: {
      EMAIL_DRIVER: 'memory',
      RESEND_API_KEY: '',
      RESEND_FROM: '',
      APP_URL: 'https://app.example.com',
      ...config,
    },
    logger: {
      info: (event: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'info', event, fields });
      },
      warn: (event: string, fields: Record<string, unknown>) => {
        logs.push({ level: 'warn', event, fields });
      },
    },
    registry: {
      recordAudit: async (event: string, fields: Record<string, unknown>) => {
        audits.push({ event, fields });
      },
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof sendSignupWelcome>[0], logs, audits };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

describe('centralized signup welcome', () => {
  it('skips honestly without a sender (never fakes delivery, never throws)', async () => {
    const { ctx, logs, audits } = ctxFor({});
    const out = await sendSignupWelcome(ctx, { to: 'New@Example.com', displayName: 'New', userId: 'u1' });
    expect(out).toMatchObject({ delivered: false, skipped: true, provider: 'none' });
    expect(out.reason).toMatch(/no sender configured/);
    expect(audits).toHaveLength(0);
    const evt = logs.find(l => l.event === 'platform.welcome_email');
    expect(evt?.fields['delivered']).toBe(false);
    // Privacy: hashed recipient, never the address or secrets.
    expect(evt?.fields['recipient']).not.toContain('New@Example.com');
    expect(JSON.stringify(logs)).not.toContain('New@Example.com');
  });

  it('sends through the existing Resend integration with metadata + audit', async () => {
    const seen: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: { body?: string }) => {
      seen.push({ url: String(url), body: init.body ?? '' });
      return { ok: true, status: 200, json: async () => ({ id: 're_abc' }) };
    }) as unknown as typeof fetch;
    const { ctx, logs, audits } = ctxFor({
      EMAIL_DRIVER: 'resend',
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'CloudNivo <welcome@example.com>',
    });
    const out = await sendSignupWelcome(ctx, { to: 'new@example.com', displayName: null, userId: 'u1' });
    expect(out).toMatchObject({ delivered: true, provider: 'resend', providerId: 're_abc', skipped: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['to']).toEqual(['new@example.com']);
    expect(body['subject']).toBe('Welcome to CloudNivo');
    // Secret travels only in the Authorization header, never in body/logs.
    expect(JSON.stringify(body)).not.toContain('re_test_key');
    expect(JSON.stringify(logs)).not.toContain('re_test_key');
    expect(audits).toHaveLength(1);
  });

  it('provider failure degrades to skipped (signup flow unaffected)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket hangup');
    }) as unknown as typeof fetch;
    const { ctx, logs } = ctxFor({
      EMAIL_DRIVER: 'resend',
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM: 'welcome@example.com',
    });
    const out = await sendSignupWelcome(ctx, { to: 'new@example.com', userId: 'u1' });
    expect(out.delivered).toBe(false);
    expect(out.reason).toContain('socket hangup');
    expect(logs.some(l => l.event === 'platform.welcome_email' && l.fields['delivered'] === false)).toBe(true);
  });
});
