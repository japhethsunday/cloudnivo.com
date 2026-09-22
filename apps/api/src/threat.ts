/**
 * Adaptive rate limiting and IP anomaly detection.
 *
 * The fixed limiter this sits beside asks one question — how many requests in
 * the last minute — and it is the wrong question twice over. A customer
 * syncing a table legitimately makes hundreds of calls a minute. An attacker
 * enumerating accounts makes twelve, and gets through.
 *
 * So this scores BEHAVIOUR. Volume contributes almost nothing; what counts is
 * what the requests were trying to do:
 *
 *   - a WAF block is a hostile request, already proven, and scores heavily
 *   - failed authentication scores, and scores MORE when the same IP is
 *     failing against many different accounts (credential stuffing looks
 *     exactly like this and nothing else does)
 *   - 404s score only when they are SPREAD across many paths, which is what
 *     separates a scanner walking a wordlist from a client with a stale link
 *   - 403s score, because a caller repeatedly reaching for other tenants'
 *     resources is either broken or probing
 *
 * ── The ladder ──
 *
 * NORMAL → THROTTLED → BANNED, and back down as the score decays.
 *
 * Escalation is not a cliff: a throttled IP keeps working at a reduced budget,
 * which is what an infected-but-legitimate client needs, while a banned one is
 * refused at the edge before any handler or database is touched. Repeat
 * offenders serve longer bans — the same IP coming back for a third time has
 * told you it is not a misconfiguration.
 *
 * ── Storage ──
 *
 * State lives in the shared cache (Redis in production), so a ban placed by
 * one API instance is honoured by all of them. The cache failing OPEN is
 * deliberate and matches the existing limiter: a Redis outage must not lock
 * every customer out of the platform.
 */

import type { CacheService } from '@cloudnivo/cache';

export type ThreatLevel = 'normal' | 'throttled' | 'banned';

/**
 * What an IP just did. Weights are the whole policy, so they live in one
 * table rather than scattered through the call sites.
 */
export type ThreatSignal =
  | 'waf_block'
  | 'auth_failure'
  | 'auth_failure_new_account'
  | 'forbidden'
  | 'not_found'
  | 'not_found_new_path'
  | 'rate_limited'
  | 'server_error';

export const SIGNAL_WEIGHTS: Record<ThreatSignal, number> = {
  // A single proven-hostile request is most of the way to a throttle.
  waf_block: 25,
  // Ordinary typo territory: five of these is still under the throttle line.
  auth_failure: 8,
  // The same IP failing against an account it has not tried before. Three
  // accounts and it is throttled; this is the credential-stuffing signal.
  auth_failure_new_account: 22,
  forbidden: 10,
  // A stale bookmark repeated costs almost nothing.
  not_found: 2,
  // A path this IP has not asked for before — a wordlist walk scores here.
  not_found_new_path: 9,
  // Being rate limited is ALREADY the punishment: the request was refused.
  // Scoring it heavily on top turns one honest burst into a 15-minute ban,
  // and because a client that keeps polling keeps generating 429s, the ban
  // re-arms and escalates — an outage that outlives the burst by hours.
  // That is exactly what took the dashboard down during deploys.
  //
  // Weighted at 1 so a ban needs 120 refused requests in the window (real,
  // sustained volumetric abuse) rather than 24 (a chatty tab). An actual
  // attacker still bans quickly via the signals above, which a legitimate
  // client does not produce.
  rate_limited: 1,
  // Requests that make the server throw: either an attack or a bug worth
  // seeing. Weighted low because honest clients trip real bugs.
  server_error: 3,
};

export interface ThreatPolicy {
  /** Score at which the IP is throttled to a reduced request budget. */
  throttleAt: number;
  /** Score at which the IP is refused outright. */
  banAt: number;
  /** Score lifetime. The score decays by expiring, so quiet IPs recover. */
  windowSeconds: number;
  /** First ban length. Repeat bans multiply this. */
  banSeconds: number;
  /** Requests per minute allowed while throttled. */
  throttledBudget: number;
  /** Ban length ceiling, so an automated ban can never become permanent. */
  maxBanSeconds: number;
}

export const DEFAULT_POLICY: ThreatPolicy = {
  throttleAt: 50,
  banAt: 120,
  windowSeconds: 900,
  banSeconds: 900,
  throttledBudget: 10,
  maxBanSeconds: 86_400,
};

