'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedProject } from '../../lib/selection';
import { CAPABILITIES, CAPABILITY_CATEGORIES, resolveCapabilityHref } from '../../lib/capabilities';
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

/**
 * INTERNAL registry — not the product experience.
 * The 100 capabilities live in their real product areas
 * (Database, Auth, Storage, Realtime, Functions, AI, …).
 * This index exists only for tracking/testing coverage.
 */
function CapabilitiesBody(): React.JSX.Element {
  const [query, setQuery] = useState('');
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
    if (!q) return CAPABILITIES;
    return CAPABILITIES.filter(c =>
      `${c.title} ${c.body} ${c.category} ${c.id}`.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <section aria-labelledby="caps-title">
      <div className="page-head">
        <div>
          <h1 id="caps-title">Capability registry (internal)</h1>
          <p className="sub muted">
            This is <strong>not</strong> the product. Every capability below runs in its real
            product area — Database → Table Editor, Authentication → OTP, Storage → buckets,
            Realtime → channels, and so on. Use this table only to verify coverage during
            development and testing.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {projects.length > 1 ? (
            <select
              value={projectId ?? ''}
              onChange={e => setProjectId(e.target.value || null)}
              aria-label="Registry project context"
            >
              <option value="">No project context</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
          <Link className="btn btn-primary" href="/dashboard">
            Open workspace →
          </Link>
        </div>
      </div>

      <div className="toolbar" role="search">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter registry… (e.g. vault, branches, signed URLs)"
          aria-label="Filter capability registry"
          style={{ flex: '2 1 240px' }}
        />
        <span className="muted" style={{ fontSize: 14 }} aria-live="polite" data-testid="caps-count">
          {filtered.length} of {CAPABILITIES.length} tracked
        </span>
      </div>

      {CAPABILITY_CATEGORIES.map(cat => {
        const items = filtered.filter(c => c.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="card" style={{ marginBottom: 12 }}>
            <div className="section-head split">
              <div>
                <h2>
                  {cat} · {items.length}
                </h2>
              </div>
            </div>
            <table className="table" aria-label={`${cat} capability coverage`}>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Lives in</th>
                  <th>Backend proof</th>
                </tr>
              </thead>
              <tbody>
                {items.map(c => (
                  <tr key={c.id} data-testid={`cap-${c.id}`}>
                    <td>
                      <strong>{c.title}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.body}
                      </div>
                    </td>
                    <td>
                      <Link href={resolveCapabilityHref(c, projectId)}>Open →</Link>
                    </td>
                    <td>
                      <code className="muted" style={{ fontSize: 11 }} title={c.api}>
                        {c.api}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
