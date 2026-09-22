import { describe, expect, it } from 'vitest';
import { MemoryCache } from '@cloudnivo/cache';
import { bodyIsOpaque, inspectBody, inspectRequest, LIMITS, ruleCatalog } from './waf.js';
import { DEFAULT_POLICY, ThreatTracker, type ThreatPolicy } from './threat.js';

function req(rawUrl: string, over: Partial<Parameters<typeof inspectRequest>[0]> = {}) {
  return inspectRequest({
    method: 'GET',
    rawUrl,
    pathname: rawUrl.split('?')[0] ?? '/',
    headers: {},
    ...over,
  });
}

describe('WAF — attacks it must catch', () => {
  const attacks: [string, string][] = [
    ['path traversal', '/api/v1/projects/../../etc/passwd'],
    ['encoded traversal', '/api/v1/files?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['double-encoded traversal', '/api/v1/files?path=%252e%252e%252f'],
    ['null byte', '/api/v1/projects/abc%00.json'],
    ['SQL tautology', "/api/v1/projects?slug=x' OR 1=1--"],
    ['UNION SELECT', '/api/v1/projects?q=1 UNION ALL SELECT password FROM users'],
    ['inline-comment UNION', '/api/v1/projects?q=1/**/UNION/**/SELECT/**/1'],
    ['stacked query comment', '/api/v1/projects?id=1;--'],
    ['time-based blind', '/api/v1/projects?id=1 AND pg_sleep(10)'],
    ['schema enumeration', '/api/v1/projects?q=information_schema.tables'],
    ['script tag', '/api/v1/search?q=<script>alert(1)</script>'],
    ['event handler', '/api/v1/search?q=%3Cimg%20onerror=alert(1)%3E'],
    ['javascript URI', '/api/v1/redirect?to=javascript:eval(1)'],
    ['shell substitution', '/api/v1/x?c=$(cat /etc/passwd)'],
    ['piped shell', '/api/v1/x?c=1|bash'],
    ['prototype pollution', '/api/v1/x?__proto__[admin]=true'],
    ['WordPress probe', '/wp-admin/install.php'],
    ['env file probe', '/.env'],
    ['git config probe', '/.git/config'],
    ['PHP probe', '/index.php'],
    ['actuator probe', '/actuator/env'],
  ];

  for (const [name, path] of attacks) {
    it(`blocks ${name}`, () => {
      const v = req(path);
      expect(v.blocked, `${name} was allowed through: ${path}`).toBe(true);
      expect(v.ruleId).toBeTruthy();
    });
  }

  it('blocks a self-identified scanner by user agent', () => {
    expect(req('/api/v1/health', { headers: { 'user-agent': 'sqlmap/1.7' } }).blocked).toBe(true);
  });

  it('blocks TRACE, which enables cross-site tracing', () => {
    expect(req('/api/v1/projects', { method: 'TRACE' }).blocked).toBe(true);
  });

  it('blocks a header carrying CRLF or a traversal', () => {
    expect(req('/api/v1/projects', { headers: { 'x-thing': 'a\r\nInjected: 1' } }).blocked).toBe(
      true,
    );
    expect(req('/api/v1/projects', { headers: { referer: '../../secret' } }).blocked).toBe(true);
  });

  it('blocks an absurd URL and an absurd header', () => {
    expect(req(`/api/v1/projects?q=${'a'.repeat(LIMITS.urlBytes)}`).blocked).toBe(true);
    expect(
      req('/api/v1/projects', { headers: { 'x-big': 'b'.repeat(LIMITS.headerValueBytes + 1) } })
        .blocked,
    ).toBe(true);
  });
});

/**
 * The half that decides whether this WAF can stay switched on. A rule that
 * blocks real product traffic is worse than no rule: it gets disabled, and
 * then nothing is protected.
 */
describe('WAF — legitimate CloudNivo traffic it must never block', () => {
  const legitimate: [string, string][] = [
    ['plain project list', '/api/v1/projects'],
    ['project by uuid', '/api/v1/projects/3f8b1c2e-8a4d-4f2e-9c1a-7b6d5e4f3a2b'],
    ['a slug containing "union"', '/api/v1/projects?slug=union-bank-api'],
    ['a slug containing "select"', '/api/v1/projects?slug=select-health'],
    ['a name containing "or"', '/api/v1/organizations?q=Thor%20Industries'],
    ['a search for "drop"', '/api/v1/projects?q=airdrop'],
    ['an email in a query', '/api/v1/admin/users?q=ada%40example.com'],
    ['a base64 cursor', '/api/v1/data/rows?cursor=eyJpZCI6MTIzfQ%3D%3D'],
    ['a storage key with dots', '/api/v1/storage/buckets/assets/objects/logo.v2.min.svg'],
    ['an ISO timestamp filter', '/api/v1/metrics?from=2026-09-18T07%3A00%3A00Z'],
    ['a JSON filter value', '/api/v1/data/rows?filter=%7B%22status%22%3A%22active%22%7D'],
    ['a path with a hyphenated word', '/api/v1/projects/my-app-production/usage'],
    ['pagination', '/api/v1/admin/audit?limit=100&offset=200'],
  ];

  for (const [name, path] of legitimate) {
    it(`allows ${name}`, () => {
      const v = req(path);
      expect(v.blocked, `${name} was wrongly blocked by ${v.ruleId}: ${path}`).toBe(false);
    });
  }

  it('allows an ordinary browser user agent', () => {
    expect(
      req('/api/v1/projects', {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        },
      }).blocked,
    ).toBe(false);
  });

  it('allows every method the API actually serves', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      expect(req('/api/v1/projects', { method }).blocked, method).toBe(false);
    }
  });
});

