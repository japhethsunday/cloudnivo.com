'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { sessionExpiresAt } from '../../lib/session-info';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, useToast } from '../../components/ui';

interface ProjectKey { id: string }

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'agents', label: 'Agent access' },
  { id: 'api-access', label: 'API access' },
  { id: 'organizations', label: 'Organizations' },
];

export default function AccountPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AccountBody />
    </RequireAuth>
  );
}

function AccountBody(): React.JSX.Element {
  const { user, orgs, token, logout, refresh } = useSession();
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
          <p className="sub muted">Profile, security, API access, and memberships.</p>
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
          {active === 'organizations' ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Organization memberships</h2>
              {orgs.length === 0 ? (
                <EmptyState
                  title="No memberships"
                  hint="Create or join an organization to get started."
                  action={
                    <Link className="btn btn-primary" href="/organizations">
                      Go to organizations
                    </Link>
                  }
                />
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgs.map(o => (
                        <tr key={o.id}>
                          <td>
                            {o.name}
                            <div className="muted" style={{ fontSize: 12 }}>
                              {o.slug}
                            </div>
                          </td>
                          <td>
                            <Badge tone={o.role === 'owner' ? 'info' : 'muted'}>{o.role}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
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
        {error ? <ErrorState message={error} /> : null}
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
          {error ? <ErrorState message={error} /> : null}
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
