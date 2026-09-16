/**
 * Configurable password policy. Defaults enforce length + character-class
 * variety; organizations can tighten via policy records. A small built-in
 * denylist blocks the most abused passwords without any network call.
 */

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  /** Minimum character classes (0-4) when individual requires are off. */
  minClasses: number;
  denyCommon: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireLowercase: true,
  requireUppercase: true,
  requireDigit: true,
  requireSymbol: false,
  minClasses: 3,
  denyCommon: true,
};

/**
 * Minimum floor for CloudNivo platform accounts.
 *
 * Platform accounts hold the keys to every tenant's infrastructure, so signup
 * and password change never fall below this, whatever an organization
 * configures. It replaces the legacy policy on those paths, which accepted
 * "password" and "12345678" verbatim. Organizations can still tighten it;
 * they cannot loosen it.
 */
export const PLATFORM_BASELINE_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireLowercase: false,
  requireUppercase: false,
  requireDigit: false,
  requireSymbol: false,
  minClasses: 3,
  denyCommon: true,
};

export const LEGACY_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireLowercase: false,
  requireUppercase: false,
  requireDigit: false,
  requireSymbol: false,
  minClasses: 0,
  denyCommon: false,
};

// Most-abused passwords (truncated sample — catches spray attacks, not a full breach corpus).
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456',
  '12345678',
  '123456789',
  'qwerty',
  'abc123',
  'letmein',
  'welcome',
  'admin',
  'passw0rd',
  'password!',
  'changeme',
  'cloudnivo',
]);

export function checkPasswordPolicy(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (password.length < policy.minLength) {
    reasons.push(`Password must be at least ${policy.minLength} characters`);
  }
  if (password.length > policy.maxLength) {
    reasons.push(`Password must be at most ${policy.maxLength} characters`);
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  if (policy.requireLowercase && !classes[0]) reasons.push('Password needs a lowercase letter');
  if (policy.requireUppercase && !classes[1]) reasons.push('Password needs an uppercase letter');
  if (policy.requireDigit && !classes[2]) reasons.push('Password needs a digit');
  if (policy.requireSymbol && !classes[3]) reasons.push('Password needs a symbol');
  if (policy.minClasses > 0 && classes.filter(Boolean).length < policy.minClasses) {
    reasons.push(`Password needs at least ${policy.minClasses} of: lowercase, uppercase, digit, symbol`);
  }
  if (policy.denyCommon && COMMON_PASSWORDS.has(password.toLowerCase())) {
    reasons.push('Password is too common — pick something less predictable');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Merge an organization override onto the default (unknown keys ignored). */
export function mergePasswordPolicy(
  override: Partial<PasswordPolicy> | null | undefined,
): PasswordPolicy {
  if (!override) return { ...DEFAULT_PASSWORD_POLICY };
  const out = { ...DEFAULT_PASSWORD_POLICY };
  for (const key of Object.keys(DEFAULT_PASSWORD_POLICY) as (keyof PasswordPolicy)[]) {
    const value = override[key];
    if (typeof value === 'number' || typeof value === 'boolean') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  out.minLength = Math.min(Math.max(out.minLength, 8), 128);
  out.maxLength = Math.min(Math.max(out.maxLength, out.minLength), 256);
  out.minClasses = Math.min(Math.max(out.minClasses, 0), 4);
  return out;
}
