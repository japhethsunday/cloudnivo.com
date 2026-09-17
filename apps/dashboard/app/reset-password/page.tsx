'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorState } from '../../components/States';
import { PasswordField, passwordMeetsRules } from '../../components/PasswordField';
import styles from '../marketing.module.css';

/**
 * Spend a reset link.
 *
 * The token arrives in the query string, which means it is in the browser's
 * history and in any referrer. That is the standard shape for an emailed
 * reset link, and the server defends it the way it must: single-use, short
 * TTL, and every other session on the account is revoked when it is spent.
 * This page never stores the token anywhere.
 */
function ResetForm(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = passwordMeetsRules(password) && confirm === password && token.length > 0;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ reset: boolean }>('/api/v1/auth/password/reset', {
      method: 'POST',
      body: { token, password },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not reset your password.');
      return;
    }
    setDone(true);
  }

  if (!token) {
    return (
      <AuthLayout title="That link is incomplete" sub="No reset token was in the address.">
        <p className="muted">
          Open the link straight from the email — copying only part of it leaves the token behind.
        </p>
        <p className={styles.authAlt} style={{ marginTop: 16 }}>
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title="Password changed" sub="Every other session has been signed out.">
        <p className="muted">
          Your new password is active. Any device that was still signed in has been signed out, so
          sign in again to continue.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ marginTop: 16 }}
          onClick={() => router.replace('/login')}
        >
          Sign in
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      sub="This link works once, and signs out every other session."
    >
      <form onSubmit={submit} aria-label="Set a new password" className={styles.authForm}>
        <PasswordField
          id="reset-password"
          label="New password"
          value={password}
          onChange={setPassword}
          showRules
        />
        <PasswordField
          id="reset-confirm"
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          hint={mismatch ? 'These two do not match yet.' : undefined}
        />
        {error ? <ErrorState title="Couldn't reset your password" message={error} /> : null}
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={busy || !ready}
          aria-busy={busy}
        >
          {busy ? (
            <>
              <span className={styles.spinner} aria-hidden />
              Saving…
            </>
          ) : (
            'Set new password'
          )}
        </button>
      </form>
      <p className={styles.authAlt} style={{ marginTop: 16 }}>
        <Link href="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export default function ResetPasswordPage(): React.JSX.Element {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
