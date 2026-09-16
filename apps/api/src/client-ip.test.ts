import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientIpOf, rateLimitIp } from './client-ip.js';

function reqWith(xff: string | string[] | undefined, socketIp = '10.1.1.1'): IncomingMessage {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: socketIp },
  } as unknown as IncomingMessage;
}

describe('clientIpOf', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    expect(clientIpOf(reqWith('203.0.113.9'), 0)).toBe('10.1.1.1');
  });

  it('takes the entry to the left of what the trusted proxy appended', () => {
    // The attack this closes: a client that sends its own X-Forwarded-For got
    // a fresh rate-limit bucket per request, which removed brute-force
    // protection. Our proxy appends the address it actually saw, on the right.
    expect(clientIpOf(reqWith('198.51.100.7'), 1)).toBe('10.1.1.1');
    expect(clientIpOf(reqWith('1.2.3.4, 198.51.100.7'), 1)).toBe('1.2.3.4');
  });

  it('counts hops from the right for multiple trusted proxies', () => {
    expect(clientIpOf(reqWith('1.2.3.4, 198.51.100.7, 198.51.100.8'), 2)).toBe('1.2.3.4');
  });

  it('fails closed on the socket address when the chain is shorter than the trusted hops', () => {
    // A forged header that never passed through our proxies is client input.
    expect(clientIpOf(reqWith('198.51.100.7'), 3)).toBe('10.1.1.1');
    expect(clientIpOf(reqWith('1.2.3.4, 5.6.7.8'), 2)).toBe('10.1.1.1');
  });

  it('falls back to the socket address with no header', () => {
    expect(clientIpOf(reqWith(undefined), 1)).toBe('10.1.1.1');
    expect(rateLimitIp(reqWith(undefined), 1)).toBe('10.1.1.1');
  });

  it('joins a repeated header rather than trusting only the first copy', () => {
    expect(clientIpOf(reqWith(['1.2.3.4', '198.51.100.7']), 1)).toBe('1.2.3.4');
  });

  it('never returns an empty bucket key', () => {
    const req = { headers: {}, socket: {} } as unknown as IncomingMessage;
    expect(rateLimitIp(req, 1)).toBe('unknown');
  });
});
