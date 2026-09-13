import { createHash, randomInt } from 'node:crypto';

/**
 * Email/SMS one-time passcodes. Codes are short numeric strings shown to the
 * user; only sha256 hashes persist (via the injected store — the API passes
 * the shared cache, so OTPs work across instances and expire naturally).
 * Rate limiting happens at the route layer beside the other auth budgets.
 */

export interface OtpRecord {
  key: string;
  codeHash: string;
  purpose: 'login' | 'verify' | 'reset' | 'mfa' | 'phone';
  attempts: number;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface OtpStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryOtpStore implements OtpStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.map.get(key);
    if (!e || Date.now() > e.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttlSeconds = 600): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class OtpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
    this.status = status;
  }
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(`otp:${code}`).digest('hex');
}

export interface OtpServiceOptions {
  codeLength?: number;
  ttlSeconds?: number;
  maxAttempts?: number;
}

export class OtpService {
  private readonly codeLength: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  constructor(
    private readonly store: OtpStore,
    opts: OtpServiceOptions = {},
  ) {
    this.codeLength = Math.min(Math.max(opts.codeLength ?? 6, 4), 10);
    this.ttlSeconds = opts.ttlSeconds ?? 600;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  private recordKey(namespace: string, identity: string, purpose: string): string {
    return `otp:${namespace}:${purpose}:${identity.toLowerCase()}`;
  }

  /** Issue a code. Returns the PLAINTEXT code (send it, never store it). */
  async issue(
    namespace: string,
    identity: string,
    purpose: OtpRecord['purpose'],
  ): Promise<{ code: string; expiresAt: number }> {
    let code = '';
    for (let i = 0; i < this.codeLength; i += 1) code += String(randomInt(0, 10));
    const now = Date.now();
    const record: OtpRecord = {
      key: this.recordKey(namespace, identity, purpose),
      codeHash: hashOtpCode(code),
      purpose,
      attempts: 0,
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      consumedAt: null,
    };
    await this.store.set(record.key, JSON.stringify(record), this.ttlSeconds);
    return { code, expiresAt: record.expiresAt };
  }

  /** Verify + single-use consume. Wrong codes burn an attempt; exhaustion deletes. */
  async verify(
    namespace: string,
    identity: string,
    purpose: OtpRecord['purpose'],
    code: string,
  ): Promise<boolean> {
    const key = this.recordKey(namespace, identity, purpose);
    const raw = await this.store.get(key);
    if (!raw) throw new OtpError('OTP_EXPIRED', 'Code expired or not found', 410);
    const record = JSON.parse(raw) as OtpRecord;
    if (record.consumedAt) {
      await this.store.del(key);
      throw new OtpError('OTP_CONSUMED', 'Code already used', 410);
    }
    if (record.attempts >= this.maxAttempts) {
      await this.store.del(key);
      throw new OtpError('OTP_LOCKED', 'Too many wrong attempts — request a new code', 429);
    }
    if (record.codeHash !== hashOtpCode(String(code ?? '').trim())) {
      record.attempts += 1;
      const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
      await this.store.set(key, JSON.stringify(record), ttl);
      throw new OtpError('OTP_INVALID', 'Incorrect code', 401);
    }
    await this.store.del(key);
    return true;
  }
}
