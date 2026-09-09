'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

interface AuthUser {
  id: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  status: string;
  role: string;
  userMetadata: Record<string, unknown>;
  createdAt: string;
  lastSignInAt: string | null;
}

export function AuthPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/auth`;
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [origins, setOrigins] = useState('');
  const [savedOrigins, setSavedOrigins] = useState<string[]>([]);
  const [email, setEmail] = useState<{ driver: string; queued: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [u, c, e] = await Promise.all([
      apiFetch<{ users: AuthUser[] }>(`${base}/admin/users`),
      apiFetch<{ config: { allowedOrigins: string[] } }>(`${base}/config`),
      apiFetch<{ driver: string; queued: number }>(`${base}/email/status`),
    ]);
    if (!u.ok) setError(u.error);
    else {
      setUsers(u.data?.users ?? []);
      setError(null);
    }
    if (c.ok && c.data) {
      setSavedOrigins(c.data.config.allowedOrigins);
      setOrigins(c.data.config.allowedOrigins.join(', '));
    }
    if (e.ok && e.data) setEmail(e.data);
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
    setError(null);
    setNotice(null);
    const r = await apiFetch(`${base}/admin/users`, {
      method: 'PATCH',
      body: { id, status },
    });
    if (!r.ok) setError(r.error);
    else {
      setNotice(`User ${status}.`);
      void load();
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Delete this user and revoke all their sessions?')) return;
    const r = await apiFetch(`${base}/admin/users`, { method: 'DELETE', body: { id } });
    if (!r.ok) setError(r.error);
    else {
      setNotice('User deleted.');
      void load();
    }
  }

  async function saveOrigins(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const allowedOrigins = origins
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const r = await apiFetch(`${base}/config`, { method: 'PATCH', body: { allowedOrigins } });
    if (!r.ok) setError(r.error);
    else {
      setNotice('CORS origins saved.');
      void load();
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Overview</h2>
        <p className="muted">
          Email/password auth isolated to this project. Access tokens live 15 minutes; refresh
          tokens rotate with reuse detection. Email driver: <code>{email?.driver ?? '…'}</code>
          {email && !email.queued
            ? ''
            : ` (${email?.queued ?? 0} queued locally — dev inbox, not delivered)`}
        </p>
        <p className="muted">
          Customer endpoints live under <code>{base}</code> — signup, token, refresh, logout, user,
          password reset, verification, sessions. Full reference in{' '}
          <code>docs/authentication.md</code>.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Users</h2>
        {!users ? (
          <LoadingSkeleton label="Loading users" />
        ) : users.length === 0 ? (
          <EmptyState
            title="No users yet"
            hint="Users appear here after signing up through your app."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Verified</th>
                <th>Status</th>
                <th>Role</th>
                <th>Created</th>
                <th>Last sign-in</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>
                    <code>{u.email}</code>
                    <br />
                    <span className="muted">{u.id}</span>
                  </td>
                  <td>{u.emailVerified ? 'yes' : 'no'}</td>
                  <td>{u.status}</td>
                  <td>{u.role}</td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>{u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : 'never'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {u.status === 'active' ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void setStatus(u.id, 'disabled')}
                        >
                          Disable
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void setStatus(u.id, 'active')}
                        >
                          Enable
                        </button>
                      )}
                      <button type="button" className="btn" onClick={() => void remove(u.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <ErrorState message={error} /> : null}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Security settings</h2>
        <form onSubmit={e => void saveOrigins(e)}>
          <label htmlFor="cors-origins">
            Allowed browser origins (project CORS allowlist; empty inherits global)
          </label>
          <input
            id="cors-origins"
            style={{ width: '100%' }}
            value={origins}
            onChange={e => setOrigins(e.target.value)}
            placeholder="https://app.example.com, https://admin.example.com"
          />
          <p className="muted">
            Current: {savedOrigins.length > 0 ? savedOrigins.join(', ') : '(global CORS_ORIGINS)'}.{' '}
            Wildcards are rejected — credentials never pair with <code>*</code>.
          </p>
          <button type="submit" className="btn btn-primary">
            Save origins
          </button>
        </form>
      </div>
    </div>
  );
}