describe('WAF — body scope', () => {
  it('treats tenant data planes as opaque', () => {
    for (const path of [
      '/api/v1/projects/abc/sql',
      '/api/v1/projects/abc/data/users',
      '/api/v1/projects/abc/functions/deploy',
      '/api/v1/projects/abc/storage/objects',
      '/api/v1/projects/abc/ai/complete',
      '/api/v1/projects/abc/auth/signup',
      '/api/v1/data/rows',
      '/api/v1/storage/upload',
    ]) {
      expect(bodyIsOpaque(path), path).toBe(true);
    }
  });

  it('treats platform routes as inspectable', () => {
    for (const path of [
      '/api/v1/auth/login',
      '/api/v1/auth/signup',
      '/api/v1/organizations',
      '/api/v1/admin/email/send',
    ]) {
      expect(bodyIsOpaque(path), path).toBe(false);
    }
  });

  it('blocks injection syntax in a platform body', () => {
    expect(inspectBody('{"email":"a@b.c\' OR 1=1--"}').blocked).toBe(true);
    expect(inspectBody('{"name":"x UNION SELECT token FROM keys"}').blocked).toBe(true);
    expect(inspectBody('{"__proto__":{"isAdmin":true}}').blocked).toBe(true);
  });

  it('allows an ordinary platform body', () => {
    expect(
      inspectBody('{"email":"ada@example.com","password":"correct horse battery"}').blocked,
    ).toBe(false);
    expect(inspectBody('{"name":"Union Bank","slug":"union-bank"}').blocked).toBe(false);
  });

  it('publishes its rules for the console', () => {
    const cat = ruleCatalog();
    expect(cat.length).toBeGreaterThan(10);
    expect(cat.every(r => r.id && r.describes)).toBe(true);
  });
});

// ── Adaptive rate limiting ──

const FAST: ThreatPolicy = { ...DEFAULT_POLICY, throttleAt: 50, banAt: 120 };

function tracker(over: Partial<ThreatPolicy> = {}, allow: string[] = []): ThreatTracker {
  return new ThreatTracker(new MemoryCache(), { ...FAST, ...over }, allow);
}

