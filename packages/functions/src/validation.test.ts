import { describe, expect, it } from 'vitest';
import {
  assertEntrypoint,
  assertEnvKey,
  assertFunctionSlug,
  assertRuntime,
  assertSource,
} from './validation.js';
import { buildFunctionSdk } from './sdk.js';
import { maskEnvValue, redactSecrets } from './service.js';

describe('function input validation', () => {
  it('accepts well-formed slugs/names/runtimes/entrypoints', () => {
    expect(assertFunctionSlug('hello-world')).toBe('hello-world');
    expect(assertRuntime('node22')).toBe('node22');
    expect(assertEntrypoint(undefined)).toBe('handler');
    expect(assertEntrypoint('api.handler')).toBe('api.handler');
    expect(assertSource('module.exports.handler = async () => ({});', 1024)).toContain('handler');
    expect(assertEnvKey('STRIPE_KEY')).toBe('STRIPE_KEY');
  });

  it('rejects unsafe identifiers and oversized source', () => {
    for (const bad of ['Hi', 'a', 'x'.repeat(64), '../escape', 'a_b', 'UPPER']) {
      expect(() => assertFunctionSlug(bad)).toThrow();
    }
    expect(() => assertRuntime('python99')).toThrow();
    expect(() => assertEntrypoint('a; DROP')).toThrow();
    expect(() => assertEntrypoint('__proto__.x')).toThrow();
    expect(() => assertSource('x'.repeat(2000), 100)).toThrow(/exceeds/);
    expect(() => assertEnvKey('lowercase')).toThrow();
    expect(() => assertEnvKey('DATABASE_URL;X')).toThrow();
  });
});

describe('function SDK shape', () => {
  it('exposes identity and project, never credentials', () => {
    const sdk = buildFunctionSdk({
      auth: {
        userId: 'u1',
        email: 'u@example.com',
        role: 'authenticated',
        projectId: 'p1',
        callerKind: 'customer',
      },
      publicEnv: { HELLO: 'world' },
    });
    expect(sdk.auth.userId).toBe('u1');
    expect(sdk.project.id).toBe('p1');
    expect(sdk.env['HELLO']).toBe('world');
    expect(JSON.stringify(sdk)).not.toContain('secret');
    expect(JSON.stringify(sdk)).not.toContain('DATABASE_URL');
    expect(Object.isFrozen(sdk.auth)).toBe(true);
  });
});

describe('secret handling', () => {
  it('masks secret env values in API shapes', () => {
    expect(maskEnvValue('public-value', false)).toBe('public-value');
    expect(maskEnvValue('s3cr3t-value-long', true)).not.toContain('3cr3t-value-lo');
    expect(maskEnvValue('short', true)).toBe('••••••••');
  });

  it('redacts secret values from log lines', () => {
    const line = redactSecrets('token=s3cr3t-value-long ok', ['s3cr3t-value-long']);
    expect(line).not.toContain('s3cr3t-value-long');
    expect(line).toContain('[redacted]');
    expect(redactSecrets('clean line', ['s3cr3t-value-long'])).toBe('clean line');
  });
});
