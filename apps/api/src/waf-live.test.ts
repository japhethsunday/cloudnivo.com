import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { start } from './index.js';

/**
 * The WAF and the threat tracker against a real listening server.
 *
 * The unit tests prove the rules; this proves the WIRING — that the filter
 * actually runs before routing, that a ban is enforced at the edge, and that
 * an oversized body is refused without the process buffering it. A rule that
 * is never reached protects nothing, and only a live socket shows that.
 */

function env(over: Record<string, string>): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-for-waf-live-suite-0123456789abcdef',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    CONTROL_STORE: 'memory',
    CACHE_DRIVER: 'memory',
    PROVISION_DRIVER: 'fake',
    WAF_MODE: 'block',
    MAX_BODY_BYTES: '65536',
    RATE_LIMIT_MAX_REQUESTS: '100000',
    ...over,
  });
}

let server: Server;
let base: string;

/**
 * The rule tests need a server that does NOT ban them: every blocked request
 * scores, and by design a dozen of them from one address is a ban — which is
 * the next suite's subject, not this one's. Each suite therefore gets its own
 * server, and `start(0)` builds a fresh context with its own tracker and cache.
 */
beforeAll(async () => {
  env({ THREAT_BAN_AT: '50000', THREAT_THROTTLE_AT: '10000' });
  const started = await start(0);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('WAF runs in front of the stack', () => {
  it('refuses a traversal before it reaches any route', async () => {
    const res = await fetch(`${base}/api/v1/projects/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // The caller learns nothing that would help them tune an evasion: no rule
    // id, no category, no hint that a WAF exists at all.
    expect(body.error.message).toBe('Malformed request');
    expect(JSON.stringify(body)).not.toMatch(/traversal|waf|rule/i);
  });

  it('refuses SQL injection in a query string', async () => {
    const res = await fetch(`${base}/api/v1/projects?q=${encodeURIComponent("1' OR 1=1--")}`);
    expect(res.status).toBe(400);
  });

  it('refuses a scanner by user agent', async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      headers: { 'user-agent': 'sqlmap/1.7.2#stable' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses probes for software this platform does not run', async () => {
    for (const path of ['/wp-login.php', '/.env', '/.git/config', '/phpmyadmin/index.php']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(400);
    }
  });

  it('still serves ordinary requests', async () => {
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it('never filters the health probe, whatever it carries', async () => {
    // An orchestrator that cannot health check restarts the service, which is
    // exactly what an attacker wants. Liveness is exempt by design.
    const res = await fetch(`${base}/api/v1/health/live`, {
      headers: { 'user-agent': 'nikto/2.5' },
    });
    expect(res.status).toBe(200);
  });
});

describe('oversized bodies cannot exhaust memory', () => {
  /**
   * Raw socket rather than fetch: fetch computes an honest content-length and
   * refuses to lie, and lying about it is exactly the case worth proving.
   * Resolves with whatever the server said, or 'reset' when it hung up.
   */
  function rawPost(headers: string, body: string): Promise<string> {
    return new Promise(resolve => {
      const { port } = new URL(base);
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(
          `POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n${headers}\r\n\r\n${body}`,
        );
      });
      let seen = '';
      socket.setTimeout(8000);
      socket.on('data', chunk => {
        seen += String(chunk);
        if (seen.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(seen.split('\r\n')[0] ?? '');
        }
      });
      socket.on('error', () => resolve(seen ? (seen.split('\r\n')[0] ?? '') : 'reset'));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(seen ? (seen.split('\r\n')[0] ?? '') : 'timeout');
      });
      socket.on('close', () => resolve(seen ? (seen.split('\r\n')[0] ?? '') : 'reset'));
    });
  }

  it('refuses a body whose declared length is over the cap, before reading it', async () => {
    // One byte of body, a header claiming 100 MB. The server must refuse on
    // the header alone — it has no reason to start reading.
    const status = await rawPost('Content-Length: 104857600', 'x');
    expect(status).toMatch(/413|reset/);
    expect(status).not.toMatch(/ 200 | 201 /);
  }, 20_000);

  it('stops reading a body that runs past the cap mid-stream', async () => {
    // Honest length, still over the 64 KB cap. Either a 413 or a hang-up is
    // correct; quietly accepting 256 KB is not.
    const payload = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(256 * 1024) });
    const status = await rawPost(`Content-Length: ${Buffer.byteLength(payload)}`, payload);
    expect(status).toMatch(/413|reset/);
  }, 20_000);

  it('is still serving after the flood', async () => {
    // The point of the cap: a hostile body costs the limit, not the process.
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it('still accepts a body under the cap', async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'not-the-right-password' }),
    });
    // 401 is the honest answer for an account that does not exist. What
    // matters here is that the body was read and parsed rather than refused.
    expect([400, 401]).toContain(res.status);
  });
});

describe('body inspection is scoped, and actually wired', () => {
  it('blocks injection syntax in a platform body', async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: "a@b.c' UNION SELECT token FROM keys--", password: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Malformed request');
  });

  it('never inspects a tenant data-plane body', async () => {
    // The SQL editor is the product. A customer sending `UNION SELECT` against
    // their OWN database must reach the handler — the 401 here is the auth
    // gate, which is exactly the proof: the WAF let it past.
    const res = await fetch(`${base}/api/v1/projects/demo/sql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT id FROM a UNION SELECT id FROM b' }),
    });
    expect(res.status).not.toBe(400);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('lets an ordinary platform body through', async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'a-normal-password' }),
    });
    expect([400, 401]).toContain(res.status);
    if (res.status === 400) {
      const body = (await res.json()) as { error: { message: string } };
      // A validation complaint is fine; being refused as malformed is not.
      expect(body.error.message).not.toBe('Malformed request');
    }
  });
});

describe('adaptive escalation reaches a real ban', () => {
  let banServer: Server;
  let banBase: string;

  beforeAll(async () => {
    env({ THREAT_THROTTLE_AT: '50', THREAT_BAN_AT: '120' });
    const started = await start(0);
    banServer = started.server;
    banBase = `http://127.0.0.1:${started.port}`;
  }, 60_000);

  afterAll(async () => {
    if (banServer) await new Promise<void>(resolve => banServer.close(() => resolve()));
  });

  it('bans an IP that keeps sending hostile requests, and says when to come back', async () => {
    // WAF blocks score 25 each; throttle at 50, ban at 120.
    let status = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(
        `${banBase}/api/v1/projects?q=${encodeURIComponent('1 UNION SELECT 1')}`,
      );
      status = res.status;
      retryAfter = res.headers.get('retry-after');
      if (status === 429) break;
    }
    expect(status).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 30_000);

  it('refuses the banned IP on a route it never attacked, but still answers health', async () => {
    // The ban is on the caller, not the route: an innocent path is now refused
    // too. Health stays exempt, so an orchestrator cannot be starved into
    // restarting the service.
    const other = await fetch(`${banBase}/api/v1/projects`);
    expect(other.status).toBe(429);
    const health = await fetch(`${banBase}/api/v1/health/live`);
    expect(health.status).toBe(200);
  });
});
