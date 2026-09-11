'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { listAgentTokens, revokeAgentToken } from '../../lib/agents';
import { sessionExpiresAt } from '../../lib/session-info';
import { useSession } from '../../components/SessionProvider';
import { useTheme } from '../../components/ThemeProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { useToast } from '../../components/ui';

interface ProjectKey { id: string }

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'api-access', label: 'API access' },
  { id: 'agents', label: 'Agent access' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'danger', label: 'Danger zone' },
];

export default function AccountPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AccountBody />
    </RequireAuth>
  );
}

function AccountBody(): React.JSX.Element {
  const { user, token, logout, refresh } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [active, setActive] = useState('profile');
  const [keyCounts, setKeyCounts] = useState<{ projectId: string; projectName: string; count: number }[] | null>(null);

  const loadKeys = useCallback(async () => {
    const p = await apiFetch<{ projects: { id: string; name: string }[] }>('/api/v1/projects');
    if (!p.ok || !p.data) {
      setKeyCounts([]);
      return;
    }
    const rows = await Promise.all(
      p.data.projects.map(async proj => {
        const k = await apiFetch<{ keys: ProjectKey[] }>(`/api/v1/projects/${proj.id}/keys`);
        return {
          projectId: proj.id,
          projectName: proj.name,
          count: k.ok && k.data ? k.data.keys.filter(x => !(x as { revokedAt?: string | null }).revokedAt).length : 0,
        };
      }),
    );
    setKeyCounts(rows);
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  function doLogout(): void {
    logout();
    router.replace('/login');
  }

  const expiry = sessionExpiresAt(token);

  return (
    <section aria-labelledby="account-title">
      <div className="page-head">
        <div>
          <h1 id="account-title">Account</h1>
          <p className="sub muted">Profile, security, agent access, API access, appearance, and memberships.</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={doLogout}>
          Log out
        </button>
      </div>

      <div className="account-grid">
        <nav className="account-nav" aria-label="Account sections">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              type="button"
              className={active === s.id ? 'active' : ''}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => setActive(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="account-body">
          {active === 'profile' ? (
            <ProfileSection
              email={user?.email ?? ''}
              displayName={user?.displayName ?? null}
              userId={user?.id ?? ''}
              onSaved={() => {
                toast('Profile updated', 'ok');
                void refresh();
              }}
            />
          ) : null}
          {active === 'security' ? <SecuritySection expiry={expiry} /> : null}
          {active === 'agents' ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Agent access</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Dedicated <code>cn_agent_…</code> credentials for AI coding agents — scoped to
                organizations and projects, with expiry, instant revocation, and an optional
                approval gate for destructive operations.
              </p>
              <Link className="btn btn-primary" href="/agents">
                Open Agent access →
              </Link>
            </div>
          ) : null}
          {active === 'api-access' ? <ApiAccessSection keyCounts={keyCounts} /> : null}
          {active === 'appearance' ? <AppearanceSection /> : null}
          {active === 'notifications' ? <NotificationsSection email={user?.email ?? ''} /> : null}
          {active === 'sessions' ? <SessionsSection /> : null}
          {active === 'danger' ? <DangerSection /> : null}
        </div>
      </div>
    </section>
  );
}

function ProfileSection({
  email,
  displayName,
  userId,
  onSaved,
}: {
  email: string;
  displayName: string | null;
  userId: string;
  onSaved: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(displayName ?? '');
  }, [displayName]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiFetch('/api/v1/me', { method: 'PATCH', body: { displayName: name.trim() || null } });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Update failed');
      return;
    }
    onSaved();
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span className="avatar avatar-lg" aria-hidden>
          {(displayName || email).slice(0, 1)}
        </span>
        <div>
          <strong style={{ fontSize: 17 }}>{displayName || email}</strong>
          <div className="muted" style={{ fontSize: 13 }}>
            {email} · <code>{userId.slice(0, 8)}</code>
          </div>
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="profile-name">Display name</label>
          <input id="profile-name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Ada Lovelace" />
          <span className="hint">Shown across the dashboard. Clear it to fall back to your email.</span>
        </div>
        <div className="field">
          <label htmlFor="profile-email">Email</label>
          <input id="profile-email" value={email} disabled aria-describedby="email-note" />
          <span className="hint" id="email-note">Email identifies your account and cannot be changed here.</span>
        </div>
        {error ? <ErrorState title="Couldn't save profile" message={error} /> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </div>
  );
}

function SecuritySection({ expiry }: { expiry: string | null }): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    const r = await apiFetch('/api/v1/auth/password', {
      method: 'POST',
      body: { currentPassword: current, newPassword: next },
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Password change failed');
      return;
    }
    setCurrent('');
    setNext('');
    setDone(true);
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="pw-current">Current password</label>
            <input
              id="pw-current"
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pw-next">New password (min 12 characters)</label>
            <input
              id="pw-next"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={next}
              onChange={e => setNext(e.target.value)}
            />
          </div>
        {error ? <ErrorState title="Couldn't change password" message={error} /> : null}
          {done ? (
            <p role="status" className="flash-ok">
              Password changed. Use it next time you log in.
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Active session</h2>
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">Type</th>
              <td>
                Short-lived signed token, stored only in this browser.{' '}
                <span className="muted">Every request is authorized server-side.</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Expires</th>
              <td>{expiry ? new Date(expiry).toLocaleString() : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppearanceSection(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div className="card">
      <div className="section-head">
        <p className="eyebrow">Account</p>
        <h2>Appearance</h2>
        <p>Applies instantly and is remembered in this browser.</p>
      </div>
      <div className="field" style={{ maxWidth: 280, marginBottom: 0 }}>
        <label htmlFor="account-theme">Theme</label>
        <select
          id="account-theme"
          value={theme}
          onChange={e => setTheme(e.target.value as 'light' | 'dark' | 'system')}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </div>
  );
}

function NotificationsSection({ email }: { email: string }): React.JSX.Element {
  return (
    <div className="card">
      <div className="section-head">
        <p className="eyebrow">Account</p>
        <h2>Notifications</h2>
        <p>
          Security notices for this account go to <strong>{email || 'your account email'}</strong>. There are
          no marketing emails and no per-event toggles — operational signals live in the product, linked
          below.
        </p>
      </div>
      <ul className="health-list">
        <li className="health-row">
          <span className="grow">
            <span className="name">Workspace activity</span>
            <div className="detail">Provisioning, deploys, and job failures across projects.</div>
          </span>
          <Link className="value" href="/activity">
            Open feed →
          </Link>
        </li>
        <li className="health-row">
          <span className="grow">
            <span className="name">Agent denials &amp; approvals</span>
            <div className="detail">Blocked agent calls and pending destructive approvals.</div>
          </span>
          <Link className="value" href="/agents">
            Review →
          </Link>
        </li>
        <li className="health-row">
          <span className="grow">
            <span className="name">Quota &amp; billing</span>
            <div className="detail">Period usage, limits, invoices, and payments.</div>
          </span>
          <Link className="value" href="/billing">
            Open billing →
          </Link>
        </li>
      </ul>
    </div>
  );
}

function SessionsSection(): React.JSX.Element {
  const { token, logout } = useSession();
  const router = useRouter();
  const expiry = sessionExpiresAt(token);

  function doLogout(): void {
    logout();
    router.replace('/login');
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="section-head">
          <p className="eyebrow">Account</p>
          <h2>Sessions</h2>
          <p>Signed-in browsers holding a session token. Sessions are short-lived and verified server-side.</p>
        </div>
        <ul className="health-list">
          <li className="health-row">
            <span className="dot ok" aria-hidden />
            <span className="grow">
              <span className="name">This browser</span>
              <div className="detail">
                Current session{expiry ? ` · expires ${new Date(expiry).toLocaleString()}` : ' · expiry unknown'}
              </div>
            </span>
          </li>
        </ul>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={doLogout}>
            Log out this browser
          </button>
        </div>
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>Machine credentials</h2>
          <p>Long-lived access for agents and CI lives under Agent access — scoped, expiring, revocable.</p>
        </div>
        <Link className="btn" href="/agents">
          Review agent tokens
        </Link>
      </div>
    </div>
  );
}

function DangerSection(): React.JSX.Element {
  const { orgs } = useSession();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  async function revokeAll(): Promise<void> {
    if (confirm !== 'REVOKE' || busy) return;
    setBusy(true);
    let revoked = 0;
    try {
      for (const o of orgs) {
        const listed = await listAgentTokens(o.id);
        if (!listed.ok || !listed.tokens) continue;
        const live = listed.tokens.filter(t => !t.revokedAt);
        for (const t of live) {
          const r = await revokeAgentToken(o.id, t.id);
          if (r.ok) revoked += 1;
        }
      }
      setDone(revoked);
      setConfirm('');
      toast(`Revoked ${revoked} agent token${revoked === 1 ? '' : 's'}`, 'ok');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--danger)' }}>
      <div className="section-head">
        <p className="eyebrow">Account</p>
        <h2>Danger zone</h2>
        <p>
          Revoking agent tokens takes effect instantly across every plane — affected agents and CI jobs
          stop authenticating immediately. This cannot be undone.
        </p>
      </div>
      {done !== null ? (
        <p role="status" className="flash-ok">
          Revoked {done} token{done === 1 ? '' : 's'} across {orgs.length} organization
          {orgs.length === 1 ? '' : 's'}.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="revoke-confirm">
          Type <code>REVOKE</code> to revoke every live agent token you own
        </label>
        <input
          id="revoke-confirm"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          autoComplete="off"
          placeholder="REVOKE"
        />
      </div>
      <button type="button" className="btn btn-danger" disabled={busy || confirm !== 'REVOKE'} onClick={() => void revokeAll()}>
        {busy ? 'Revoking…' : 'Revoke all agent tokens'}
      </button>
    </div>
  );
}

function ApiAccessSection({
  keyCounts,
}: {
  keyCounts: { projectId: string; projectName: string; count: number }[] | null;
}): React.JSX.Element {
  if (!keyCounts) return <LoadingSkeleton label="Loading API access" />;
  const total = keyCounts.reduce((n, k) => n + k.count, 0);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>API access</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        CloudNivo keys are scoped to a single project — there are no account-wide secrets to leak.
        Create and revoke them on each project&apos;s API page.
      </p>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">Active keys</div>
          <div className="v">{total}</div>
          <div className="s">across {keyCounts.length} projects</div>
        </div>
      </div>
      {keyCounts.length === 0 ? (
        <EmptyState title="No projects yet" hint="Keys appear here once you have projects." />
      ) : (
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Active keys</th>
                <th scope="col">Manage</th>
              </tr>
            </thead>
            <tbody>
              {keyCounts.map(k => (
                <tr key={k.projectId}>
                  <td>{k.projectName}</td>
                  <td>{k.count}</td>
                  <td>
                    <Link href={`/projects/${k.projectId}/api`}>Open API &amp; keys →</Link>
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
