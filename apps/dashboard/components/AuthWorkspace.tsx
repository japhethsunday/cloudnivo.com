'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import { timeAgo } from '../lib/format';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { SectionTabs } from './SectionTabs';

interface CustomerUser {
  id: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: 'active' | 'disabled' | string;
  role: string;
  isAnonymous: boolean;
  totpEnabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

interface CustomerSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastActiveAt: string;
  ipAddress: string | null;
}

interface TestAccount {
  email: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

function emailDeliveryLabel(driver: string): { name: string; note: string } {
  if (driver === 'resend') return { name: 'Resend', note: 'Transactional email is delivered through Resend.' };
  if (driver === 'smtp') return { name: 'SMTP', note: 'Transactional email is delivered through your SMTP server.' };
  return { name: 'Development', note: 'Email is captured for inspection during development — connect Resend or SMTP to deliver to real inboxes.' };
}

export function AuthWorkspace({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/auth`;
  const [users, setUsers] = useState<CustomerUser[] | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [emailStatus, setEmailStatus] = useState<{ driver: string; queued: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<TestAccount | null>(null);

  const load = useCallback(async () => {
    const [u, c, e] = await Promise.all([
      apiFetch<{ users: CustomerUser[] }>(`${base}/admin/users`),
      apiFetch<{ config: { allowedOrigins: string[] } }>(`${base}/config`),
      apiFetch<{ driver: string; queued: number | null }>(`${base}/email/status`),
    ]);
    if (!u.ok) {
      setError(u.error ?? 'Could not load users');
      return;
    }
    setUsers(u.data?.users ?? []);
    setError(null);
    // allowedOrigins is an array in production but some backends return a
    // plain string — normalize so the UI never breaks on the shape.
    const raw = (c.data?.config as { allowedOrigins?: unknown } | undefined)?.allowedOrigins;
    if (c.ok) {
      setOrigins(
        Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === 'string')
          : typeof raw === 'string' && raw.length > 0
            ? [raw]
            : [],
      );
    }
    if (e.ok && e.data) setEmailStatus(e.data);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const list = users ?? [];
    return {
      total: list.length,
      verified: list.filter(u => u.emailVerified).length,
      mfa: list.filter(u => u.totpEnabled).length,
      anonymous: list.filter(u => u.isAnonymous).length,
      disabled: list.filter(u => u.status === 'disabled').length,
      activeSessions: null as number | null,
    };
  }, [users]);

  if (error && !users) return <ErrorState title="Couldn't load authentication" message={error} retry={() => void load()} />;
  if (!users) return <LoadingSkeleton label="Loading authentication" rows={4} />;

  return (
    <SectionTabs
      label="Authentication sections"
      param="tab"
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'users', label: `Users · ${stats.total}` },
        { id: 'signin', label: 'Sign-in methods' },
        { id: 'mfa', label: 'MFA' },
        { id: 'sessions', label: 'Sessions' },
        { id: 'security', label: 'Security' },
      ]}
      render={active => (
        <>
          {active === 'overview' ? (
            <AuthOverview stats={stats} origins={origins} emailStatus={emailStatus} users={users} />
          ) : null}
          {active === 'users' ? <UsersTable users={users} base={base} reload={() => void load()} /> : null}
          {active === 'signin' ? <SignInMethods base={base} emailStatus={emailStatus} reload={() => void load()} /> : null}
          {active === 'mfa' ? (
            <MfaSection base={base} users={users} account={account} setAccount={setAccount} />
          ) : null}
          {active === 'sessions' ? (
            <SessionsSection base={base} account={account} setAccount={setAccount} />
          ) : null}
          {active === 'security' ? (
            <AuthSecurity base={base} origins={origins} setOrigins={setOrigins} users={users} />
          ) : null}
        </>
      )}
    />
  );
}

/* ── Overview ─────────────────────────────────────────────────── */

function AuthOverview({
  stats,
  origins,
  emailStatus,
  users,
}: {
  stats: { total: number; verified: number; mfa: number; anonymous: number; disabled: number };
  origins: string[];
  emailStatus: { driver: string; queued: number | null } | null;
  users: CustomerUser[];
}): React.JSX.Element {
  const delivery = emailDeliveryLabel(emailStatus?.driver ?? 'memory');
  const recent = [...users].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 5);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="stat-grid" role="list" aria-label="Authentication totals">
        <div className="stat" role="listitem">
          <div className="k">Users</div>
          <div className="v">{stats.total}</div>
          <div className="s">{stats.verified} verified · {stats.anonymous} guest</div>
        </div>
        <div className="stat" role="listitem">
          <div className="k">MFA enrolled</div>
          <div className="v">{stats.mfa}</div>
          <div className="s">{stats.total > 0 ? `${Math.round((stats.mfa / stats.total) * 100)}% of users` : 'no users yet'}</div>
        </div>
        <div className="stat" role="listitem">
          <div className="k">Email delivery</div>
          <div className="v" style={{ fontSize: 18 }}>{delivery.name}</div>
          <div className="s">OTP · magic links · resets · verification</div>
        </div>
        <div className="stat" role="listitem">
          <div className="k">Browser origins</div>
          <div className="v">{origins.length}</div>
          <div className="s">{origins.length > 0 ? 'project allowlist active' : 'inheriting global policy'}</div>
        </div>
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>How sign-in works here</h2>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Each project has its own isolated user directory. Access tokens are short-lived and
          rotate through refresh tokens; reuse of a refresh token invalidates the whole session
          family. Passwords are never displayed — not even to project admins.
        </p>
        <ul className="health-list">
          <li className="health-row"><span className="grow"><span className="name">Email + password</span><div className="detail">8+ characters · verification and reset by email</div></span></li>
          <li className="health-row"><span className="grow"><span className="name">Email codes</span><div className="detail">10-minute codes · 5 attempts · rate-limited</div></span></li>
          <li className="health-row"><span className="grow"><span className="name">Magic links</span><div className="detail">Passwordless sign-in, single use</div></span></li>
          <li className="health-row"><span className="grow"><span className="name">SMS codes</span><div className="detail">Phone verification and phone-first sign-in</div></span></li>
          <li className="health-row"><span className="grow"><span className="name">Guest accounts</span><div className="detail">Anonymous users convert to full accounts later</div></span></li>
        </ul>
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Recently joined</h2>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No users yet" hint="Users appear here after signing up through your app, or create a test user in Sign-in methods." />
        ) : (
          <ul className="health-list">
            {recent.map(u => (
              <li key={u.id} className="health-row">
                <span className="grow">
                  <span className="name"><code>{u.email || '(guest)'}</code></span>
                  <div className="detail">{timeAgo(u.createdAt)}{u.totpEnabled ? ' · MFA on' : ''}</div>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── Users ────────────────────────────────────────────────────── */

function UsersTable({
  users,
  base,
  reload,
}: {
  users: CustomerUser[];
  base: string;
  reload: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'unverified' | 'mfa' | 'guest' | 'disabled'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = users.filter(u => {
    if (filter === 'unverified' && (u.emailVerified || u.isAnonymous)) return false;
    if (filter === 'mfa' && !u.totpEnabled) return false;
    if (filter === 'guest' && !u.isAnonymous) return false;
    if (filter === 'disabled' && u.status !== 'disabled') return false;
    const q = query.trim().toLowerCase();
    if (q && !`${u.email} ${u.phone ?? ''} ${u.id}`.toLowerCase().includes(q)) return false;
    return true;
  });

  async function setStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
    setError(null);
    setNotice(null);
    const r = await apiFetch(`${base}/admin/users`, { method: 'PATCH', body: { id, status } });
    if (!r.ok) setError(r.error ?? 'Update failed');
    else {
      setNotice(status === 'disabled' ? 'User disabled — their sessions no longer authenticate.' : 'User re-enabled.');
      reload();
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Delete this user and revoke all their sessions? This cannot be undone.')) return;
    const r = await apiFetch(`${base}/admin/users`, { method: 'DELETE', body: { id } });
    if (!r.ok) setError(r.error ?? 'Delete failed');
    else {
      setNotice('User deleted and sessions revoked.');
      reload();
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="toolbar" role="search">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by email, phone or ID…" aria-label="Search users" style={{ flex: '2 1 220px' }} />
        <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} aria-label="Filter users">
          <option value="all">All users ({users.length})</option>
          <option value="unverified">Needs verification</option>
          <option value="mfa">MFA enrolled</option>
          <option value="guest">Guests</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>
      {notice ? <p role="status" style={{ fontSize: 13 }}>{notice}</p> : null}
      {error ? <ErrorState message={error} /> : null}
      {shown.length === 0 ? (
        <div className="card"><EmptyState title="No users match" hint="Adjust the search or filter." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" aria-label="Project users">
            <thead>
              <tr>
                <th>User</th>
                <th>Verified</th>
                <th>MFA</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map(u => (
                <tr key={u.id}>
                  <td>
                    <code>{u.email || '(guest account)'}</code>
                    <div className="muted" style={{ fontSize: 11 }}>{u.role}{u.isAnonymous ? ' · guest' : ''}{u.phone ? ` · ${u.phone}` : ''}</div>
                  </td>
                  <td>{u.isAnonymous ? '—' : u.emailVerified ? 'Yes' : 'No'}</td>
                  <td>{u.totpEnabled ? 'On' : 'Off'}</td>
                  <td>{u.status}</td>
                  <td>{u.lastSignInAt ? timeAgo(u.lastSignInAt) : 'never'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {u.status === 'active' ? (
                        <button type="button" className="btn btn-sm" onClick={() => void setStatus(u.id, 'disabled')}>Disable</button>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => void setStatus(u.id, 'active')}>Enable</button>
                      )}
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(u.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Sign-in methods ──────────────────────────────────────────── */

function useTester(base: string): {
  out: unknown;
  error: string | null;
  busy: string | null;
  call: (kind: string, body: unknown, opts?: { token?: string; method?: string }) => Promise<{ ok: boolean; data?: unknown }>;
  reset: () => void;
} {
  const [out, setOut] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function call(kind: string, body: unknown, opts?: { token?: string; method?: string }): Promise<{ ok: boolean; data?: unknown }> {
    setBusy(kind);
    setError(null);
    setOut(null);
    const r = await apiFetch<{ [k: string]: unknown }>(`${base}/${kind}`, {
      method: (opts?.method ?? 'POST') as 'POST',
      body,
      ...(opts?.token ? { token: opts.token } : {}),
    });
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? 'Request failed');
      return { ok: false };
    }
    const safe = { ...(r.data ?? {}) };
    // Never render credential material — top-level or nested.
    for (const k of ['accessToken', 'refreshToken', 'secret', 'uri', 'magicToken', 'code']) {
      if (typeof safe[k] === 'string') safe[k] = redact(String(safe[k]));
    }
    const nested = safe['tokens'] as Record<string, unknown> | undefined;
    if (nested && typeof nested === 'object') {
      const copy = { ...nested };
      for (const k of ['accessToken', 'refreshToken']) {
        if (typeof copy[k] === 'string') copy[k] = redact(String(copy[k]));
      }
      safe['tokens'] = copy;
    }
    setOut(safe);
    return { ok: true, data: r.data };
  }
  function reset(): void {
    setOut(null);
    setError(null);
  }
  return { out, error, busy, call, reset };
}

function redact(v: string): string {
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}…${v.slice(-4)} (truncated for display)`;
}

/** Customer auth nests credentials under `tokens` — never top-level. */
function extractTokens(d: Record<string, unknown>): { accessToken: string; refreshToken: string } | null {
  const t = d['tokens'] as { accessToken?: unknown; refreshToken?: unknown } | undefined;
  if (t && typeof t.accessToken === 'string') {
    return {
      accessToken: t.accessToken,
      refreshToken: typeof t.refreshToken === 'string' ? t.refreshToken : '',
    };
  }
  return null;
}

function Result({ tester }: { tester: ReturnType<typeof useTester> }): React.JSX.Element {
  return (
    <>
      {tester.busy ? <p className="muted" role="status" style={{ fontSize: 13 }}>Sending…</p> : null}
      {tester.error ? <ErrorState message={tester.error} /> : null}
      {tester.out ? (
        <pre className="codeblock" style={{ maxHeight: 220 }} aria-live="polite">{JSON.stringify(tester.out, null, 2)}</pre>
      ) : null}
    </>
  );
}

function SignInMethods({
  base,
  emailStatus,
  reload,
}: {
  base: string;
  emailStatus: { driver: string; queued: number | null } | null;
  reload: () => void;
}): React.JSX.Element {
  const tester = useTester(base);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const delivery = emailDeliveryLabel(emailStatus?.driver ?? 'memory');

  async function createUser(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const r = await tester.call('signup', { email: email.trim(), password });
    if (r.ok) {
      setPassword('');
      reload();
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>{delivery.name}</h2>
          <p>{delivery.note}</p>
        </div>
        {emailStatus?.queued !== null && emailStatus?.queued !== undefined ? (
          <p className="muted" style={{ fontSize: 13 }}>{emailStatus.queued} message(s) captured during development.</p>
        ) : null}
      </div>

      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Accounts, verification, recovery</h2>
          <p>Passwords require 8+ characters. Verification links and password resets arrive by email.</p>
        </div>
        <form onSubmit={e => void createUser(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" aria-label="User email" autoComplete="off" style={{ flex: '2 1 180px' }} />
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Temporary password (8+ chars)" aria-label="Temporary password" type="password" autoComplete="new-password" style={{ flex: '2 1 180px' }} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !email.trim() || password.length < 8}>Create user</button>
        </form>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !email.trim()} onClick={() => void tester.call('reset-request', { email: email.trim() })}>Send password reset</button>
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !token.trim()} onClick={() => void tester.call('reset', { token: token.trim(), password: password || 'New-password-1' })}>Complete reset with token</button>
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !token.trim()} onClick={() => void tester.call('verify', { token: token.trim() })}>Verify email with token</button>
          <input value={token} onChange={e => setToken(e.target.value)} placeholder="Paste reset / verification token" aria-label="Reset or verification token" style={{ flex: '2 1 200px' }} />
        </div>
        <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
      </div>

      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Email codes + magic links</h2>
          <p>Codes expire after 10 minutes and allow 5 attempts. Requests are rate-limited per address.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <input value={code} onChange={e => setCode(e.target.value)} placeholder="6-digit code" aria-label="One-time code" autoComplete="off" style={{ flex: '1 1 140px' }} />
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !email.trim()} onClick={() => void tester.call('otp-request', { email: email.trim(), purpose: 'login' })}>Send email code</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !email.trim() || !code.trim()} onClick={() => void tester.call('otp-verify', { email: email.trim(), code: code.trim(), purpose: 'login' })}>Verify code + sign in</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !email.trim()} onClick={() => void tester.call('magic-request', { email: email.trim() })}>Send magic link</button>
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>The link signs the user in when opened — single use, expires quickly.</span>
        </div>
        <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
      </div>

      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>SMS verification + phone sign-in</h2>
          <p>Codes are delivered through the configured SMS gateway.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" aria-label="Phone number" autoComplete="off" style={{ flex: '1 1 160px' }} />
          <button type="button" className="btn btn-sm" disabled={tester.busy !== null || !phone.trim()} onClick={() => void tester.call('phone-login-request', { phone: phone.trim() })}>Send SMS code</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !phone.trim() || !code.trim()} onClick={() => void tester.call('phone-login-verify', { phone: phone.trim(), code: code.trim() })}>Verify SMS code</button>
        </div>
        <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
      </div>

      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Anonymous accounts</h2>
          <p>Start a guest session with no credentials; it converts to a full account when the user signs up.</p>
        </div>
        <button type="button" className="btn btn-sm" disabled={tester.busy !== null} onClick={() => void tester.call('anonymous', {}, { method: 'POST' })}>Create guest account</button>
        <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
      </div>
    </div>
  );
}

