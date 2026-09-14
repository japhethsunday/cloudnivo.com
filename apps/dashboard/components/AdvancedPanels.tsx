'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { useToast } from './ui';

/* ── Database branches ─────────────────────────────────────────── */
export function BranchesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [branches, setBranches] = useState<{ id: string; name: string; status: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiFetch<{ branches: { id: string; name: string; status: string }[] }>(
      `/api/v1/projects/${projectId}/database/branches`,
    );
    if (!r.ok) {
      if (r.status === 404) setBranches([]);
      else setError(r.error);
      return;
    }
    setBranches(r.data?.branches ?? []);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/branches`, {
      method: 'POST',
      body: { name: name.trim() },
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setName('');
    toast('Branch created', 'ok');
    void load();
  }

  async function reset(id: string): Promise<void> {
    if (!window.confirm('Reset this branch to a fresh copy of main? Data in the branch is replaced.')) return;
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/branches/${id}/reset`, { method: 'POST', body: {} });
    if (!r.ok) setError(r.error);
    else {
      toast('Branch reset', 'ok');
      void load();
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Delete this branch database? This cannot be undone.')) return;
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/branches/${id}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error);
    else {
      toast('Branch deleted', 'ok');
      void load();
    }
  }

  if (branches === null && !error) return <LoadingSkeleton label="Loading branches" rows={2} />;
  return (
    <div className="card" id="branches">
      <div className="section-head">
        <p className="eyebrow">Environments</p>
        <h2 style={{ fontSize: 15 }}>Database branches</h2>
        <p>Full isolated copies of the project database for previews and experiments.</p>
      </div>
      {error ? <ErrorState title="Branches unavailable" message={error} retry={() => void load()} /> : null}
      {(branches ?? []).length === 0 ? (
        <EmptyState title="No branches yet" hint="Branch main to test migrations or preview features safely." />
      ) : (
        <ul className="health-list">
          {(branches ?? []).map(b => (
            <li key={b.id} className="health-row">
              <span className="grow">
                <span className="name">
                  <code>{b.name}</code>
                </span>
                <div className="detail">
                  {b.status} · <code>{b.id.slice(0, 8)}</code>
                </div>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void reset(b.id)}>
                Reset
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(b.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="feature-a"
          maxLength={100}
          aria-label="New branch name"
          style={{ flex: '1 1 160px' }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create branch'}
        </button>
      </form>
    </div>
  );
}

/* ── Project vault ─────────────────────────────────────────────── */
export function VaultPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [secrets, setSecrets] = useState<{ name: string; createdAt?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const load = useCallback(async () => {
    const r = await apiFetch<{ secrets: { name: string }[]; vault?: { name: string }[] }>(
      `/api/v1/projects/${projectId}/database/vault`,
    );
    if (!r.ok) {
      if (r.status === 404) setSecrets([]);
      else setError(r.error);
      return;
    }
    const list = (r.data?.secrets ?? r.data?.vault ?? []) as { name: string }[];
    setSecrets(list);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !value) return;
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/vault/${encodeURIComponent(name.trim())}`, {
      method: 'PUT',
      body: { value },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setName('');
    setValue('');
    toast('Secret stored — values are write-only', 'ok');
    void load();
  }

  async function reveal(secret: string): Promise<void> {
    const r = await apiFetch<{ value: string }>(
      `/api/v1/projects/${projectId}/database/vault/${encodeURIComponent(secret)}/reveal`,
      { method: 'POST', body: {} },
    );
    if (!r.ok || !r.data) {
      setError(r.error);
      return;
    }
    toast('Reveal logged to the audit trail', 'info');
    window.prompt(`Value of ${secret} (reveal audited):`, String((r.data as { value?: unknown }).value ?? ''));
    void load();
  }

  async function remove(secret: string): Promise<void> {
    if (!window.confirm(`Delete vault secret ${secret}?`)) return;
    const r = await apiFetch(`/api/v1/projects/${projectId}/database/vault/${encodeURIComponent(secret)}`, {
      method: 'DELETE',
    });
    if (!r.ok) setError(r.error);
    else {
      toast('Secret deleted', 'ok');
      void load();
    }
  }

  return (
    <div className="card" id="vault">
      <div className="section-head">
        <p className="eyebrow">Environments</p>
        <h2 style={{ fontSize: 15 }}>Project vault</h2>
        <p>AES-256-GCM envelopes. Names list freely — values reveal once and audit.</p>
      </div>
      {error ? <ErrorState title="Vault unavailable" message={error} retry={() => void load()} /> : null}
      {secrets === null ? (
        <LoadingSkeleton label="Loading vault" rows={2} />
      ) : secrets.length === 0 ? (
        <EmptyState title="Vault is empty" hint="Store API keys and third-party secrets outside function env." />
      ) : (
        <ul className="health-list">
          {secrets.map(s => (
            <li key={s.name} className="health-row">
              <span className="grow">
                <span className="name">
                  <code>{s.name}</code>
                </span>
                <div className="detail">write-only · reveal is audited</div>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void reveal(s.name)}>
                Reveal
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(s.name)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="STRIPE_KEY" aria-label="Secret name" style={{ flex: '1 1 140px' }} />
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="value" aria-label="Secret value" style={{ flex: '2 1 180px' }} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim() || !value}>
          Store
        </button>
      </form>
    </div>
  );
}

/* ── Database power tools ──────────────────────────────────────── */
export function DbToolsPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [advisors, setAdvisors] = useState<unknown>(null);
  const [extensions, setExtensions] = useState<{ installed?: string[]; allowed?: string[] } | null>(null);
  const [types, setTypes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(kind: 'advisors' | 'extensions' | 'types'): Promise<void> {
    setBusy(kind);
    setError(null);
    const path =
      kind === 'advisors'
        ? `/api/v1/projects/${projectId}/database/advisors`
        : kind === 'extensions'
          ? `/api/v1/projects/${projectId}/database/extensions`
          : `/api/v1/projects/${projectId}/database/types`;
    const r = await apiFetch(path);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (kind === 'advisors') setAdvisors(r.data);
    if (kind === 'extensions') setExtensions(r.data as { installed?: string[]; allowed?: string[] });
    if (kind === 'types') setTypes(JSON.stringify(r.data, null, 2));
  }

  return (
    <div className="card" id="db-tools">
      <div className="section-head">
        <p className="eyebrow">Environments</p>
        <h2 style={{ fontSize: 15 }}>Database power tools</h2>
        <p>Advisors, extensions and generated types — live against this project’s database.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('advisors')}>
          {busy === 'advisors' ? 'Scanning…' : 'Run advisors'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('extensions')}>
          {busy === 'extensions' ? 'Loading…' : 'List extensions'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('types')}>
          {busy === 'types' ? 'Generating…' : 'Generate types'}
        </button>
      </div>
      {error ? <ErrorState title="Tool failed" message={error} /> : null}
      {advisors ? (
        <pre className="codeblock" style={{ marginTop: 10, maxHeight: 260 }}>
          {JSON.stringify(advisors, null, 2)}
        </pre>
      ) : null}
      {extensions ? (
        <pre className="codeblock" style={{ marginTop: 10, maxHeight: 200 }}>
          {JSON.stringify(extensions, null, 2)}
        </pre>
      ) : null}
      {types ? (
        <pre className="codeblock" style={{ marginTop: 10, maxHeight: 260 }}>
          {types}
        </pre>
      ) : null}
    </div>
  );
}

/* ── Spend budgets (billing) ───────────────────────────────────── */
export function BudgetsPanel({ orgId }: { orgId: string }): React.JSX.Element {
  const toast = useToast();
  const [budgets, setBudgets] = useState<{ id: string; name: string; limitCents: number; action: string; breached?: boolean; percent?: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('5000');
  const [action, setAction] = useState('alert');

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await apiFetch<{ spendCents: number; period: string; evaluations: { budget: { id: string; name: string; limitCents: number; action: string }; spendCents: number; breached: boolean; percent: number }[] }>(
      `/api/v1/organizations/${orgId}/billing/budgets`,
    );
    if (!r.ok) {
      if (r.status === 404) setBudgets([]);
      else setError(r.error);
      return;
    }
    // Backend evaluates spend live: flatten evaluations into budget rows.
    setBudgets(
      (r.data?.evaluations ?? []).map(e => ({
        ...e.budget,
        breached: e.breached,
        percent: e.percent,
      })),
    );
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const r = await apiFetch(`/api/v1/organizations/${orgId}/billing/budgets`, {
      method: 'POST',
      body: { name: name.trim(), limitCents: Number(limit), action },
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setName('');
    toast(`Budget created — ${action} mode`, 'ok');
    void load();
  }

  async function remove(id: string): Promise<void> {
    const r = await apiFetch(`/api/v1/organizations/${orgId}/billing/budgets/${id}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error);
    else void load();
  }

  if (!orgId) return <></>;
  return (
    <div className="card" id="budgets">
      <div className="section-head">
        <p className="eyebrow">Billing</p>
        <h2>Spend budgets</h2>
        <p>Monthly caps that alert — or block paid writes with 402 when breached.</p>
      </div>
      {error ? <ErrorState title="Budgets unavailable" message={error} retry={() => void load()} /> : null}
      {budgets === null ? (
        <LoadingSkeleton label="Loading budgets" rows={2} />
      ) : budgets.length === 0 ? (
        <EmptyState title="No budgets yet" hint="Create one to cap monthly spend for this organization." />
      ) : (
        <ul className="health-list">
          {budgets.map(b => (
            <li key={b.id} className="health-row">
              <span className="grow">
                <span className="name">{b.name}</span>
                <div className="detail">
                  ${(b.limitCents / 100).toFixed(2)} · {b.action}
                  {typeof b.percent === 'number' ? ` · ${b.percent}% used` : ''}
                  {b.breached ? ' · breached' : ''}
                </div>
              </span>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(b.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Monthly cap" aria-label="Budget name" style={{ flex: '2 1 140px' }} />
        <input value={limit} onChange={e => setLimit(e.target.value)} placeholder="5000" inputMode="numeric" aria-label="Limit in cents" style={{ flex: '1 1 100px' }} />
        <select value={action} onChange={e => setAction(e.target.value)} aria-label="Budget action">
          <option value="alert">alert</option>
          <option value="block">block</option>
        </select>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
          Create
        </button>
      </form>
    </div>
  );
}

/* ── Org platform: domains, drains, status ─────────────────────── */
export function OrgPlatformPanel({ orgId }: { orgId: string }): React.JSX.Element {
  const toast = useToast();
  const [domains, setDomains] = useState<{ id: string; hostname: string; verified: boolean; purpose: string; status?: string; dnsRecord?: string }[] | null>(null);
  const [drains, setDrains] = useState<{ id: string; url: string; events: string[]; enabled: boolean }[] | null>(null);
  const [status, setStatus] = useState<{ status: string; incidents: { id: string; title: string; state: string }[] } | null>(null);
  const [hostname, setHostname] = useState('');
  const [drainUrl, setDrainUrl] = useState('');

  const load = useCallback(async () => {
    if (!orgId) return;
    const [d, dr, s] = await Promise.all([
      apiFetch<{ domains: { id: string; domain?: string; hostname?: string; verified?: boolean; verifiedAt?: string | null; status?: string; purpose: string; dnsRecord?: string }[] }>(
        `/api/v1/organizations/${orgId}/domains`,
      ),
      apiFetch<{ drains: { id: string; url: string; events: string[]; enabled: boolean }[] }>(
        `/api/v1/organizations/${orgId}/drains`,
      ),
      apiFetch<{ status: string; incidents: { id: string; title: string; state: string }[] }>('/api/v1/status'),
    ]);
    if (d.ok && d.data) {
      // Backend exposes `domain` + `status`/`verifiedAt`; normalize for display.
      setDomains(
        d.data.domains.map(x => ({
          id: x.id,
          hostname: x.hostname ?? x.domain ?? '',
          verified: x.verified ?? (x.status === 'verified' || x.verifiedAt != null),
          purpose: x.purpose,
          status: x.status,
          dnsRecord: x.dnsRecord,
        })),
      );
    } else setDomains(d.status === 404 ? [] : null);
    if (dr.ok && dr.data) setDrains(dr.data.drains);
    else setDrains(dr.status === 404 ? [] : null);
    if (s.ok && s.data) setStatus({ status: String((s.data as { status?: unknown }).status ?? 'ok'), incidents: ((s.data as { incidents?: unknown }).incidents ?? []) as { id: string; title: string; state: string }[] });
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addDomain(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!hostname.trim()) return;
    const r = await apiFetch(`/api/v1/organizations/${orgId}/domains`, {
      method: 'POST',
      body: { domain: hostname.trim().toLowerCase(), purpose: 'app' },
    });
    if (!r.ok) {
      toast(r.error ?? 'Domain create failed', 'bad');
      return;
    }
    setHostname('');
    toast('Domain added — verify over DNS TXT', 'ok');
    void load();
  }

  async function verifyDomain(id: string): Promise<void> {
    const r = await apiFetch(`/api/v1/organizations/${orgId}/domains/${id}/verify`, { method: 'POST', body: {} });
    if (!r.ok) toast(r.error ?? 'Verification failed — check DNS TXT', 'bad');
    else {
      toast('Domain verified', 'ok');
      void load();
    }
  }

  async function addDrain(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!drainUrl.trim()) return;
    const r = await apiFetch(`/api/v1/organizations/${orgId}/drains`, {
      method: 'POST',
      body: { url: drainUrl.trim(), events: ['audit'] },
    });
    if (!r.ok) {
      toast(r.error ?? 'Drain create failed', 'bad');
      return;
    }
    setDrainUrl('');
    toast('Log drain created — deliveries are HMAC-signed', 'ok');
    void load();
  }

  if (!orgId) return <></>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" id="domains">
        <div className="section-head">
          <p className="eyebrow">Environments</p>
          <h2 style={{ fontSize: 15 }}>Custom domains</h2>
          <p>DNS-verified hostnames for api, storage, functions or app surfaces.</p>
        </div>
        {domains === null ? (
          <LoadingSkeleton label="Loading domains" rows={2} />
        ) : domains.length === 0 ? (
          <EmptyState title="No custom domains" hint="Attach a hostname, then verify ownership over DNS TXT." />
        ) : (
          <ul className="health-list">
            {domains.map(d => (
              <li key={d.id} className="health-row">
                <span className="grow">
                  <span className="name">
                    <code>{d.hostname}</code>
                  </span>
                  <div className="detail">
                    {d.purpose} · {d.verified ? 'verified' : 'pending DNS verification'}
                    {!d.verified && d.dnsRecord ? (
                      <>
                        {' · TXT '}<code>{d.dnsRecord}</code>
                      </>
                    ) : null}
                  </div>
                </span>
                {!d.verified ? (
                  <button type="button" className="btn btn-sm" onClick={() => void verifyDomain(d.id)}>
                    Verify
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addDomain} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={hostname} onChange={e => setHostname(e.target.value)} placeholder="app.example.com" aria-label="Custom hostname" style={{ flex: 1 }} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!hostname.trim()}>
            Add
          </button>
        </form>
      </div>

      <div className="card" id="drains">
        <div className="section-head">
          <p className="eyebrow">Environments</p>
          <h2 style={{ fontSize: 15 }}>Log drains</h2>
          <p>Signed exports of audit, billing, auth and error events to your HTTPS endpoint.</p>
        </div>
        {drains === null ? (
          <LoadingSkeleton label="Loading drains" rows={2} />
        ) : drains.length === 0 ? (
          <EmptyState title="No log drains" hint="Ship signed event batches to an SSRF-guarded URL." />
        ) : (
          <ul className="health-list">
            {drains.map(d => (
              <li key={d.id} className="health-row">
                <span className="grow">
                  <span className="name">
                    <code>{d.url}</code>
                  </span>
                  <div className="detail">
                    {(d.events ?? []).join(', ')} · {d.enabled ? 'enabled' : 'disabled'}
                  </div>
                </span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addDrain} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={drainUrl} onChange={e => setDrainUrl(e.target.value)} placeholder="https://ops.example.com/hook" aria-label="Drain URL" style={{ flex: 1 }} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!drainUrl.trim()}>
            Add
          </button>
        </form>
      </div>

      <div className="card" id="platform-status">
        <div className="section-head">
          <p className="eyebrow">Observability</p>
          <h2 style={{ fontSize: 15 }}>Platform status</h2>
          <p>
            Public status{status ? `: ${status.status}` : ''} · {status?.incidents?.length ?? 0} tracked
            incidents.
          </p>
        </div>
        {(status?.incidents ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No open incidents reported on /api/v1/status.
          </p>
        ) : (
          <ul className="health-list">
            {(status?.incidents ?? []).slice(0, 5).map(i => (
              <li key={i.id} className="health-row">
                <span className="grow">
                  <span className="name">{i.title}</span>
                  <div className="detail">{i.state}</div>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
