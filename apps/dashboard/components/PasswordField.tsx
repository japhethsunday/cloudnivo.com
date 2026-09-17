'use client';

import { useId, useMemo, useState } from 'react';

/**
 * Password input with a reveal control and live requirement feedback.
 *
 * The checks below mirror PLATFORM_BASELINE_PASSWORD_POLICY exactly (12
 * characters, at least 3 of the 4 character classes, not a common password).
 * They are GUIDANCE, not enforcement — the server re-checks every one of them
 * and is the only authority. Keeping them identical matters: a client that
 * promises a password is fine and then watches the server reject it is worse
 * than one that says nothing.
 *
 * The common-password check is the one rule this cannot do honestly on the
 * client — the denylist lives on the server — so it is not claimed here.
 */

export interface PasswordRule {
  id: string;
  label: string;
  met: boolean;
}

export function passwordRules(value: string): PasswordRule[] {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length;
  return [
    { id: 'length', label: 'At least 12 characters', met: value.length >= 12 },
    {
      id: 'classes',
      label: '3 of: lowercase, uppercase, digit, symbol',
      met: classes >= 3,
    },
  ];
}

export function passwordMeetsRules(value: string): boolean {
  return passwordRules(value).every(r => r.met);
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete = 'new-password',
  showRules = false,
  required = true,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete?: string;
  showRules?: boolean;
  required?: boolean;
  hint?: string;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const rulesId = useId();
  const rules = useMemo(() => passwordRules(value), [value]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          required={required}
          maxLength={128}
          autoComplete={autoComplete}
          value={value}
          onChange={e => onChange(e.target.value)}
          aria-describedby={showRules ? rulesId : undefined}
        />
        <button
          type="button"
          className="password-reveal"
          onClick={() => setShown(v => !v)}
          aria-pressed={shown}
          aria-label={shown ? 'Hide password' : 'Show password'}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {showRules ? (
        <ul className="password-rules" id={rulesId} aria-live="polite">
          {rules.map(r => (
            <li key={r.id} data-met={r.met ? 'true' : 'false'}>
              <span aria-hidden>{r.met ? '✓' : '·'}</span>
              {r.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
