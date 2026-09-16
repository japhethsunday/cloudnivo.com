'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiBase, apiFetch, apiFetchRaw } from '../lib/api';
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

function RequestTester({
  projectId,
  tables,
}: {
  projectId: string;
  tables: string[];
}): React.JSX.Element {
  const [table, setTable] = useState('');
  const [limit, setLimit] = useState('20');
  const [order, setOrder] = useState('');
  const [out, setOut] = useState<{ status: number; ms: number; body: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!table && tables[0]) setTable(tables[0]);
  }, [tables, table]);

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!table) return;
    setBusy(true);
    setError(null);
    const q = new URLSearchParams();
    if (limit.trim()) q.set('limit', limit.trim());
    if (order.trim()) q.set('order', order.trim());
    const started = Date.now();
    const r = await apiFetch<unknown>(
      `/api/v1/projects/${projectId}/${encodeURIComponent(table)}?${q.toString()}`,
    );
    setBusy(false);
    if (!r.ok) {
      setOut(null);
      setError(r.error ?? 'Request failed');
      return;
    }
    setOut({ status: r.status, ms: Date.now() - started, body: r.data });
  }

  return (
    <div className="card" id="request">
      <div className="section-head">
        <h2>Try it — live request</h2>
        <p>
          Run a real read against your API with your session. Filtering, ordering and pagination
          included.
        </p>
      </div>
      {tables.length === 0 ? (
        <EmptyState
          title="No tables yet"
          hint="Create a table first — then test the endpoint it generates."
        />
      ) : (
        <form onSubmit={e => void run(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={table} onChange={e => setTable(e.target.value)} aria-label="Table">
            {tables.map(t => (
              <option key={t} value={t}>
                GET /{t}
              </option>
            ))}
          </select>
          <input
            value={limit}
            onChange={e => setLimit(e.target.value)}
            placeholder="limit"
            aria-label="Limit"
            inputMode="numeric"
            style={{ width: 90 }}
          />
          <input
            value={order}
            onChange={e => setOrder(e.target.value)}
            placeholder="order, e.g. created_at.desc"
            aria-label="Order"
            style={{ flex: '2 1 180px' }}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !table}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
      {error ? <ErrorState message={error} /> : null}
      {out ? (
        <div style={{ marginTop: 8 }}>
          <p className="muted" style={{ fontSize: 12 }}>
            HTTP {out.status} · {out.ms} ms
          </p>
          <pre className="codeblock" style={{ maxHeight: 320 }}>
            {JSON.stringify(out.body, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
function curlFor(base: string, projectId: string, table: string, keyPrefix: string): string {
  return `curl -H "apikey: ${keyPrefix}…" "${base}/api/v1/projects/${projectId}/${table}?limit=20"`;
}

export function ApiPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = apiBase();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
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
    // openapi.json is served as a raw OpenAPI document, not inside the
    // platform `{ data }` envelope: reading it through apiFetch always came
    // back undefined, so this card sat on a loading skeleton forever.
    try {
      const res = await apiFetchRaw(`/api/v1/projects/${projectId}/openapi.json`);
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        setDoc(json && typeof json === 'object' ? json : null);
        setDocError(null);
      } else {
        setDocError(`Could not load the OpenAPI document (HTTP ${res.status}).`);
      }
    } catch {
      setDocError('Could not load the OpenAPI document.');
    }
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
        <h2>API base URL</h2>
        <p>
          <code style={{ wordBreak: 'break-all' }}>{`${base}/api/v1/projects/${projectId}`}</code>
        </p>
        <p className="muted">
          Stable per project. Authenticate with a session JWT or an <code>apikey</code> header.
          Public keys are read-only — keep service keys server-side.
        </p>
      </div>

      <div className="card" id="keys" style={{ scrollMarginTop: 16 }}>
        <h2>API keys</h2>
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

      <div className="card" id="endpoints">
        <h2>Endpoints</h2>
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

      <RequestTester projectId={projectId} tables={tables} />

      <div className="card" id="openapi">
        <h2>OpenAPI documentation</h2>
        <p className="muted">Generated live from your database schema — never stale.</p>
        {docError ? (
          <ErrorState message={docError} retry={() => void load()} />
        ) : !doc ? (
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
