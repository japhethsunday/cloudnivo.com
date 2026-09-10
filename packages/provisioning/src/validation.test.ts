import { describe, expect, it } from 'vitest';
import { assertDbPassword, quoteLiteral } from './validation.js';

describe('quoteLiteral', () => {
  it('wraps values in single quotes', () => {
    expect(quoteLiteral('abc-123_X')).toBe("'abc-123_X'");
  });

  it('doubles embedded single quotes (SQL standard escaping)', () => {
    expect(quoteLiteral("o'brien'x")).toBe("'o''brien''x'");
    expect(quoteLiteral("'''")).toBe("''''''''");
  });

  it('leaves backslashes and dollar signs untouched (standard strings)', () => {
    expect(quoteLiteral('a\\b$c')).toBe("'a\\b$c'");
  });
});

describe('assertDbPassword', () => {
  it('accepts 12-128 char passwords for the literal path', () => {
    expect(assertDbPassword('long-enough-password-1')).toBe('long-enough-password-1');
    expect(() => assertDbPassword('short')).toThrow();
  });
});
