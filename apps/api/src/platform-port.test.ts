import { afterEach, describe, expect, it } from 'vitest';
import { resolveListenPort } from './platform-port.js';

describe('platform-assigned listen port', () => {
  afterEach(() => {
    delete process.env.PORT;
  });

  it('prefers an explicit arg, then PORT, then the configured port', () => {
    expect(resolveListenPort(1234, 3001)).toBe(1234);
    process.env.PORT = '8080';
    expect(resolveListenPort(undefined, 3001)).toBe(8080);
    expect(resolveListenPort(1234, 3001)).toBe(1234);
  });

  it('ignores missing or malformed PORT values', () => {
    expect(resolveListenPort(undefined, 3001)).toBe(3001);
    for (const bad of ['0', '-1', '65536', 'abc', '3.5', '']) {
      process.env.PORT = bad;
      expect(resolveListenPort(undefined, 3001)).toBe(3001);
    }
  });
});
