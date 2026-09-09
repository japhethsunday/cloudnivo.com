'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiBase, apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  role: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  requestCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

interface IssuedKey {
  key: ApiKey;
  raw: string;
}

function curlFor(base: string, projectId: string, table: string, keyPrefix: string): string {
  return `curl -H "apikey: ${keyPrefix}…" "${base}/api/v1/projects/${projectId}/${table}?limit=20"`;
}

export function ApiPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = apiBase();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [name, setName] = useState('client');
  const [role, setRole] = useState('public');
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [k, s] = await Promise.all([
      apiFetch<{ keys: ApiKey[] }>(`/api/v1/projects/${projectId}/keys`),
      apiFetch<{ tables: { name: string }[] }>(`/api/v1/projects/${projectId}/database/schema`),
    ]);
    if (!k.ok) setError(k.error);
    else setKeys(k.data?.keys ?? []);
    if (s.ok && s.data) setTables(s.data.tables.map(t => t.name));
    const d = await apiFetch<Record<string, unknown>>(`/api/v1/projects/${projectId}/openapi.json`);
    if (d.ok && d.data) setDoc(d.data);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createKey(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const r = await apiFetch<IssuedKey>(`/api/v1/projects/${projectId}/keys`, {
      method: 'POST',
      body: { name, role },
    });
    if (!r.ok || !r.data) setError(r.error ?? 'Key creation failed');
    else {
      setIssued(r.data);
      setName('client');
      void load();
    }
  }

  async function revoke(id: string): Promise<void> {
    const r = await apiFetch(`/api/v1/projects/${projectId}/keys/${id}/revoke`, {
      method: 'POST',
    });
    if (!r.ok) setError(r.error);
    else void load();
  }

  function copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  const paths = (doc?.['paths'] as Record<string, unknown> | undefined) ?? {};

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>API base URL</h2>
        <p>
          <code style={{ wordBreak: 'break-all' }}>{`${base}/api/v1/projects/${projectId}`}</code>
        </p>
        <p className="muted">
          Stable per project. Authenticate with a session JWT or an <code>apikey</code> header.
          Public keys are read-only — keep service keys server-side.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>API keys</h2>
        {issued ? (
          <div className="error-box" role="alert">
            <strong>Copy this secret now — it is never shown again.</strong>
            <p>
              <code style={{ wordBreak: 'break-all' }}>{issued.raw}</code>
            </p>
            <button type="button" className="btn" onClick={() => copy(issued.raw)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : null}
        {!keys ? (
          <LoadingSkeleton label="Loading keys" />
        ) : keys.length === 0 ? (
          <EmptyState
            title="No API keys"
            hint="Issue a public key for browsers or a service key for backends."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Role</th>
                <th>Usage</th>
                <th>Expires</th>
                <th>Status</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td>{k.role}</td>
                  <td>
                    {k.requestCount} req
                    {k.lastUsedAt ? ` · ${new Date(k.lastUsedAt).toLocaleString()}` : ''}
                  </td>
                  <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'never'}</td>
                  <td>{k.revokedAt ? 'revoked' : 'live'}</td>
                  <td>
                    {!k.revokedAt ? (
                      <button type="button" className="btn" onClick={() => void revoke(k.id)}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={e => void createKey(e)} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            aria-label="Key name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            minLength={1}
          />
          <select aria-label="Key role" value={role} onChange={e => setRole(e.target.value)}>
            <option value="public">public (read-only)</option>
            <option value="service">service (read + write)</option>
          </select>
          <button type="submit" className="btn btn-primary">
            Issue key
          </button>
        </form>
        {error ? <ErrorState message={error} /> : null}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Endpoints</h2>
        {tables.length === 0 ? (
          <EmptyState
            title="No tables discovered"
            hint="Create tables in the SQL editor — the API appears here automatically."
          />
        ) : (
          tables.map(t => (
            <details key={t} style={{ marginBottom: 8 }}>
              <summary>
                <code>
                  /{t} — GET · POST · /{t}/:id — GET · PATCH · DELETE
                </code>
              </summary>
              <pre style={{ overflow: 'auto', background: 'var(--bg-muted)', padding: 8 }}>
                {curlFor(base, projectId, t, keys?.[0]?.prefix ?? 'cn_…')}
              </pre>
              <button
                type="button"
                className="btn"
                onClick={() => copy(curlFor(base, projectId, t, 'YOUR_API_KEY'))}
              >
                Copy example
              </button>
            </details>
          ))
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>OpenAPI documentation</h2>
        <p className="muted">Generated live from your database schema — never stale.</p>
        {!doc ? (
          <LoadingSkeleton label="Loading OpenAPI" />
        ) : (
          <details>
            <summary>
              <code>openapi.json</code> ({Object.keys(paths).length} paths)
            </summary>
            <pre
              style={{
                overflow: 'auto',
                maxHeight: 360,
                background: 'var(--bg-muted)',
                padding: 8,
              }}
            >
              {JSON.stringify(doc, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
