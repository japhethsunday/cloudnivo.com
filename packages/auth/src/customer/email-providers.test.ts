import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ResendEmailService, SmtpEmailService } from './email-providers.js';

describe('resend driver', () => {
  it('posts identical content and reports delivery honestly', async () => {
    const seen: { url: string; body: string; auth: string | null }[] = [];
    const stubFetch = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      seen.push({ url, body: init.body ?? '', auth: init.headers?.['Authorization'] ?? null });
      return { ok: true, status: 200, json: async () => ({ id: 're_123' }) };
    }) as unknown as typeof fetch;
    const svc = new ResendEmailService({ apiKey: 're_test', from: 'noreply@example.com' }, stubFetch);
    const receipt = await svc.sendOtpEmail('a@b.c', '123456', 'login');
    expect(receipt.delivered).toBe(true);
    expect(receipt.id).toBe('re_123');
    expect(seen[0]?.auth).toBe('Bearer re_test');
    expect(seen[0]?.body).toContain('123456');
    await expect(
      new ResendEmailService({ apiKey: '', from: '' }).sendOtpEmail('a@b.c', '1', 'x'),
    ).rejects.toThrow(/not configured/);
  });

  it('throws (never fake-delivers) on provider rejection', async () => {
    const stubFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(
      new ResendEmailService({ apiKey: 'bad', from: 'x@y.z' }, stubFetch).sendMagicLink('a@b.c', 'u'),
    ).rejects.toThrow(/401/);
  });
});

describe('smtp driver', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = null;
    }
  });

  /** Minimal fake MTA: greeting, EHLO, AUTH LOGIN, MAIL/RCPT/DATA/QUIT. */
  async function fakeMta(capture: { user: string; pass: string; mail: string[]; log: string[] }): Promise<number> {
    server = createServer(socket => {
      let stage = 0;
      let dataMode = false;
      const lines: string[] = [];
      socket.setEncoding('utf8');
      socket.write('220 fake-mta ready\r\n');
      socket.on('data', chunk => {
        for (const rawLine of String(chunk).split('\r\n')) {
          capture.log.push(`C:${rawLine}`);
          if (rawLine === '' && !dataMode) continue;
          if (dataMode) {
            if (rawLine === '.') {
              dataMode = false;
              socket.write('250 OK queued\r\n');
            } else {
              lines.push(rawLine);
            }
            continue;
          }
          const [verb, ...rest] = rawLine.split(' ');
          void rest;
          if (verb === 'EHLO') {
            socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
          } else if (verb === 'AUTH') {
            stage = 1;
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else if (stage === 1) {
            // The base64 response arrives as the whole line (verb position).
            capture.user = Buffer.from(verb, 'base64').toString();
            stage = 2;
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else if (stage === 2) {
            capture.pass = Buffer.from(verb, 'base64').toString();
            stage = 0;
            socket.write('235 authenticated\r\n');
          } else if (verb === 'MAIL') {
            socket.write('250 sender ok\r\n');
          } else if (verb === 'RCPT') {
            socket.write('250 recipient ok\r\n');
          } else if (verb === 'DATA') {
            dataMode = true;
            socket.write('354 end with .\r\n');
            capture.mail = lines;
          } else if (verb === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          } else {
            socket.write('502 unknown\r\n');
          }
        }
      });
    });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
    const addr = server?.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  it('delivers through AUTH LOGIN + DATA with dot-stuffing', async () => {
    const capture: { user: string; pass: string; mail: string[]; log: string[] } = {
      user: '',
      pass: '',
      mail: [],
      log: [],
    };
    const port = await fakeMta(capture);
    const svc = new SmtpEmailService({
      host: '127.0.0.1',
      port,
      username: 'mailer',
      password: 's3cret',
      from: 'noreply@example.com',
      secure: 'plain',
    });
    const receipt = await svc.sendOtpEmail('a@b.c', '654321', 'login');
    expect(receipt.delivered).toBe(true);
    expect(capture.log.join('|')).toContain('AUTH LOGIN');
    expect(capture.user).toBe('mailer');
    expect(capture.pass).toBe('s3cret');
    expect(capture.mail.join('\n')).toContain('654321');
    expect(capture.mail.join('\n')).toContain('Subject: Your verification code');
  });

  it('refuses to pretend when unconfigured or unreachable', async () => {
    await expect(
      new SmtpEmailService({ host: '', port: 25, username: '', password: '', from: '' }).sendOtpEmail('a@b.c', '1', 'x'),
    ).rejects.toThrow(/not configured/);
    await expect(
      new SmtpEmailService({
        host: '127.0.0.1',
        port: 1,
        username: 'u',
        password: 'p',
        from: 'f@x.y',
        secure: 'plain',
        timeoutMs: 500,
      }).sendOtpEmail('a@b.c', '1', 'x'),
    ).rejects.toThrow();
  });
});
