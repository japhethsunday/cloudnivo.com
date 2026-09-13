import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  DEFAULT_PASSWORD_POLICY,
  mergePasswordPolicy,
} from './password-policy.js';
import {
  decodeBase32,
  generateBackupCodes,
  generateTotpSecret,
  totpNow,
  totpProvisionUri,
  verifyTotp,
} from './totp.js';
import { MemoryOtpStore, OtpService } from './otp.js';
import { verifyCaptcha } from './captcha.js';
import { isValidPhone, MemorySmsService } from './sms.js';
import { buildAuthorizeUrl, pkcePair } from './oidc.js';

describe('totp', () => {
  // RFC 6238 SHA-1 test vector: secret "12345678901234567890".
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC 6238 vector', () => {
    expect(totpNow(RFC_SECRET, 59_000)).toBe('287082');
    expect(totpNow(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
  });
  it('verifies with skew, rejects garbage', () => {
    expect(verifyTotp(RFC_SECRET, '287082', { atMs: 59_000 })).toBe(true);
    expect(verifyTotp(RFC_SECRET, '000000', { atMs: 59_000 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, '287082', { atMs: 59_000 + 29_000 })).toBe(true); // +1 step
    expect(verifyTotp(RFC_SECRET, '287082', { atMs: 59_000 + 61_000, window: 1 })).toBe(false);
    expect(verifyTotp('bad!!', '123456')).toBe(false);
  });
  it('round-trips generated secrets and provisioning URIs', () => {
    const secret = generateTotpSecret();
    expect(() => decodeBase32(secret)).not.toThrow();
    const code = totpNow(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(totpProvisionUri({ secret, account: 'a@b.c' })).toContain('otpauth://totp/');
  });
  it('backup codes are hashed, never stored raw', () => {
    const { codes, hashes } = generateBackupCodes(3);
    expect(codes).toHaveLength(3);
    expect(hashes).toHaveLength(3);
    for (const c of codes) expect(hashes.some(h => h.includes(c))).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts strong, rejects weak with reasons', () => {
    expect(checkPasswordPolicy('Correct-Horse-99!').ok).toBe(true);
    const weak = checkPasswordPolicy('password', DEFAULT_PASSWORD_POLICY);
    expect(weak.ok).toBe(false);
    expect(weak.reasons.length).toBeGreaterThan(1);
    expect(checkPasswordPolicy('short1A!').ok).toBe(false);
  });
  it('merges org overrides safely', () => {
    const merged = mergePasswordPolicy({ minLength: 16, requireSymbol: true });
    expect(merged.minLength).toBe(16);
    expect(merged.requireSymbol).toBe(true);
    expect(mergePasswordPolicy({ minLength: 3 }).minLength).toBe(8); // floor
    expect(mergePasswordPolicy(null)).toEqual(DEFAULT_PASSWORD_POLICY);
  });
});

describe('otp codes', () => {
  it('issues, verifies once, then expires', async () => {
    const svc = new OtpService(new MemoryOtpStore(), { ttlSeconds: 60 });
    const { code } = await svc.issue('proj', 'a@b.c', 'login');
    expect(code).toMatch(/^\d{6}$/);
    expect(await svc.verify('proj', 'a@b.c', 'login', code)).toBe(true);
    await expect(svc.verify('proj', 'a@b.c', 'login', code)).rejects.toMatchObject({
      code: 'OTP_EXPIRED',
    });
  });
  it('locks after max wrong attempts', async () => {
    const svc = new OtpService(new MemoryOtpStore(), { maxAttempts: 2 });
    await svc.issue('proj', 'b@b.c', 'login');
    await expect(svc.verify('proj', 'b@b.c', 'login', '000000')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    await expect(svc.verify('proj', 'b@b.c', 'login', '000000')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    await expect(svc.verify('proj', 'b@b.c', 'login', '000000')).rejects.toMatchObject({
      code: 'OTP_LOCKED',
    });
  });
});

describe('captcha + sms', () => {
  it('disabled captcha is open but honest', async () => {
    expect(await verifyCaptcha({ provider: 'disabled', secretKey: '' }, null)).toEqual({
      ok: true,
      enforced: false,
    });
    expect((await verifyCaptcha({ provider: 'turnstile', secretKey: 'k' }, null)).ok).toBe(false);
  });
  it('validates phone format and records dev outbox', async () => {
    expect(isValidPhone('+15551234567')).toBe(true);
    expect(isValidPhone('5551234')).toBe(false);
    const sms = new MemorySmsService();
    const r = await sms.send({ to: '+15551234567', body: 'code 123', channel: 'sms' });
    expect(r.delivered).toBe(false);
    expect(sms.lastTo('+15551234567')?.body).toBe('code 123');
  });
  it('oidc helpers build valid flows', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThan(20);
    const url = buildAuthorizeUrl({
      discovery: {
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/auth',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      },
      clientId: 'cid',
      redirectUri: 'https://app.example/cb',
      state: 's',
      nonce: 'n',
      codeChallenge: challenge,
    });
    expect(url).toContain('code_challenge_method=S256');
  });
});
