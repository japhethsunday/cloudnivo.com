'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

/* ── Visual Table Editor: real rows, filtering, editing, pagination ── */
export function TableEditor({ projectId }: { projectId: string }): React.JSX.Element {
  const [tables, setTables] = useState<{ name: string }[]>([]);
  const [table, setTable] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newRow, setNewRow] = useState('{}');
  const [editId, setEditId] = useState('');
  const [editBody, setEditBody] = useState('{}');

  const loadTables = useCallback(async () => {
    const r = await apiFetch<{ tables: { name: string }[] }>(
      `/api/v1/projects/${projectId}/database/schema`,
    );
    if (r.ok && r.data) {
      setTables(r.data.tables);
      if (!table && r.data.tables[0]) setTable(r.data.tables[0].name);
    } else setError(r.error ?? 'Could not load tables');
  }, [projectId, table]);

  const loadRows = useCallback(async () => {
    if (!table) return;
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const r = await apiFetch<{ data: Record<string, unknown>[]; meta?: { total?: number } }>(
      `/api/v1/projects/${projectId}/${encodeURIComponent(table)}?${q.toString()}`,
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Could not load rows');
      return;
    }
    setRows((r.data?.data as Record<string, unknown>[]) ?? []);
    const t = (r.data as { meta?: { total?: number } })?.meta?.total;
    setTotal(typeof t === 'number' ? t : null);
  }, [projectId, table, limit, offset]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);
  useEffect(() => {
    if (table) void loadRows();
  }, [table, loadRows]);

  const shown = filter.trim()
    ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(filter.trim().toLowerCase()))
    : rows;

  async function insert(): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(newRow);
    } catch {
      setError('New row must be valid JSON');
      return;
    }
    const r = await apiFetch(`/api/v1/projects/${projectId}/${encodeURIComponent(table)}`, {
      method: 'POST',
      body,
    });
    if (!r.ok) setError(r.error ?? 'Insert failed');
    else {
      setNewRow('{}');
      void loadRows();
    }
  }

  async function update(): Promise<void> {
    if (!editId) return;
    let body: unknown;
    try {
      body = JSON.parse(editBody);
    } catch {
      setError('Edit body must be valid JSON');
      return;
    }
    const r = await apiFetch(
      `/api/v1/projects/${projectId}/${encodeURIComponent(table)}/${encodeURIComponent(editId)}`,
      { method: 'PATCH', body },
    );
    if (!r.ok) setError(r.error ?? 'Update failed');
    else void loadRows();
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm(`Delete row ${id}?`)) return;
    const r = await apiFetch(
      `/api/v1/projects/${projectId}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) setError(r.error ?? 'Delete failed');
    else void loadRows();
  }

  function rowId(r: Record<string, unknown>): string {
    return String(r['id'] ?? r['uuid'] ?? JSON.stringify(r).slice(0, 24));
  }

  return (
    <div className="card" id="table-editor">
      <div className="section-head">
        <p className="eyebrow">Database · Table Editor</p>
        <h2 style={{ fontSize: 15 }}>Rows, filtering, editing, pagination</h2>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <select value={table} onChange={e => { setTable(e.target.value); setOffset(0); }} aria-label="Table">
          {tables.map(t => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter rows…" aria-label="Filter rows" style={{ flex: '1 1 160px' }} />
        <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setOffset(0); }} aria-label="Page size">
          {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}/page</option>)}
        </select>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void loadRows()}>Refresh</button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {busy ? <LoadingSkeleton label="Loading rows" rows={2} /> : shown.length === 0 ? (
        <EmptyState title="No rows" hint="Insert the first row below, or import CSV from the schema section." />
      ) : (
        <table className="table">
          <tbody>
            {shown.slice(0, 25).map((r, i) => (
              <tr key={i}>
                <td><code style={{ wordBreak: 'break-all' }}>{JSON.stringify(r)}</code></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(rowId(r))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - limit))}>← Prev</button>
        <span className="muted" style={{ fontSize: 12 }}>offset {offset}{total !== null ? ` · ${total} total` : ''}</span>
        <button type="button" className="btn btn-sm" onClick={() => setOffset(o => o + limit)}>Next →</button>
      </div>
      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="new-row">Insert row (JSON)</label>
          <input id="new-row" value={newRow} onChange={e => setNewRow(e.target.value)} placeholder='{"email":"a@x.com"}' />
        </div>
        <div><button type="button" className="btn btn-sm btn-primary" onClick={() => void insert()}>Insert row</button></div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="edit-id">Update row by id</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id="edit-id" value={editId} onChange={e => setEditId(e.target.value)} placeholder="row id" style={{ flex: '1 1 120px' }} />
            <input value={editBody} onChange={e => setEditBody(e.target.value)} placeholder='{"field":"value"}' aria-label="Update body" style={{ flex: '2 1 200px' }} />
            <button type="button" className="btn btn-sm" onClick={() => void update()}>Update</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Routines: functions, triggers, views ── */
export function RoutinesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<{ functions: unknown[]; triggers: unknown[]; views: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(): Promise<void> {
    setBusy(true);
    const r = await apiFetch<{ functions: unknown[]; triggers: unknown[]; views: unknown[] }>(
      `/api/v1/projects/${projectId}/database/routines`,
    );
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Could not load routines');
    else if (r.data) { setData(r.data); setError(null); }
  }
  return (
    <div className="card" id="routines">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Database · Routines</p>
          <h2 style={{ fontSize: 15 }}>Functions, triggers, views</h2>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Load routines'}</button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {data ? (
        <pre className="codeblock" style={{ maxHeight: 300 }}>{JSON.stringify(data, null, 2)}</pre>
      ) : <p className="muted" style={{ fontSize: 13 }}>PostgreSQL routines read live from pg_proc / pg_trigger.</p>}
    </div>
  );
}

/* ── Extensions ── */
export function ExtensionsPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<{ installed: string[]; allowlisted: string[] } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(): Promise<void> {
    setBusy(true);
    const r = await apiFetch<{ installed: string[]; allowlisted: string[] }>(
      `/api/v1/projects/${projectId}/database/extensions`,
    );
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Could not load extensions');
    else if (r.data) { setData(r.data); setError(null); }
  }
  async function install(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/extensions`, {
      method: 'POST',
      body: { name: name.trim() },
    });
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Install failed');
    else { setName(''); void load(); }
  }
  useEffect(() => { void load(); }, []);
  return (
    <div className="card" id="extensions">
      <div className="section-head">
        <p className="eyebrow">Database · Extensions</p>
        <h2 style={{ fontSize: 15 }}>Allowlisted extensions</h2>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {data ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Installed: {data.installed.length ? data.installed.join(', ') : 'none'}</p>
          <p className="muted" style={{ fontSize: 13 }}>Allowlist: {data.allowlisted.join(', ')}</p>
        </>
      ) : null}
      <form onSubmit={e => void install(e)} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="pgcrypto" aria-label="Extension name" />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>Install</button>
      </form>
    </div>
  );
}

