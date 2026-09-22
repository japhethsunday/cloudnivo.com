'use client';

import { useEffect, useRef } from 'react';

/**
 * Polling that yields when the API pushes back.
 *
 * Every status poller in this dashboard used to be a bare
 * `setInterval(load, ms)`, which kept firing at the same rate no matter what
 * came back. That is what took the console down during deploys:
 *
 *   1. a deploy poller runs at 1.5s, the database poller at 5s, the project
 *      layout at 15s — ~56 requests a minute per tab, before anyone clicks;
 *   2. the per-IP budget is exceeded and the API starts answering 429;
 *   3. the pollers keep firing, so every tick produces another 429;
 *   4. each refusal feeds the threat tracker, which bans the address — and
 *      because the pollers never stop, the ban re-arms and escalates.
 *
 * A burst that should have lasted seconds became a 15-minute (then hours
 * long) lockout, and the UI showed "Couldn't open project — Too many
 * requests" for the whole of it.
 *
 * So a poller has to be a closed loop: when the server says slow down, it
 * slows down. On 429 the delay doubles (honouring `Retry-After` when the
 * response carries one) up to a ceiling; any successful poll resets it.
 *
 * Self-scheduling via setTimeout rather than setInterval, so the interval can
 * change between ticks and a slow response can never stack another request on
 * top of one still in flight.
 */

export const POLL_MAX_BACKOFF_MS = 60_000;

/** Next delay after a refused poll: double, bounded, or obey Retry-After. */
export function nextBackoffMs(
  current: number,
  retryAfterSeconds: number | null,
  maxMs: number = POLL_MAX_BACKOFF_MS,
): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.max(retryAfterSeconds * 1000, current), maxMs);
  }
  return Math.min(current * 2, maxMs);
}

/** `Retry-After` in seconds, when the server sent a usable one. */
export function retryAfterSecondsOf(headers: Headers | null | undefined): number | null {
  const raw = headers?.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** What one tick reports back, so the loop knows how to schedule the next. */
export interface PollOutcome {
  /** True when the API refused for rate-limiting reasons (429). */
  rateLimited?: boolean;
  /** Seconds the server asked us to wait, when it said. */
  retryAfterSeconds?: number | null;
  /** True to stop polling entirely (e.g. the session is gone). */
  stop?: boolean;
}

/**
 * Run `tick` every `intervalMs`, backing off while the API answers 429.
 *
 * `tick` runs once immediately, then on the schedule. Returning
 * `{ rateLimited: true }` backs the loop off; returning `{ stop: true }` ends
 * it. Anything else resets to the base interval.
 */
export function usePolling(
  tick: () => Promise<PollOutcome | void>,
  intervalMs: number,
  enabled = true,
): void {
  // Held in refs so changing the callback identity does not restart the loop
  // and re-fire an immediate request on every render.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = intervalMs;

    const run = async (): Promise<void> => {
      if (cancelled) return;
      let outcome: PollOutcome | void;
      try {
        outcome = await tickRef.current();
      } catch {
        // A thrown tick must not kill the loop; treat it as a plain miss.
        outcome = undefined;
      }
      if (cancelled) return;
      if (outcome && outcome.stop) return;
      if (outcome && outcome.rateLimited) {
        delay = nextBackoffMs(delay, outcome.retryAfterSeconds ?? null);
      } else {
        delay = intervalMs;
      }
      timer = setTimeout(() => void run(), delay);
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, enabled]);
}
