'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { ErrorState } from '../../components/States';

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
    <div className="auth-wrap">
      <div className="card auth-card">
        <p className="brand brand-sm">CloudNivo</p>
        <h1 style={{ margin: '0 0 4px' }}>Log in</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Access your organizations and projects.
        </p>
        <form onSubmit={submit} aria-label="Log in">
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
          {error ? <ErrorState title="Couldn't log in" message={error} /> : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          New to CloudNivo? <Link href="/signup">Create an account</Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
