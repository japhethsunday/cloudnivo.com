import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

/**
 * End-to-end proof (no real provider): with EMAIL_DRIVER=resend, a platform
 * signup triggers exactly one welcome request to api.resend.com with the
 * branded subject, and signup itself still returns 201 + session.
 */
describe('signup triggers welcome email', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  const seen: { url: string; body: string; auth: string | null }[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.JWT_SECRET = 'w'.repeat(48);
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.CACHE_DRIVER = 'memory';
    process.env.PROVISION_DRIVER = 'fake';
    process.env.EMAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'CloudNivo <welcome@example.com>';
    process.env.APP_URL = 'https://app.example.com';
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      if (String(url).includes('api.resend.com')) {
        seen.push({ url: String(url), body: init.body ?? '', auth: init.headers?.['Authorization'] ?? null });
        return { ok: true, status: 200, json: async () => ({ id: 're_w1' }) } as unknown as Response;
      }
      return realFetch(url as unknown as URL, init);
    }) as unknown as typeof fetch;
    const { start } = await import('./index.js');
    const { server, port } = await start(0);
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((resolve, reject) => (server as Server).close(e => (e ? reject(e) : resolve())));
  });

  afterAll(async () => {
    await close();
  });

  it('signup succeeds and emits one branded welcome', async () => {
    const res = await fetch(`${base}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'welc@example.com', password: 'long-enough-1', displayName: 'Welc' }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { user: { id: string }; token: string } };
    expect(json.data.token).toBeDefined();
    // Welcome is fire-and-forget: allow the hook a moment, then assert.
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['from']).toBe('CloudNivo <welcome@example.com>');
    expect(body['to']).toEqual(['welc@example.com']);
    expect(body['subject']).toBe('Welcome to CloudNivo');
    expect(String(body['html'])).toContain('Hi Welc,');
    expect(String(body['html'])).toContain('https://app.example.com/icon.svg');
    expect(String(body['html'])).toContain('href="https://app.example.com"');
    expect(body['text']).toBeDefined();
  });
});
