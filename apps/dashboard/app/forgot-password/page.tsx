'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorState } from '../../components/States';
import styles from '../marketing.module.css';

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
      <AuthLayout
        title="Check your inbox"
        sub="If that address has a CloudNivo account, a reset link is on its way."
        asideNote="Reset links expire, and using one signs out every other session on the account."
      >
        <p className="muted">
          The link is single-use and expires. If it does not arrive within a few minutes, check
          spam, then try again — requesting a new link cancels the previous one.
        </p>
        <p className={styles.authAlt} style={{ marginTop: 16 }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      sub="We'll email you a link to choose a new one."
      asideNote="Reset links expire, and using one signs out every other session on the account."
    >
      <form onSubmit={submit} aria-label="Request password reset" className={styles.authForm}>
        <div className="field">
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
        {error ? <ErrorState title="Couldn't send the link" message={error} /> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
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
      <p className={styles.authAlt} style={{ marginTop: 16 }}>
        Remembered it? <Link href="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
