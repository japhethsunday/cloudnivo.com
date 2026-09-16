import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './index.js';

describe('isUniqueViolation', () => {
  it('detects a raw driver error', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('detects a wrapped driver error', () => {
    // Drizzle wraps driver errors; the old `err.code` check missed every one,
    // so duplicate signups became 500s and idempotency keys stopped deduping.
    const inner = Object.assign(new Error('dup'), { code: '23505' });
    const outer = Object.assign(new Error('Failed query'), { cause: inner });
    expect(isUniqueViolation(outer)).toBe(true);
  });

  it('detects one nested two levels deep', () => {
    const inner = Object.assign(new Error('dup'), { code: '23505' });
    const mid = Object.assign(new Error('mid'), { cause: inner });
    expect(isUniqueViolation(Object.assign(new Error('outer'), { cause: mid }))).toBe(true);
  });

  it('is false for other errors', () => {
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '42P01' }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(isUniqueViolation(err)).toBe(false);
  });
});
