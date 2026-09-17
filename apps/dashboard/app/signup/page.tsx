'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorState } from '../../components/States';
import { PasswordField, passwordMeetsRules } from '../../components/PasswordField';
import styles from '../marketing.module.css';

export default function SignupPage(): React.JSX.Element {
  const { signup } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The submit button stays disabled until the form can actually succeed, so
  // the common failure is prevented rather than reported after a round trip.
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = email.trim().length > 3 && passwordMeetsRules(password) && confirm === password;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !ready) return;
    if (password !== confirm) {
      setError('Passwords do not match. Re-enter them to continue.');
      return;
    }
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
    <AuthLayout
      title="Create your CloudNivo account"
      sub="One account for every organization and project."
      asideNote="Start free. Provision a real PostgreSQL backend in under a minute."
    >
      <form onSubmit={submit} aria-label="Create account" className={styles.authForm}>
        <div className="field">
          <label htmlFor="signup-name">Display name (optional)</label>
          <input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Ada Lovelace"
          />
        </div>
        <div className="field">
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            required
            autoComplete="email"
            value={email}
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
        {error ? <ErrorState title="Couldn't create your account" message={error} /> : null}
        <button
          type="submit"
          className="btn btn-primary btn-block"
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
      <p className={styles.authAlt}>By creating an account you agree to use CloudNivo responsibly.</p>
      <p className={styles.authAlt} style={{ marginTop: 8 }}>
        Already have an account? <Link href="/login">Sign in</Link> ·{' '}
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
    </AuthLayout>
  );
}
