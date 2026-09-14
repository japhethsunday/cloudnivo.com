import { describe, expect, it } from 'vitest';
import {
  buildWelcomeEmail,
  escapeHtml,
  MemoryEmailService,
} from './email.js';
import { ResendEmailService } from './email-providers.js';

const INPUT = {
  displayName: 'Ada',
  appUrl: 'https://app.example.com',
  logoUrl: 'https://app.example.com/icon.svg',
};

describe('welcome template', () => {
  it('renders subject, greeting, CTA and footer from caller input only', () => {
    const built = buildWelcomeEmail(INPUT);
    expect(built.subject).toBe('Welcome to CloudNivo');
    expect(built.text).toContain('Hi Ada,');
    expect(built.html).toContain('Hi Ada,');
    expect(built.text).toContain('Open CloudNivo: https://app.example.com');
    expect(built.html).toContain('href="https://app.example.com"');
    expect(built.html).toContain('>Open CloudNivo</a>');
    expect(built.html).toContain('src="https://app.example.com/icon.svg"');
    expect(built.html).toContain('href="https://app.example.com/developer"');
    expect(built.html).toContain('href="https://app.example.com/#security"');
    for (const cap of ['PostgreSQL', 'Authentication', 'Storage', 'Realtime', 'Functions', 'AI', 'Security', 'Observability']) {
      expect(built.text).toContain(cap);
      expect(built.html).toContain(cap);
    }
    expect(built.html).not.toContain('<script');
    expect(built.html).toContain('<table');
  });

  it('emits balanced, responsive email-safe markup', () => {
    const { html } = buildWelcomeEmail(INPUT);
    for (const tag of ['html', 'body', 'table', 'tr', 'td', 'ul', 'li', 'a', 'div']) {
      const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
      const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(open, `<${tag}> balanced`).toBe(close);
      expect(open, `<${tag}> present`).toBeGreaterThan(0);
    }
    expect(html).toContain('viewport');
    expect(html).toContain('max-width:600px');
  });

  it('falls back to a neutral greeting without a name', () => {    const built = buildWelcomeEmail({ ...INPUT, displayName: null });
    expect(built.text).toContain('Hi there,');
    expect(built.html).toContain('Hi there,');
  });

  it('escapes user-controlled names (no injection, no secrets)', () => {
    const built = buildWelcomeEmail({ ...INPUT, displayName: '<img src=x onerror=1> "Ada" & co' });
    expect(built.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(built.html).not.toContain('<img src=x onerror=1>');
    expect(JSON.stringify(built)).not.toContain('re_');
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
});

describe('welcome delivery', () => {
  it('resend posts subject+text+html with the configured sender', async () => {
    const seen: { url: string; body: string; auth: string | null }[] = [];
    const stubFetch = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      seen.push({ url, body: init.body ?? '', auth: init.headers?.['Authorization'] ?? null });
      return { ok: true, status: 200, json: async () => ({ id: 're_welcome1' }) };
    }) as unknown as typeof fetch;
    const svc = new ResendEmailService({ apiKey: 're_test', from: 'welcome@example.com' }, stubFetch);
    const receipt = await svc.sendWelcomeEmail('new@example.com', INPUT);
    expect(receipt).toMatchObject({ delivered: true, id: 're_welcome1' });
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    expect(body['from']).toBe('welcome@example.com');
    expect(body['to']).toEqual(['new@example.com']);
    expect(body['subject']).toBe('Welcome to CloudNivo');
    expect(String(body['html'])).toContain('Open CloudNivo');
    expect(String(body['html'])).toContain('https://app.example.com/icon.svg');
  });

  it('resend failure is honest (throws, never fake-delivers)', async () => {
    const stubFetch = (async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(
      new ResendEmailService({ apiKey: 'k', from: 'f@x.com' }, stubFetch).sendWelcomeEmail('a@b.c', INPUT),
    ).rejects.toThrow(/422/);
  });

  it('memory driver records honestly without delivering', async () => {
    const svc = new MemoryEmailService();
    const receipt = await svc.sendWelcomeEmail('new@example.com', INPUT);
    expect(receipt.delivered).toBe(false);
    expect(svc.outbox).toHaveLength(1);
    expect(svc.outbox[0]?.kind).toBe('welcome');
    expect(svc.outbox[0]?.subject).toBe('Welcome to CloudNivo');
  });
});
