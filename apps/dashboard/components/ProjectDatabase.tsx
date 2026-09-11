'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { StatusDot, statusTone } from './ui';

interface DbRecord {
  status: string;
  version: string;
  host: string;
  port: number;
  dbName: string;
  dbUser: string;
  createdAt: string;
}

interface TableInfo {
  schema: string;
  name: string;
  columns: { name: string; dataType: string; nullable: boolean; defaultValue: string | null }[];
  primaryKeys: string[];
}

export function ProjectDatabase({
  projectId,
  mode = 'full',
}: {
  projectId: string;
  mode?: 'full' | 'query';
}): React.JSX.Element {
  const [db, setDb] = useState<DbRecord | null>(null);
  const [health, setHealth] = useState('unknown');
  const [conn, setConn] = useState<Record<string, unknown> | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [schema, setSchema] = useState<{ tables: TableInfo[] } | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [sql, setSql] = useState('select 1;');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await apiFetch<{ database: DbRecord | null; health: string }>(
      `/api/v1/projects/${projectId}/database`,
    );
    if (r.ok && r.data) {
      setDb(r.data.database);
      setHealth(r.data.health);
      setError(null);
    } else if (r.status === 404) {
      setDb(null);
    } else {
      setError(r.error);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function reveal(): Promise<void> {
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/connection?reveal=true`);
    if (r.ok) {
      setConn(r.data as Record<string, unknown>);
      setRevealed(true);
    } else setError(r.error);
  }

  async function loadMasked(): Promise<void> {
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/connection`);
    if (r.ok) {
      setConn(r.data as Record<string, unknown>);
      setRevealed(false);
    } else setError(r.error);
  }

  async function action(a: 'start' | 'stop' | 'restart'): Promise<void> {
    setBusy(a);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/actions`, {
      method: 'POST',
      body: { action: a },
    });
    setBusy(null);
    if (!r.ok) setError(r.error);
    else void load();
  }

  async function loadSchema(): Promise<void> {
    const r = await apiFetch<{ tables: TableInfo[] }>(
      `/api/v1/projects/${projectId}/database/schema`,
    );
    if (r.ok && r.data) setSchema(r.data);
    else setError(r.error);
  }

  async function loadMetrics(): Promise<void> {
    const r = await apiFetch<Record<string, unknown>>(
      `/api/v1/projects/${projectId}/database/metrics`,
    );
    if (r.ok && r.data) setMetrics(r.data);
    else setError(r.error);
  }

  async function runSql(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('sql');
    const started = Date.now();
    const r = await apiFetch<Record<string, unknown>>(
      `/api/v1/projects/${projectId}/database/query`,
      { method: 'POST', body: { sql } },
    );
    setBusy(null);
    if (r.ok) setResult({ ...(r.data ?? {}), clientMs: Date.now() - started });
    else {
      setResult(null);
      setError(r.error);
    }
  }

  if (mode === 'query')
    return (
      <QueryCard
        sql={sql}
        setSql={setSql}
        result={result}
        error={error}
        busy={busy}
        onRun={runSql}
        onClear={() => {
          setResult(null);
          setError(null);
        }}
      />
    );
  if (error && !db) return <ErrorState message={error} />;
  if (!db) return <LoadingSkeleton label="Loading database" />;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Database</h2>
        <p>
          <span role="status" aria-label={`Database ${db.status}, ${health}`}>
            <StatusDot tone={health === 'healthy' ? statusTone(db.status) : statusTone(health)} />{' '}
            {db.status} ({health})
          </span>
        </p>
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">Engine</th>
              <td>PostgreSQL {db.version}</td>
            </tr>
            <tr>
              <th scope="row">Host</th>
              <td>
                <code>{db.host}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Port</th>
              <td>
                <code>{db.port}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Database</th>
              <td>
                <code>{db.dbName}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">User</th>
              <td>
                <code>{db.dbUser}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Created</th>
              <td>{new Date(db.createdAt).toLocaleString()}</td>
            </tr>
            {metrics ? (
              <tr>
                <th scope="row">Size / connections</th>
                <td>
                  {String(metrics['sizeBytes'])} bytes · {String(metrics['connectionCount'])} conns
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void action('start')}
          >
            Start
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void action('stop')}
          >
            Stop
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void action('restart')}
          >
            Restart
          </button>
          <button type="button" className="btn" onClick={() => void loadMetrics()}>
            Refresh metrics
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Connection information</h2>
        {!conn ? (
          <button type="button" className="btn" onClick={() => void loadMasked()}>
            Show connection (masked)
          </button>
        ) : (
          <>
            <table className="table">
              <tbody>
                {Object.entries(conn).map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row">{k}</th>
                    <td>
                      <code style={{ wordBreak: 'break-all' }}>{String(v)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!revealed ? (
              <button type="button" className="btn" onClick={() => void reveal()}>
                Reveal secrets (logged)
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Tables</h2>
        {!schema ? (
          <button type="button" className="btn" onClick={() => void loadSchema()}>
            Inspect schema
          </button>
        ) : schema.tables.length === 0 ? (
          <EmptyState title="No tables yet" hint="Run CREATE TABLE in the SQL editor below." />
        ) : (
          schema.tables.map(t => (
            <details key={`${t.schema}.${t.name}`} style={{ marginBottom: 8 }}>
              <summary>
                <code>
                  {t.schema}.{t.name}
                </code>{' '}
                ({t.columns.length} columns)
              </summary>
              <table className="table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {t.columns.map(c => (
                    <tr key={c.name}>
                      <td>
                        <code>{c.name}</code>
                        {t.primaryKeys.includes(c.name) ? ' (PK)' : ''}
                      </td>
                      <td>
                        <code>{c.dataType}</code>
                      </td>
                      <td>{c.nullable ? 'yes' : 'no'}</td>
                      <td>
                        <code>{c.defaultValue ?? '—'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))
        )}
      </div>

      <QueryCard sql={sql} setSql={setSql} result={result} error={error} busy={busy} onRun={runSql} onClear={() => { setResult(null); setError(null); }} />
    </div>
  );
}

function QueryCard({
  sql,
  setSql,
  result,
  error,
  busy,
  onRun,
  onClear,
}: {
  sql: string;
  setSql: (v: string) => void;
  result: Record<string, unknown> | null;
  error: string | null;
  busy: string | null;
  onRun: (e: React.FormEvent) => void;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2>SQL editor</h2>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          <kbd>⌘</kbd> + <kbd>↵</kbd> to run
        </span>
      </div>
      <form
        onSubmit={e => void onRun(e)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void onRun(e);
          }
        }}
      >
        <div className="field">
          <label htmlFor="sql-input">SQL (single statement, 15s limit, 500 rows)</label>
          <textarea
            id="sql-input"
            className="sql-editor"
            rows={8}
            value={sql}
            onChange={e => setSql(e.target.value)}
            placeholder="SELECT * FROM users LIMIT 20;"
            spellCheck={false}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={busy === 'sql'}>
            {busy === 'sql' ? 'Running…' : '▶ Run query'}
          </button>
          <button type="button" className="btn" onClick={onClear}>
            Clear results
          </button>
        </div>
      </form>
      {busy === 'sql' ? <LoadingSkeleton label="Running query" rows={2} /> : null}
      {result ? (
        <pre className="codeblock" style={{ marginTop: 12, maxHeight: 420 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
      {error ? <ErrorState message={error} /> : null}
    </div>
  );
}
