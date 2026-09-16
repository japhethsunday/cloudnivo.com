import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, PLATFORM_BASELINE_PASSWORD_POLICY } from './password-policy.js';

describe('platform password baseline', () => {
  const policy = PLATFORM_BASELINE_PASSWORD_POLICY;

  it.each(['password', '12345678', 'aaaaaaaa', 'Password', 'changeme'])(
    'rejects the weak password %s',
    weak => {
      // These were all accepted at signup: the platform fell back to the
      // legacy policy (8 chars, no classes, no denylist) for every account.
      expect(checkPasswordPolicy(weak, policy).ok).toBe(false);
    },
  );

  it('accepts a genuinely strong password', () => {
    expect(checkPasswordPolicy('Str0ng-Passw0rd!x', policy).ok).toBe(true);
  });

  it('requires at least 12 characters and 3 character classes', () => {
    expect(policy.minLength).toBeGreaterThanOrEqual(12);
    expect(policy.minClasses).toBeGreaterThanOrEqual(3);
    expect(policy.denyCommon).toBe(true);
  });
});
