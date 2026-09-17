'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { AuthGlass } from '../../components/AuthGlass';
import styles from '../auth-glass.module.css';

/**
 * Request a password reset link.
 *
 * The API answers identically whether or not the address has an account, so
 * this page must too — telling someone "no such account" would hand an
 * attacker a way to enumerate registered emails. The confirmation is
 * therefore carefully worded: it says what was done (a link was sent IF the
 * account exists), not that an account exists.
 */
export default function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ sent: boolean }>('/api/v1/auth/password/forgot', {
      method: 'POST',
      body: { email: email.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not send the reset link. Try again in a moment.');
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthGlass
        title="Check your inbox"
        sub="If that address has a CloudNivo account, a reset link is on its way."
        foot="Reset links expire, and using one signs out every other session on the account."
      >
        <p className={styles.hint}>
          The link is single-use and expires. If it does not arrive within a few minutes, check
          spam, then try again — requesting a new link cancels the previous one.
        </p>
        <p className={styles.alt}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </AuthGlass>
    );
  }

  return (
    <AuthGlass
      title="Reset your password"
      sub="We'll email you a link to choose a new one."
      foot="Reset links expire, and using one signs out every other session on the account."
    >
      <form onSubmit={submit} aria-label="Request password reset" className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </div>
        {error ? (
          <p className={`${styles.alert} ${styles.alertError}`} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className={styles.submit} disabled={busy} aria-busy={busy}>
          {busy ? (
            <>
              <span className={styles.spinner} aria-hidden />
              Sending…
            </>
          ) : (
            'Send reset link'
          )}
        </button>
      </form>
      <p className={styles.alt}>
        Remembered it? <Link href="/login">Sign in</Link>
      </p>
    </AuthGlass>
  );
}