export interface ThreatState {
  ip: string;
  level: ThreatLevel;
  score: number;
  /** Seconds remaining on a ban, when banned. */
  banSecondsRemaining: number;
  /** How many times this IP has been banned inside the offence memory. */
  offences: number;
}

const KEY = {
  score: (ip: string) => `threat:score:${ip}`,
  ban: (ip: string) => `threat:ban:${ip}`,
  offences: (ip: string) => `threat:offences:${ip}`,
  seenAccount: (ip: string, account: string) => `threat:acct:${ip}:${account}`,
  seenPath: (ip: string, path: string) => `threat:path:${ip}:${path}`,
  throttleBudget: (ip: string) => `threat:budget:${ip}`,
  blockedTotal: 'threat:stat:blocked',
  bannedTotal: 'threat:stat:banned',
};

/** Offence memory outlives any single ban, so escalation survives a quiet hour. */
const OFFENCE_MEMORY_SECONDS = 7 * 24 * 3600;

export class ThreatTracker {
  private readonly cache: CacheService;
  private readonly policy: ThreatPolicy;
  /** IPs never scored or banned: health checkers, and anything an operator pins. */
  private readonly allowlist: Set<string>;

  constructor(
    cache: CacheService,
    policy: ThreatPolicy = DEFAULT_POLICY,
    allowlist: string[] = [],
  ) {
    this.cache = cache;
    this.policy = policy;
    this.allowlist = new Set(allowlist.map(s => s.trim()).filter(Boolean));
  }

  isAllowlisted(ip: string): boolean {
    return this.allowlist.has(ip);
  }

  /**
   * The decision made before routing: may this IP be served at all, and if so
   * under what budget.
   *
   * Cache failures resolve to `normal`. An IP that cannot be looked up is not
   * evidence of anything, and failing closed here would turn a Redis blip into
   * a total outage.
   */
  async assess(ip: string): Promise<ThreatState> {
    if (this.isAllowlisted(ip)) {
      return { ip, level: 'normal', score: 0, banSecondsRemaining: 0, offences: 0 };
    }
    try {
      const [banRaw, scoreRaw, offencesRaw] = await Promise.all([
        this.cache.get(KEY.ban(ip)),
        this.cache.get(KEY.score(ip)),
        this.cache.get(KEY.offences(ip)),
      ]);
      const score = Number(scoreRaw ?? '0') || 0;
      const offences = Number(offencesRaw ?? '0') || 0;
      if (banRaw) {
        const until = Number(banRaw) || 0;
        const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        if (remaining > 0) {
          return { ip, level: 'banned', score, banSecondsRemaining: remaining, offences };
        }
      }
      if (score >= this.policy.throttleAt) {
        return { ip, level: 'throttled', score, banSecondsRemaining: 0, offences };
      }
      return { ip, level: 'normal', score, banSecondsRemaining: 0, offences };
    } catch {
      return { ip, level: 'normal', score: 0, banSecondsRemaining: 0, offences: 0 };
    }
  }

  /**
   * Consume one unit of a throttled IP's reduced budget.
   *
   * Returns false when the budget for this minute is spent. Only called for
   * IPs already at `throttled`, so the cost is paid by suspicious traffic
   * rather than by everyone.
   */
  async spendThrottledBudget(ip: string): Promise<boolean> {
    try {
      const used = await this.cache.incr(KEY.throttleBudget(ip), 60);
      return used <= this.policy.throttledBudget;
    } catch {
      return true;
    }
  }

  /**
   * Record what an IP did and escalate if the score crosses a line.
   *
   * `subject` is what the signal was aimed at — the account for an auth
   * failure, the path for a 404. It is what makes "new account" and "new path"
   * distinguishable from a client retrying the same thing, which is the
   * difference between an attack and an annoyance.
   */
  async record(ip: string, signal: ThreatSignal, subject?: string): Promise<ThreatState> {
    if (this.isAllowlisted(ip)) {
      return { ip, level: 'normal', score: 0, banSecondsRemaining: 0, offences: 0 };
    }
    try {
      const effective = await this.sharpen(ip, signal, subject);
      const weight = SIGNAL_WEIGHTS[effective];
      const score = await this.addScore(ip, weight);

      if (score >= this.policy.banAt) {
        return await this.ban(ip, score);
      }
      if (score >= this.policy.throttleAt) {
        return { ip, level: 'throttled', score, banSecondsRemaining: 0, offences: 0 };
      }
      return { ip, level: 'normal', score, banSecondsRemaining: 0, offences: 0 };
    } catch {
      return { ip, level: 'normal', score: 0, banSecondsRemaining: 0, offences: 0 };
    }
  }