/* ── MFA ──────────────────────────────────────────────────────── */

function MfaSection({
  base,
  users,
  account,
  setAccount,
}: {
  base: string;
  users: CustomerUser[];
  account: TestAccount | null;
  setAccount: (a: TestAccount | null) => void;
}): React.JSX.Element {
  const enrolled = users.filter(u => u.totpEnabled);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Authenticator apps (TOTP) + recovery codes</h2>
          <p>Users enroll from their own signed-in session. Each enrollment returns backup codes for account recovery.</p>
        </div>
        {enrolled.length === 0 ? (
          <EmptyState title="No one enrolled yet" hint="MFA status per user appears here once they enroll." />
        ) : (
          <ul className="health-list">
            {enrolled.map(u => (
              <li key={u.id} className="health-row">
                <span className="grow">
                  <span className="name"><code>{u.email}</code></span>
                  <div className="detail">Enrolled{ u.lastSignInAt ? ` · last sign-in ${timeAgo(u.lastSignInAt)}` : ''}</div>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TestSignIn base={base} account={account} setAccount={setAccount} context="Enroll, confirm or disable MFA as that user. The test session lives only in this browser tab." />
      {account ? <MfaTester base={base} account={account} /> : null}
    </div>
  );
}

function TestSignIn({
  base,
  account,
  setAccount,
  context,
}: {
  base: string;
  account: TestAccount | null;
  setAccount: (a: TestAccount | null) => void;
  context: string;
}): React.JSX.Element {
  const tester = useTester(base);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  async function signIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const r = await tester.call('token', { email: email.trim(), password });
    if (!r.ok || !r.data) return;
    const d = r.data as Record<string, unknown>;
    if (d['mfaRequired'] === true && typeof d['mfaTicket'] === 'string') {
      setMfaTicket(d['mfaTicket']);
      return;
    }
    const creds = extractTokens(d);
    if (creds) {
      setAccount({
        email: email.trim(),
        userId: String((d['user'] as Record<string, unknown> | undefined)?.['id'] ?? ''),
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
      });
      setPassword('');
    }
  }

  async function completeMfa(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!mfaTicket) return;
    const r = await tester.call('mfa-verify', { mfaTicket, code: mfaCode.trim() });
    if (!r.ok || !r.data) return;
    const d = r.data as Record<string, unknown>;
    const creds = extractTokens(d);
    if (creds) {
      setAccount({
        email,
        userId: String((d['user'] as Record<string, unknown> | undefined)?.['id'] ?? ''),
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
      });
      setMfaTicket(null);
      setMfaCode('');
      setPassword('');
    }
  }

  if (account) {
    return (
      <div className="card">
        <div className="section-head split">
          <div>
            <h2 style={{ fontSize: 15 }}>Signed in as <code>{account.email}</code></h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setAccount(null)}>Sign out test session</button>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>Actions below run with this user&apos;s real credentials. Nothing is stored — closing the tab ends it.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-head">
        <h2 style={{ fontSize: 15 }}>Sign in as a user to test</h2>
        <p>{context}</p>
      </div>
      {!mfaTicket ? (
        <form onSubmit={e => void signIn(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" aria-label="Test user email" autoComplete="off" style={{ flex: '2 1 180px' }} />
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" aria-label="Test user password" type="password" autoComplete="current-password" style={{ flex: '2 1 160px' }} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !email.trim() || !password}>Sign in</button>
        </form>
      ) : (
        <form onSubmit={e => void completeMfa(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>This account requires a second factor.</span>
          <input value={mfaCode} onChange={e => setMfaCode(e.target.value)} placeholder="Authenticator code" aria-label="Authenticator code" autoComplete="off" style={{ flex: '1 1 160px' }} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !mfaCode.trim()}>Verify + sign in</button>
          <button type="button" className="btn btn-sm" onClick={() => setMfaTicket(null)}>Back</button>
        </form>
      )}
      <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
    </div>
  );
}

function MfaTester({ base, account }: { base: string; account: TestAccount }): React.JSX.Element {
  const tester = useTester(base);
  const [code, setCode] = useState('');
  const [enroll, setEnroll] = useState<{ secret?: string; uri?: string } | null>(null);

  async function doEnroll(): Promise<void> {
    const r = await tester.call('mfa-enroll', {}, { token: account.accessToken });
    if (r.ok && r.data) setEnroll(r.data as { secret?: string; uri?: string });
  }

  return (
    <div className="card">
      <div className="section-head">
        <h2 style={{ fontSize: 15 }}>Enroll · confirm · disable</h2>
        <p>Scan the provisioning URI with an authenticator app, then confirm with a live code.</p>
      </div>
      {enroll?.uri ? (
        <p style={{ fontSize: 13, wordBreak: 'break-all' }}><code>{enroll.uri}</code></p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <button type="button" className="btn btn-sm" disabled={tester.busy !== null} onClick={() => void doEnroll()}>1 · Enroll (show provisioning URI)</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="Authenticator code" aria-label="Authenticator code" autoComplete="off" style={{ flex: '1 1 160px' }} />
        <button type="button" className="btn btn-sm btn-primary" disabled={tester.busy !== null || !code.trim()} onClick={() => void tester.call('mfa-confirm', { code: code.trim() }, { token: account.accessToken })}>2 · Confirm enrollment</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={tester.busy !== null || !code.trim()} onClick={() => void tester.call('mfa-disable', { code: code.trim() }, { token: account.accessToken })}>Disable MFA</button>
      </div>
      <div style={{ marginTop: 8 }}><Result tester={tester} /></div>
    </div>
  );
}

/* ── Sessions ─────────────────────────────────────────────────── */

function SessionsSection({
  base,
  account,
  setAccount,
}: {
  base: string;
  account: TestAccount | null;
  setAccount: (a: TestAccount | null) => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<CustomerSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!account) {
      setSessions(null);
      return;
    }
    setBusy(true);
    const r = await apiFetch<{ sessions: CustomerSession[] }>(`${base}/sessions`, {
      token: account.accessToken,
    });
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Could not load sessions');
    else {
      setSessions(r.data?.sessions ?? []);
      setError(null);
    }
  }, [base, account]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string): Promise<void> {
    if (!account) return;
    if (!window.confirm('Revoke this session? The device is signed out immediately.')) return;
    const r = await apiFetch(`${base}/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      token: account.accessToken,
    });
    if (!r.ok) setError(r.error ?? 'Revoke failed');
    else void load();
  }

  async function revokeAll(): Promise<void> {
    if (!account) return;
    if (!window.confirm('Revoke ALL sessions for this user, including this test session?')) return;
    const r = await apiFetch(`${base}/sessions/revoke-all`, {
      method: 'POST',
      body: {},
      token: account.accessToken,
    });
    if (!r.ok) setError(r.error ?? 'Revoke-all failed');
    else {
      setAccount(null);
      setSessions(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <TestSignIn base={base} account={account} setAccount={setAccount} context="List this user's active sessions and revoke any of them." />
      {account ? (
        <div className="card">
          <div className="section-head split">
            <div>
              <h2 style={{ fontSize: 15 }}>{sessions === null ? 'Sessions' : `Sessions · ${sessions.length}`}</h2>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>Refresh</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revokeAll()}>Revoke all</button>
            </div>
          </div>
          {error ? <ErrorState message={error} /> : null}
          {sessions === null ? (
            <LoadingSkeleton label="Loading sessions" rows={2} />
          ) : sessions.length === 0 ? (
            <EmptyState title="No other sessions" hint="Only this test session is active." />
          ) : (
            <ul className="health-list">
              {sessions.map(s => (
                <li key={s.id} className="health-row">
                  <span className="grow">
                    <span className="name"><code>{s.id.slice(0, 8)}…</code></span>
                    <div className="detail">
                      last active {timeAgo(s.lastActiveAt)} · expires {timeAgo(s.expiresAt)}
                      {s.ipAddress ? ` · ${s.ipAddress}` : ''}
                    </div>
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => void revoke(s.id)}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── Security ─────────────────────────────────────────────────── */

function AuthSecurity({
  base,
  origins,
  setOrigins,
  users,
}: {
  base: string;
  origins: string[];
  setOrigins: (o: string[]) => void;
  users: CustomerUser[];
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unverified = users.filter(u => !u.isAnonymous && !u.emailVerified).length;

  useEffect(() => {
    setDraft(origins.join(', '));
  }, [origins]);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const allowedOrigins = draft.split(',').map(s => s.trim()).filter(Boolean);
    const r = await apiFetch<{ config: { allowedOrigins: unknown } }>(`${base}/config`, {
      method: 'PATCH',
      body: { allowedOrigins },
    });
    if (!r.ok) setError(r.error ?? 'Save failed');
    else {
      const raw = r.data?.config.allowedOrigins;
      setOrigins(
        Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === 'string')
          : allowedOrigins,
      );
      setNotice('Browser origins updated.');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>{unverified === 0 ? 'All accounts verified' : `${unverified} account(s) unverified`}</h2>
          <p>Gate sensitive actions on verification status in your app. Resend verification from Sign-in methods.</p>
        </div>
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Allowed origins</h2>
          <p>Which websites may call this project&apos;s auth from a browser. Empty inherits the global policy. Wildcards are rejected.</p>
        </div>
        <form onSubmit={e => void save(e)}>
          <div className="field">
            <label htmlFor="auth-origins">Origins (comma-separated)</label>
            <input id="auth-origins" value={draft} onChange={e => setDraft(e.target.value)} placeholder="https://app.example.com, https://admin.example.com" autoComplete="off" />
          </div>
          <button type="submit" className="btn btn-sm btn-primary">Save origins</button>
        </form>
        {notice ? <p role="status" style={{ fontSize: 13 }}>{notice}</p> : null}
        {error ? <ErrorState message={error} /> : null}
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Short-lived access, rotating refresh</h2>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Access tokens expire after 15 minutes; refresh tokens rotate on every use and last 30
          days. Reusing a refresh token invalidates the whole session family. All auth attempts
          are rate-limited.
        </p>
      </div>
    </div>
  );
}
