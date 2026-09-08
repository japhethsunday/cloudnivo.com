'use client';

import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { ErrorState } from './States';

interface Org {
  id: string;
  name: string;
  slug: string;
}

export function TokenBar({ onChange }: { onChange: () => void }): React.JSX.Element {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <label htmlFor="cn-token" style={{ fontWeight: 700 }}>
        API token (dev session JWT)
      </label>
      <p className="muted" style={{ margin: '4px 0 8px' }}>
        Paste a Bearer token. Stored only in this browser — never in source code.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="cn-token"
          type="password"
          className="btn"
          style={{ flex: 1, textAlign: 'left', fontWeight: 400 }}
          placeholder="Bearer token…"
          value={value}
          onChange={e => setValue(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            window.localStorage.setItem('cn_token', value.trim());
            setSaved(true);
            onChange();
          }}
        >
          Save
        </button>
      </div>
      {saved ? <p className="muted">Token saved for this browser.</p> : null}
    </div>
  );
}

export function CreateProjectForm({
  orgs,
  onCreated,
}: {
  orgs: Org[];
  onCreated: (projectId: string, jobId: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [region, setRegion] = useState('local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ project: { id: string }; jobId: string }>('/api/v1/projects', {
      method: 'POST',
      body: {
        name,
        slug,
        organizationId: orgId,
        region,
        ...(password ? { password } : {}),
      },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Creation failed');
      return;
    }
    onCreated(res.data.project.id, res.data.jobId);
  }

  if (orgs.length === 0) {
    return (
      <ErrorState message="Create an organization first (POST /api/v1/organizations), then create projects inside it." />
    );
  }

  return (
    <form onSubmit={submit} className="card" aria-label="Create project">
      <h2 style={{ marginTop: 0 }}>Create project</h2>
      <div style={{ display: 'grid', gap: 8 }}>
        <label>
          Project name
          <input value={name} onChange={e => setName(e.target.value)} required minLength={2} />
        </label>
        <label>
          Project slug
          <input
            value={slug}
            onChange={e => setSlug(e.target.value)}
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          />
        </label>
        <label>
          Organization
          <select value={orgId} onChange={e => setOrgId(e.target.value)}>
            {orgs.map(o => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.slug})
              </option>
            ))}
          </select>
        </label>
        <label>
          Region
          <input value={region} onChange={e => setRegion(e.target.value)} required />
        </label>
        <label>
          Database password (optional — generated when empty, min 12 chars)
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {error ? <ErrorState message={error} /> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create project + provision database'}
        </button>
      </div>
    </form>
  );
}
