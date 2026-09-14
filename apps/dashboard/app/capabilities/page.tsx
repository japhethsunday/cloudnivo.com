'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedProject } from '../../lib/selection';
import {
  CAPABILITIES,
  CAPABILITY_CATEGORIES,
  resolveCapabilityHref,
} from '../../lib/capabilities';
import { RequireAuth } from '../../components/RequireAuth';

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
}

export default function CapabilitiesPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <CapabilitiesBody />
    </RequireAuth>
  );
}

function CapabilitiesBody(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  useEffect(() => {
    setProjectId(getSelectedProject());
    void apiFetch<{ projects: ProjectLite[] }>('/api/v1/projects').then(r => {
      if (r.ok && r.data) {
        setProjects(r.data.projects);
        if (!getSelectedProject() && r.data.projects[0]) setProjectId(r.data.projects[0].id);
      }
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CAPABILITIES.filter(c => {
      if (category && c.category !== category) return false;
      if (!q) return true;
      return `${c.title} ${c.body} ${c.category} ${c.id}`.toLowerCase().includes(q);
    });
  }, [query, category]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof CAPABILITIES>();
    for (const c of filtered) {
      const list = map.get(c.category) ?? [];
      list.push(c);
      map.set(c.category, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <section aria-labelledby="caps-title">
      <div className="page-head">
        <div>
          <h1 id="caps-title">Capabilities · {CAPABILITIES.length}</h1>
          <p className="sub muted">
            The full CloudNivo surface — database, auth, storage, API, realtime, functions, AI,
            automation, observability, security, environments, billing and developer tools. Every
            entry links to the console where it runs.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {projects.length > 1 ? (
            <select
              value={projectId ?? ''}
              onChange={e => setProjectId(e.target.value || null)}
              aria-label="Capability project context"
            >
              <option value="">No project context</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
          <Link className="btn" href="/dashboard">
            Dashboard
          </Link>
        </div>
      </div>

      <div className="toolbar" role="search">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search 100 capabilities… (e.g. vault, branches, signed URLs)"
          aria-label="Search capabilities"
          style={{ flex: '2 1 240px' }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories ({CAPABILITIES.length})</option>
          {CAPABILITY_CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c} ({CAPABILITIES.filter(x => x.category === c).length})
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 14 }} aria-live="polite" data-testid="caps-count">
          {filtered.length} of {CAPABILITIES.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Nothing matches “{query.trim()}”. Try “vault”, “branches”, “webhook” or “MFA”.
          </p>
        </div>
      ) : (
        grouped.map(([cat, items]) => (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div className="section-head split">
              <div>
                <p className="eyebrow">{cat}</p>
                <h2>
                  {cat} · {items.length}
                </h2>
              </div>
            </div>
            <div className="ov-grid">
              {items.map(c => (
                <div key={c.id} className="card" data-testid={`cap-${c.id}`}>
                  <h3 style={{ marginTop: 0, fontSize: 15 }}>{c.title}</h3>
                  <p className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
                    {c.body}
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Link className="btn btn-sm btn-primary" href={resolveCapabilityHref(c, projectId)}>
                      Open in console →
                    </Link>
                    <code className="muted" style={{ fontSize: 11 }} title={c.api}>
                      {c.api}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
