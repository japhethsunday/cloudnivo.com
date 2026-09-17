'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { AuthGlass } from '../../components/AuthGlass';
import { OtpInput } from '../../components/OtpInput';
import styles from '../auth-glass.module.css';

/**
 * Sign in, including the second factor.
 *
 * The challenge is a real step in this API: POST /auth/login answers 200 with
 * `{ mfaRequired, mfaTicket }` and no token, and the ticket is spent against
 * /auth/mfa-verify. The dashboard previously had no branch for that answer,
 * so an account with MFA enabled was told "Login failed" and could not get
 * in at all.
 *
 * The code is a TOTP from the user's authenticator app, or one of their
 * backup codes — the server checks both. Nothing is emailed, so there is no
 * "resend": the honest timer is the ticket's own five-minute expiry, which
 * is what the countdown below reports.
 */

/** Matches the server's `platform-mfa:<ticket>` TTL in apps/api/src/platform-auth.ts. */
const CHALLENGE_TTL_SECONDS = 300;
const CODE_LENGTH = 6;

function clock(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function LoginForm(): React.JSX.Element {
  const { login, verifyMfa } = useSession();
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [backupMode, setBackupMode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [left, setLeft] = useState(CHALLENGE_TTL_SECONDS);

  const go = useCallback((): void => {
    const next = params.get('next');
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
    router.replace(safeNext);
  }, [params, router]);

  // The countdown is the ticket's real life, so when it reaches zero the
  // challenge is genuinely dead and the form says so rather than letting the
  // user type a code the server will refuse.
  useEffect(() => {
    if (!ticket) return;
    const id = setInterval(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [ticket]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await login(email.trim(), password);
    setBusy(false);

    if (result.kind === 'ok') {
      go();
      return;
    }
    if (result.kind === 'mfa') {
      setTicket(result.ticket);
      setLeft(CHALLENGE_TTL_SECONDS);
      return;
    }
    if (result.kind === 'mfa-setup') {
      setError(
        'This account must finish setting up two-factor authentication before signing in. Open the CloudNivo CLI or contact your administrator to complete enrolment.',
      );
      return;
    }
    setError(result.message);
  }

  const spend = useCallback(
    async (value: string): Promise<void> => {
      if (!ticket || busy) return;
      setBusy(true);
      setError(null);
      const err = await verifyMfa(ticket, value.trim());
      setBusy(false);
      if (err) {
        setError(err);
        setCode('');
        return;
      }
      go();
    },
    [ticket, busy, verifyMfa, go],
  );

  if (ticket) {
    const expired = left === 0;
    const ready = backupMode ? backupCode.trim().length >= 4 : code.length === CODE_LENGTH;

    return (
      <AuthGlass
        title="Two-factor authentication"
        sub={
          backupMode
            ? 'Enter one of the backup codes you saved when you enabled two-factor authentication.'
            : 'Enter the 6-digit code from your authenticator app.'
        }
      >
        <form
          className={styles.form}
          aria-label="Two-factor authentication"
          onSubmit={e => {
            e.preventDefault();
            void spend(backupMode ? backupCode : code);
          }}
        >
          {backupMode ? (
            <div className={styles.field}>
              <label htmlFor="mfa-backup">Backup code</label>
              <input
                id="mfa-backup"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                value={backupCode}
                disabled={busy || expired}
                onChange={e => setBackupCode(e.target.value)}
              />
            </div>
          ) : (
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={c => void spend(c)}
              length={CODE_LENGTH}
              disabled={busy || expired}
              label="Authentication code"
            />
          )}

          <div className={styles.otpMeta}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setBackupMode(v => !v);
                setError(null);
              }}
            >
              {backupMode ? 'Use your authenticator app' : 'Use a backup code'}
            </button>
            <span className={`${styles.otpClock}${left <= 30 ? ` ${styles.otpClockLow}` : ''}`}>
              {expired ? 'Challenge expired' : `Expires in ${clock(left)}`}
            </span>
          </div>

          {error ? (
            <p className={`${styles.alert} ${styles.alertError}`} role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className={styles.submit}
            disabled={busy || expired || !ready}
            aria-busy={busy}
          >
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden />
                Verifying code…
              </>
            ) : (
              'Verify'
            )}
          </button>
        </form>

        <p className={styles.alt}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              setTicket(null);
              setCode('');
              setBackupCode('');
              setBackupMode(false);
              setError(null);
            }}
          >
            Start over
          </button>
        </p>
      </AuthGlass>
    );
  }

  return (
    <AuthGlass title="Welcome back" sub="Sign in to your CloudNivo workspace.">
      <form onSubmit={submit} aria-label="Sign in" className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            disabled={busy}
            onChange={e => setEmail(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor="login-password">Password</label>
            <Link className={styles.asideLink} href="/forgot-password">
              Forgot password?
            </Link>
          </div>
          <div className={styles.pwWrap}>
            <input
              id="login-password"
              type={shown ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={e => setPassword(e.target.value)}
            />
            <button
              type="button"
              className={styles.reveal}
              onClick={() => setShown(v => !v)}
              aria-pressed={shown}
              aria-label={shown ? 'Hide password' : 'Show password'}
            >
              {shown ? 'Hide' : 'Show'}
            </button>
          </div>
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
              Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>

      <p className={styles.alt}>
        Don&apos;t have a CloudNivo account? <Link href="/signup">Create an account</Link>
      </p>
    </AuthGlass>
  );
}

export default function LoginPage(): React.JSX.Element {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
