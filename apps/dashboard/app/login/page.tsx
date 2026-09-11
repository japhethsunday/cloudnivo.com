'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorState } from '../../components/States';
import styles from '../marketing.module.css';

function LoginForm(): React.JSX.Element {
  const { login } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await login(email.trim(), password);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    router.replace(params.get('next') || '/dashboard');
  }

  return (
    <AuthLayout title="Welcome back" sub="Sign in to your CloudNivo workspace.">
      <form onSubmit={submit} aria-label="Sign in" className={styles.authForm}>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        {error ? <ErrorState title="Couldn't sign you in" message={error} /> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
          {busy ? (
            <>
              <span className={styles.spinner} aria-hidden />
              Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
      <p className={styles.authAlt}>
        Don&apos;t have a CloudNivo account? <Link href="/signup">Create an account</Link>
      </p>
    </AuthLayout>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
