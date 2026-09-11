'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { ErrorState } from '../../components/States';

export default function SignupPage(): React.JSX.Element {
  const { signup } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
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
    <div className="auth-wrap">
      <div className="card auth-card">
        <p className="brand brand-sm">CloudNivo</p>
        <h1 style={{ margin: '0 0 4px' }}>Create your account</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          One account, every organization and project.
        </p>
        <form onSubmit={submit} aria-label="Sign up">
          <div className="field">
            <label htmlFor="signup-name">Display name (optional)</label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
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
          <div className="field">
            <label htmlFor="signup-password">Password (min 12 characters)</label>
            <input
              id="signup-password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          {error ? <ErrorState title="Couldn't create account" message={error} /> : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </div>
  );
}