/* ── RLS Policy Simulator ── */
export function RlsSimulator({ projectId }: { projectId: string }): React.JSX.Element {
  const [sql, setSql] = useState('SELECT * FROM users LIMIT 10;');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('authenticated');
  const [out, setOut] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/rls-simulate`, {
      method: 'POST',
      body: { sql, userId, role },
    });
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Simulation failed');
    else setOut(r.data ?? null);
  }
  return (
    <div className="card" id="rls">
      <div className="section-head">
        <p className="eyebrow">Database · Security / RLS</p>
        <h2 style={{ fontSize: 15 }}>Policy simulator</h2>
        <p>Tests row-level-security policies against this project&apos;s database as a real caller.</p>
      </div>
      <form onSubmit={e => void run(e)} style={{ display: 'grid', gap: 8 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="rls-sql">SQL to test</label>
          <textarea id="rls-sql" rows={3} value={sql} onChange={e => setSql(e.target.value)} className="sql-editor" />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={userId} onChange={e => setUserId(e.target.value)} placeholder="caller user UUID" aria-label="Caller user id" style={{ flex: '2 1 200px' }} />
          <select value={role} onChange={e => setRole(e.target.value)} aria-label="Caller role">
            {['authenticated', 'admin', 'service_role', 'anonymous'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{busy ? 'Testing…' : 'Test policy'}</button>
        </div>
      </form>
      {error ? <ErrorState message={error} /> : null}
      {out ? <pre className="codeblock" style={{ marginTop: 8, maxHeight: 300 }}>{JSON.stringify(out, null, 2)}</pre> : null}
    </div>
  );
}

/* ── Replicas ── */
export function ReplicasPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(): Promise<void> {
    setBusy(true);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/replication`);
    setBusy(false);
    if (!r.ok) setError(r.error ?? 'Could not load replication status');
    else { setData(r.data ?? null); setError(null); }
  }
  useEffect(() => { void load(); }, []);
  return (
    <div className="card" id="replicas">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Database · Replicas</p>
          <h2 style={{ fontSize: 15 }}>Replication status</h2>
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {data ? <pre className="codeblock" style={{ maxHeight: 240 }}>{JSON.stringify(data, null, 2)}</pre>
        : <p className="muted" style={{ fontSize: 13 }}>Single-node locally; managed replicas surface here in production.</p>}
    </div>
  );
}

