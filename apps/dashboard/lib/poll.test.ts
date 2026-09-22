import { describe, expect, it } from 'vitest';
import { nextBackoffMs, retryAfterSecondsOf, POLL_MAX_BACKOFF_MS } from './poll';

/**
 * The backoff maths behind the deploy outage. A poller that keeps its rate
 * through a 429 is what turned a burst into an IP ban; these pin the
 * behaviour that stops it.
 */
describe('poll backoff', () => {
  it('doubles the delay on each refusal, up to a ceiling', () => {
    expect(nextBackoffMs(2000, null)).toBe(4000);
    expect(nextBackoffMs(4000, null)).toBe(8000);
    expect(nextBackoffMs(40_000, null)).toBe(POLL_MAX_BACKOFF_MS);
    // Never grows without bound, however long the outage lasts.
    expect(nextBackoffMs(POLL_MAX_BACKOFF_MS, null)).toBe(POLL_MAX_BACKOFF_MS);
  });

  it('obeys Retry-After when the server sends one', () => {
    expect(nextBackoffMs(2000, 30)).toBe(30_000);
    // Never waits LESS than the current delay just because the header is small.
    expect(nextBackoffMs(10_000, 1)).toBe(10_000);
    // And never beyond the ceiling, whatever the server asks for.
    expect(nextBackoffMs(2000, 9999)).toBe(POLL_MAX_BACKOFF_MS);
  });

  it('ignores a missing or nonsense Retry-After', () => {
    const h = (v: string | null): Headers => {
      const x = new Headers();
      if (v !== null) x.set('retry-after', v);
      return x;
    };
    expect(retryAfterSecondsOf(h(null))).toBeNull();
    expect(retryAfterSecondsOf(h('not-a-number'))).toBeNull();
    expect(retryAfterSecondsOf(h('-5'))).toBeNull();
    expect(retryAfterSecondsOf(h('0'))).toBeNull();
    expect(retryAfterSecondsOf(h('45'))).toBe(45);
    expect(retryAfterSecondsOf(null)).toBeNull();
  });

  it('collapses request volume during a sustained rate limit', () => {
    // The scenario that caused the outage: a 2s poller meeting a 60s block.
    // Without backoff that is 30 refused requests a minute, each one feeding
    // the threat tracker. With backoff it is a handful, then near-silence.
    let delay = 2000;
    let elapsed = 0;
    let requests = 0;
    while (elapsed < 60_000) {
      requests += 1;
      delay = nextBackoffMs(delay, null);
      elapsed += delay;
    }
    expect(requests).toBeLessThanOrEqual(6);
    // Unthrottled, the same minute would have been 30 requests.
    expect(60_000 / 2000).toBe(30);
  });

  it('returns to the base rate as soon as a poll succeeds', () => {
    // Modelled the way usePolling does it: success resets, it does not decay.
    const base = 5000;
    let delay = nextBackoffMs(nextBackoffMs(base, null), null); // two refusals
    expect(delay).toBe(20_000);
    delay = base; // a success
    expect(delay).toBe(5000);
  });
});
