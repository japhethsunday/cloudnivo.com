import { describe, expect, it, vi } from 'vitest';
import { Logger, redact } from './index.js';

describe('redact', () => {
  it('redacts sensitive keys', () => {
    const out = redact({ user: 'a@b.c', password: 's3cret', apiKey: 'k', nested: { token: 't' } });
    expect(out['password']).toBe('[REDACTED]');
    expect(out['apiKey']).toBe('[REDACTED]');
    expect((out['nested'] as Record<string, unknown>)['token']).toBe('[REDACTED]');
    expect(out['user']).toBe('a@b.c');
  });

  it('redacts connection strings and bearer tokens', () => {
    const out = redact({
      url: 'postgres://user:pass@localhost:5432/db',
      auth: 'Bearer abc123',
    });
    expect(out['url']).toBe('[REDACTED_CONNECTION]');
    expect(out['auth']).toBe('[REDACTED]');
  });
});

describe('Logger', () => {
  it('emits JSON without sensitive values', () => {
    const logger = new Logger({ level: 'debug', service: 'test' });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.info('hello', { requestId: 'r1', password: 'x', safe: 1 });
    const line = String(stdout.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('"msg":"hello"');
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('"password":"x"');
    stdout.mockRestore();
  });
});