/* ── Backups: diff + guarded restore + advisors ── */
export function BackupsPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [base, setBase] = useState('main');
  const [compare, setCompare] = useState('main');
  const [diff, setDiff] = useState<unknown>(null);
  const [restoreSql, setRestoreSql] = useState('-- paste migration SQL; CREATE ROLE is blocked\n');
  const [out, setOut] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ branches: { id: string; name: string }[] }>(
      `/api/v1/projects/${projectId}/database/branches`,
    ).then(r => { if (r.ok && r.data) setBranches(r.data.branches); });
  }, [projectId]);

  async function runDiff(): Promise<void> {
    setBusy('diff');
    setError(null);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/diff`, {
      method: 'POST',
      body: { base, compare, includeDrops: false },
    });
    setBusy(null);
    if (!r.ok) setError(r.error ?? 'Diff failed');
    else setDiff(r.data ?? null);
  }

  async function restore(): Promise<void> {
    if (!window.confirm('Run this SQL transactionally against the project database?')) return;
    setBusy('restore');
    setError(null);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/restore`, {
      method: 'POST',
      body: { sql: restoreSql },
    });
    setBusy(null);
    if (!r.ok) setError(r.error ?? 'Restore failed');
    else setOut(r.data ?? null);
  }

  return (
    <div className="card" id="backups">
      <div className="section-head">
        <p className="eyebrow">Database · Backups</p>
        <h2 style={{ fontSize: 15 }}>Diff, guarded restore, retention workflow</h2>
        <p>Preview base-vs-compare migrations with drops flagged; restores run transactionally.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <label>Base <select value={base} onChange={e => setBase(e.target.value)} aria-label="Diff base">
          <option value="main">main</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select></label>
        <label>Compare <select value={compare} onChange={e => setCompare(e.target.value)} aria-label="Diff compare">
          <option value="main">main</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select></label>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void runDiff()}>
          {busy === 'diff' ? 'Diffing…' : 'Preview diff'}
        </button>
      </div>
      {diff ? <pre className="codeblock" style={{ maxHeight: 260 }}>{JSON.stringify(diff, null, 2)}</pre> : null}
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="restore-sql">Guarded restore SQL</label>
        <textarea id="restore-sql" rows={5} value={restoreSql} onChange={e => setRestoreSql(e.target.value)} className="sql-editor" />
      </div>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void restore()}>
        {busy === 'restore' ? 'Restoring…' : 'Run guarded restore'}
      </button>
      {error ? <ErrorState message={error} /> : null}
      {out ? <pre className="codeblock" style={{ marginTop: 8, maxHeight: 240 }}>{JSON.stringify(out, null, 2)}</pre> : null}
    </div>
  );
}
