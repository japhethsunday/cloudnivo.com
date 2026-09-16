import { describe, expect, it } from 'vitest';
import { MemoryEmailService } from './email.js';
import { MemoryOtpStore, OtpService } from '../otp.js';
import { MemorySmsService } from '../sms.js';
import { CustomerAuthService } from './service.js';
import { MemoryCustomerAuthStore } from './store.js';

/**
 * Every link a user receives by email is built from APP_URL, so APP_URL alone
 * decides which host a verification, reset or magic-link lands on. This pins
 * that: given the canonical production origin, no generated link may point
 * anywhere else — and in particular never back at the retired domain.
 */
const CANONICAL = 'https://cloudnivo.org';
const RETIRED = 'cloudnivo.com';
const PID = '22222222-2222-4222-8222-222222222222';

function service(appUrl: string) {
  const store = new MemoryCustomerAuthStore();
  const email = new MemoryEmailService();
  const svc = new CustomerAuthService({
    store,
    email,
    config: {
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2592000,
      resetTtlSeconds: 3600,
      verifyTtlSeconds: 86400,
      emailDriver: 'memory',
      jwtSecret: 'c'.repeat(48),
      issuer: 'cloudnivo-test',
    },
    audit: () => undefined,
    appUrl,
    otp: new OtpService(new MemoryOtpStore()),
    sms: new MemorySmsService(),
  });
  return { svc, email };
}

function urlsIn(email: MemoryEmailService): string[] {
  return email.outbox.flatMap(m =>
    [...`${m.text ?? ''} ${m.html ?? ''}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m2 => m2[0]),
  );
}

describe('generated links use the canonical origin', () => {
  it('sends verification and reset links on the canonical host only', async () => {
    const { svc, email } = service(CANONICAL);
    await svc.signUp(PID, { email: 'person@example.com', password: 'Str0ng-Passw0rd!x' });
    await svc.requestPasswordReset(PID, 'person@example.com');

    const urls = urlsIn(email);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(`${CANONICAL}/`)).toBe(true);
      expect(url).not.toContain(RETIRED);
    }
    // The flows that matter are actually represented, not just "no bad URLs".
    expect(urls.some(u => u.includes('/verify?token='))).toBe(true);
    expect(urls.some(u => u.includes('/reset?token='))).toBe(true);
  });

  it('never emits a bare host or a doubled slash when APP_URL has a trailing slash', async () => {
    const { svc, email } = service(`${CANONICAL}/`);
    await svc.signUp(PID, { email: 'trailing@example.com', password: 'Str0ng-Passw0rd!x' });
    for (const url of urlsIn(email)) {
      expect(url).not.toMatch(/https:\/\/cloudnivo\.org\/\//);
      expect(url).not.toContain(RETIRED);
    }
  });
});