  /**
   * Upgrade a signal when the subject is one this IP has not touched before.
   *
   * This is the behavioural core: ten failed logins against one account is a
   * person who forgot their password, and ten against ten accounts is an
   * attack. Volume cannot tell them apart; this can.
   */
  private async sharpen(ip: string, signal: ThreatSignal, subject?: string): Promise<ThreatSignal> {
    if (!subject) return signal;
    if (signal !== 'auth_failure' && signal !== 'not_found') return signal;
    const key =
      signal === 'auth_failure'
        ? KEY.seenAccount(ip, hash(subject))
        : KEY.seenPath(ip, hash(subject));
    const seen = await this.cache.incr(key, this.policy.windowSeconds);
    if (seen > 1) return signal;
    return signal === 'auth_failure' ? 'auth_failure_new_account' : 'not_found_new_path';
  }

  /**
   * Add to the score, keeping the window sliding.
   *
   * `incr` gives an integer counter with a TTL, which is exactly a decaying
   * score if each unit of weight is one increment: the whole window expires
   * together, so an IP that stops misbehaving returns to normal on its own
   * without a sweeper process.
   */
  private async addScore(ip: string, weight: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < weight; i += 1) {
      total = await this.cache.incr(KEY.score(ip), this.policy.windowSeconds);
    }
    return total;
  }

  private async ban(ip: string, score: number): Promise<ThreatState> {
    const offences = await this.cache.incr(KEY.offences(ip), OFFENCE_MEMORY_SECONDS);
    // Each repeat doubles the ban, capped — an automated decision must always
    // expire on its own, so a false positive costs hours and never forever.
    const seconds = Math.min(
      this.policy.maxBanSeconds,
      this.policy.banSeconds * 2 ** Math.max(0, offences - 1),
    );
    const until = Date.now() + seconds * 1000;
    await this.cache.set(KEY.ban(ip), String(until), seconds);
    await this.cache.incr(KEY.bannedTotal, 86_400);
    return { ip, level: 'banned', score, banSecondsRemaining: seconds, offences };
  }

  /** Operator action: lift a ban and clear the score behind it. */
  async clear(ip: string): Promise<void> {
    await Promise.all([
      this.cache.del(KEY.ban(ip)),
      this.cache.del(KEY.score(ip)),
      this.cache.del(KEY.throttleBudget(ip)),
    ]);
  }

  /** Operator action: ban an IP directly, for a reason a rule cannot express. */
  async banNow(ip: string, seconds: number): Promise<ThreatState> {
    const capped = Math.min(this.policy.maxBanSeconds, Math.max(60, seconds));
    const until = Date.now() + capped * 1000;
    await this.cache.set(KEY.ban(ip), String(until), capped);
    const offences = await this.cache.incr(KEY.offences(ip), OFFENCE_MEMORY_SECONDS);
    return { ip, level: 'banned', score: 0, banSecondsRemaining: capped, offences };
  }

  async noteWafBlock(): Promise<void> {
    try {
      await this.cache.incr(KEY.blockedTotal, 86_400);
    } catch {
      // Counters must never break a response.
    }
  }

  /** Rolling 24h counters for the operator console. Zero is a real answer. */
  async counters(): Promise<{ wafBlocked24h: number; bans24h: number }> {
    try {
      const [blocked, banned] = await Promise.all([
        this.cache.get(KEY.blockedTotal),
        this.cache.get(KEY.bannedTotal),
      ]);
      return {
        wafBlocked24h: Number(blocked ?? '0') || 0,
        bans24h: Number(banned ?? '0') || 0,
      };
    } catch {
      return { wafBlocked24h: 0, bans24h: 0 };
    }
  }

  get settings(): ThreatPolicy {
    return this.policy;
  }
}

/**
 * Short, stable digest of a subject.
 *
 * Email addresses and paths become cache keys, and a cache key is a place a
 * value can leak from — an operator reading Redis should not be reading a list
 * of which accounts were attacked. The digest keeps the "have I seen this
 * before" property without keeping the value.
 */
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
