'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiBase, apiFetch } from '../../lib/api';
import { sessionExpiresAt } from '../../lib/session-info';
import { useSession } from '../../components/SessionProvider';
import { useTheme } from '../../components/ThemeProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState } from '../../components/States';
import { Badge } from '../../components/ui';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'developer', label: 'Developer' },
  { id: 'security', label: 'Security' },
  { id: 'workspace', label: 'Workspace' },
];

export default function SettingsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <SettingsBody />
    </RequireAuth>
  );
}

function SettingsBody(): React.JSX.Element {
  const [tab, setTab] = useState('general');
  return (
    <section aria-labelledby="settings-title">
      <div className="page-head">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p className="sub muted">Workspace preferences and environment information.</p>
        </div>
      </div>
      <div className="account-grid">
        <nav className="account-nav" aria-label="Settings sections">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              aria-current={tab === t.id ? 'true' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="account-body">
          {tab === 'general' ? <GeneralTab /> : null}
          {tab === 'appearance' ? <AppearanceTab /> : null}
          {tab === 'developer' ? <DeveloperTab /> : null}
          {tab === 'security' ? <SecurityTab /> : null}
          {tab === 'workspace' ? <WorkspaceTab /> : null}
        </div>
      </div>
    </section>
  );
}

function GeneralTab(): React.JSX.Element {
  const { user, orgs } = useSession();
  const [projects, setProjects] = useState<{ id: string }[] | null>(null);
  const [health, setHealth] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      apiFetch<{ projects: { id: string }[] }>('/api/v1/projects'),
      apiFetch<{ status: string }>('/api/v1/health/ready'),
    ]).then(([p, h]) => {
      if (!live) return;
      if (p.ok && p.data) setProjects(p.data.projects);
      if (h.ok && h.data) setHealth(h.data.status);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>General</h2>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">Signed in as</th>
            <td>{user?.email ?? '—'}</td>
          </tr>
          <tr>
            <th scope="row">Organizations</th>
            <td>{orgs.length}</td>
          </tr>
          <tr>
            <th scope="row">Projects</th>
            <td>{projects === null ? '…' : projects.length}</td>
          </tr>
          <tr>
            <th scope="row">Control plane</th>
            <td>
              {health ? <Badge tone={health === 'ready' ? 'ok' : 'warn'}>{health}</Badge> : '…'}
            </td>
          </tr>
          <tr>
            <th scope="row">API base</th>
            <td>
              <code>{apiBase()}/api/v1</code>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AppearanceTab(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Appearance</h2>
      <div className="field" style={{ maxWidth: 280 }}>
        <label htmlFor="theme-select">Theme</label>
        <select
          id="theme-select"
          value={theme}
          onChange={e => setTheme(e.target.value as 'light' | 'dark' | 'system')}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <span className="hint">Applies instantly and is remembered in this browser.</span>
      </div>
    </div>
  );
}

function DeveloperTab(): React.JSX.Element {
  const [health, setHealth] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const base = apiBase();

  useEffect(() => {
    let live = true;
    void apiFetch<{ status: string }>('/api/v1/health/ready').then(r => {
      if (live && r.ok && r.data) setHealth(r.data.status);
    });
    return () => {
      live = false;
    };
  }, []);

  const snippet = `# List projects (replace $TOKEN with a project API key or session JWT)\ncurl -H "apikey: $TOKEN" "${base}/api/v1/projects/<project-id>/openapi.json"`;

  function copy(): void {
    void navigator.clipboard?.writeText(snippet).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Developer</h2>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">API base</th>
            <td>
              <code>{base}/api/v1</code>
            </td>
          </tr>
          <tr>
            <th scope="row">Health</th>
            <td>{health ? <Badge tone={health === 'ready' ? 'ok' : 'warn'}>{health}</Badge> : '…'}</td>
          </tr>
          <tr>
            <th scope="row">Envelope</th>
            <td>
              Success <code>{'{ data, meta }'}</code> · errors <code>{'{ error }'}</code>
            </td>
          </tr>
        </tbody>
      </table>
      <h3>Quick start</h3>
      <pre style={{ overflow: 'auto', background: 'var(--bg-muted)', padding: 12, borderRadius: 8 }}>{snippet}</pre>
      <button type="button" className="btn btn-sm" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy snippet'}
      </button>
      <p className="muted" style={{ fontSize: 13 }}>
        Quotas, CORS origins, and rate limits are enforced server-side and are not configurable from
        the dashboard.
      </p>
    </div>
  );
}

function SecurityTab(): React.JSX.Element {
  const { token } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const expiry = sessionExpiresAt(token);

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
        <h2 style={{ marginTop: 0 }}>Session</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Short-lived signed token in this browser only.
          {expiry ? ` Expires ${new Date(expiry).toLocaleString()}.` : ''}
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link href="/account">Manage full account security →</Link>
        </p>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="set-pw-current">Current password</label>
            <input
              id="set-pw-current"
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="set-pw-next">New password (min 12 characters)</label>
            <input
              id="set-pw-next"
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
              Password changed.
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}

function WorkspaceTab(): React.JSX.Element {
  const { orgs, refresh } = useSession();

  const reload = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Workspace</h2>
        <Link className="btn btn-sm btn-primary" href="/organizations">
          Manage
        </Link>
      </div>
      {orgs.length === 0 ? (
        <EmptyState
          title="No organizations"
          hint="Organizations own projects and billing."
          action={
            <Link className="btn btn-primary" href="/organizations">
              Create organization
            </Link>
          }
        />
      ) : (
        <div className="table-wrap" style={{ border: 0, marginTop: 12 }}>
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
  );
}