describe('rate limiting must not escalate into a ban', () => {
  // The dashboard outage: a chatty tab exceeded the per-IP budget, every 429
  // scored against it, and the address was banned — then the pollers, which
  // did not back off, kept the ban alive and escalating. Refusing a request
  // is already the punishment; it must not also be most of a ban.
  it('tolerates a long burst of refusals without banning', async () => {
    const t = tracker();
    // 60 refused requests — a poller hammering for a solid minute.
    for (let i = 0; i < 60; i += 1) await t.record('9.9.9.9', 'rate_limited');
    const state = await t.assess('9.9.9.9');
    expect(state.level, 'an honest burst must not ban the client').not.toBe('banned');
  });

  it('still bans genuinely sustained volumetric abuse', async () => {
    const t = tracker();
    // An order of magnitude more: no longer a chatty tab.
    for (let i = 0; i < 200; i += 1) await t.record('9.9.9.10', 'rate_limited');
    expect((await t.assess('9.9.9.10')).level).toBe('banned');
  });

  it('still bans attack signals quickly — this did not weaken those', async () => {
    const t = tracker();
    // Credential stuffing: three unseen accounts is over the throttle line.
    for (const acct of ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test', 'f@x.test']) {
      await t.record('9.9.9.11', 'auth_failure', acct);
    }
    expect((await t.assess('9.9.9.11')).level).not.toBe('normal');
    const w = tracker();
    for (let i = 0; i < 5; i += 1) await w.record('9.9.9.12', 'waf_block');
    expect((await w.assess('9.9.9.12')).level).toBe('banned');
  });
});

