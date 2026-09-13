/**
 * Bot-protection abstraction. Providers verify the client token server-side;
 * when unconfigured the gate is OPEN (dev default) and honestly reported as
 * such — production sets CAPTCHA_PROVIDER + CAPTCHA_SECRET_KEY to enforce.
 * Secrets never leave the server; verification failures are generic.
 */

export type CaptchaProvider = 'disabled' | 'turnstile' | 'hcaptcha';

export interface CaptchaConfig {
  provider: CaptchaProvider;
  secretKey: string;
  /** Minimum score/threshold semantics reserved for score-based providers. */
  siteKey?: string;
}

export class CaptchaError extends Error {
  constructor(message = 'Bot verification failed') {
    super(message);
    this.name = 'CaptchaError';
  }
}

const VERIFY_URL: Record<Exclude<CaptchaProvider, 'disabled'>, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
};

export async function verifyCaptcha(
  config: CaptchaConfig,
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<{ ok: boolean; enforced: boolean }> {
  if (config.provider === 'disabled' || !config.secretKey) {
    return { ok: true, enforced: false };
  }
  if (!token) return { ok: false, enforced: true };
  try {
    const body = new URLSearchParams({ secret: config.secretKey, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(VERIFY_URL[config.provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return { ok: json?.success === true, enforced: true };
  } catch {
    // Provider outage must not hard-lock auth: fail closed for bots is
    // wrong here — deny with a retryable error instead of a confusing 500.
    throw new CaptchaError('Verification service unavailable — try again');
  }
}
