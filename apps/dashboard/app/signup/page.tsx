'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { AuthGlass } from '../../components/AuthGlass';
import { PasswordField, passwordMeetsRules } from '../../components/PasswordField';
import styles from '../auth-glass.module.css';

const POINTS = ['Isolated PostgreSQL', 'Scoped keys', 'Approval gates'] as const;

export default function SignupPage(): React.JSX.Element {
  const { signup } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The submit stays closed until the form can actually succeed, so the
  // common failure is prevented rather than reported after a round trip.
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = email.trim().length > 3 && passwordMeetsRules(password) && confirm === password;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const err = await signup(email.trim(), password, displayName.trim() || undefined);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    router.replace('/dashboard');
  }

  return (
    <AuthGlass
      title="Create your CloudNivo account"
      sub="One account for every organization and project."
      points={POINTS}
      foot="By creating an account you agree to use CloudNivo responsibly." 
    >
      <form onSubmit={submit} aria-label="Create account" className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="signup-name">Display name (optional)</label>
          <input
            id="signup-name"
            type="text"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={displayName}
            disabled={busy}
            onChange={e => setDisplayName(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            disabled={busy}
            onChange={e => setEmail(e.target.value)}
          />
        </div>

        <PasswordField
          id="signup-password"
          label="Password"
          value={password}
          onChange={setPassword}
          showRules
        />
        <PasswordField
          id="signup-confirm"
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          hint={mismatch ? 'These two do not match yet.' : undefined}
        />

        {error ? (
          <p className={`${styles.alert} ${styles.alertError}`} role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className={styles.submit}
          disabled={busy || !ready}
          aria-busy={busy}
        >
          {busy ? (
            <>
              <span className={styles.spinner} aria-hidden />
              Creating account…
            </>
          ) : (
            'Create account'
          )}
        </button>
      </form>

      <p className={styles.alt}>
        Already have an account? <Link href="/login">Sign in</Link> ·{' '}
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
    </AuthGlass>
  );
}