describe('adaptive rate limiting — behaviour, not volume', () => {
  it('leaves a busy honest client alone', async () => {
    const t = tracker();
    // 200 successful requests produce no signals at all: nothing calls record.
    expect((await t.assess('1.1.1.1')).level).toBe('normal');
  });

  it('tolerates one person mistyping their own password', async () => {
    const t = tracker();
    let state = { level: 'normal' as string };
    for (let i = 0; i < 5; i += 1) {
      state = await t.record('2.2.2.2', 'auth_failure', 'login:ada@example.com');
    }
    // First attempt scores as a new account (22), the rest as repeats (8 each)
    // = 54. Throttled, deliberately — five wrong passwords is worth slowing —
    // but nowhere near a ban.
    expect(state.level).not.toBe('banned');
  });

  it('bans credential stuffing across many accounts faster than a single-account retry', async () => {
    const stuffing = tracker();
    let level = 'normal';
    for (let i = 0; i < 6 && level !== 'banned'; i += 1) {
      level = (await stuffing.record('3.3.3.3', 'auth_failure', `login:user${i}@example.com`))
        .level;
    }
    expect(level).toBe('banned');

    const single = tracker();
    let singleLevel = 'normal';
    for (let i = 0; i < 6; i += 1) {
      singleLevel = (await single.record('4.4.4.4', 'auth_failure', 'login:ada@example.com')).level;
    }
    expect(singleLevel).not.toBe('banned');
  });

  it('bans a path scanner but not a client with one stale link', async () => {
    const scanner = tracker();
    let level = 'normal';
    for (let i = 0; i < 14 && level !== 'banned'; i += 1) {
      level = (await scanner.record('5.5.5.5', 'not_found', `/probe-${i}`)).level;
    }
    expect(level).toBe('banned');

    const stale = tracker();
    let staleLevel = 'normal';
    for (let i = 0; i < 20; i += 1) {
      staleLevel = (await stale.record('6.6.6.6', 'not_found', '/old-bookmark')).level;
    }
    expect(staleLevel).toBe('normal');
  });

  it('escalates from throttle to ban as evidence accumulates', async () => {
    const t = tracker();
    const first = await t.record('7.7.7.7', 'waf_block');
    expect(first.level).toBe('normal');
    const second = await t.record('7.7.7.7', 'waf_block');
    expect(second.level).toBe('throttled');
    await t.record('7.7.7.7', 'waf_block');
    await t.record('7.7.7.7', 'waf_block');
    const banned = await t.record('7.7.7.7', 'waf_block');
    expect(banned.level).toBe('banned');
    expect(banned.banSecondsRemaining).toBeGreaterThan(0);
  });

  it('gives a throttled IP a reduced budget rather than cutting it off', async () => {
    const t = tracker({ throttledBudget: 3 });
    expect(await t.spendThrottledBudget('8.8.8.8')).toBe(true);
    expect(await t.spendThrottledBudget('8.8.8.8')).toBe(true);
    expect(await t.spendThrottledBudget('8.8.8.8')).toBe(true);
    expect(await t.spendThrottledBudget('8.8.8.8')).toBe(false);
  });

  it('serves a longer ban to a repeat offender, but never an unbounded one', async () => {
    const t = tracker({ banSeconds: 100, maxBanSeconds: 300 });
    const first = await t.banNow('9.9.9.9', 100);
    expect(first.banSecondsRemaining).toBe(100);
    const capped = await t.banNow('9.9.9.9', 99_999);
    expect(capped.banSecondsRemaining).toBe(300);
  });

  it('never scores or bans an allowlisted address', async () => {
    const t = tracker({}, ['10.0.0.1']);
    for (let i = 0; i < 40; i += 1) await t.record('10.0.0.1', 'waf_block');
    expect((await t.assess('10.0.0.1')).level).toBe('normal');
  });

  it('lets an operator lift a ban', async () => {
    const t = tracker();
    await t.banNow('11.11.11.11', 600);
    expect((await t.assess('11.11.11.11')).level).toBe('banned');
    await t.clear('11.11.11.11');
    expect((await t.assess('11.11.11.11')).level).toBe('normal');
  });

  it('fails OPEN when the cache is unavailable', async () => {
    const broken = {
      driver: 'broken',
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
      del: async () => {
        throw new Error('redis down');
      },
      incr: async () => {
        throw new Error('redis down');
      },
      ping: async () => false,
    };
    const t = new ThreatTracker(broken, FAST, []);
    expect((await t.assess('12.12.12.12')).level).toBe('normal');
    expect(await t.spendThrottledBudget('12.12.12.12')).toBe(true);
    expect((await t.record('12.12.12.12', 'waf_block')).level).toBe('normal');
  });

  it('keeps the attacked account out of the cache key', async () => {
    const cache = new MemoryCache();
    const t = new ThreatTracker(cache, FAST, []);
    await t.record('13.13.13.13', 'auth_failure', 'login:victim@example.com');
    const dump = JSON.stringify([...(cache as unknown as { store: Map<string, unknown> }).store]);
    expect(dump).not.toContain('victim@example.com');
  });
});

describe('the scoring subject cannot be chosen by the caller', () => {
  it('scores a pinned subject the same as any repeat, and varied subjects higher', async () => {
    // The tracker's sharpest signal is "an account this IP has not tried
    // before". If the subject came from a request header, an attacker could
    // pin one value and make a stuffing run look like one person retrying —
    // so the subject is taken from the parsed body, server-side, and this
    // pins the property that makes that matter.
    const pinned = tracker();
    let pinnedLevel = 'normal';
    for (let i = 0; i < 6; i += 1) {
      pinnedLevel = (await pinned.record('20.0.0.1', 'auth_failure', 'platform-login:one@x.com'))
        .level;
    }

    const varied = tracker();
    let variedLevel = 'normal';
    for (let i = 0; i < 6 && variedLevel !== 'banned'; i += 1) {
      variedLevel = (await varied.record('20.0.0.2', 'auth_failure', `platform-login:u${i}@x.com`))
        .level;
    }

    expect(variedLevel).toBe('banned');
    expect(pinnedLevel).not.toBe('banned');
  });
});
