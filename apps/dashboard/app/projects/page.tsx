'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg } from '../../lib/selection';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, StatusDot, statusTone } from '../../components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
  database: { status: string; health?: string } | null;
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

export default function ProjectsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <ProjectsBody />
    </RequireAuth>
  );
}

function ProjectsBody(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, o] = await Promise.all([
      apiFetch<{ projects: Project[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
    ]);
    if (!p.ok) {
      setError(p.error ?? 'Could not load projects');
      setProjects([]);
    } else {
      setProjects(p.data?.projects ?? []);
    }
    if (o.ok && o.data) {
      setOrgs(o.data.organizations);
      const preferred = getSelectedOrg();
      if (preferred && o.data.organizations.some(x => x.id === preferred)) setFilter(preferred);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = filter ? (projects ?? []).filter(p => p.organizationId === filter) : (projects ?? []);

  return (
    <section aria-labelledby="projects-title">
      <div className="page-head">
        <div>
          <h1 id="projects-title">Projects</h1>
          <p className="sub muted">Each project gets an isolated PostgreSQL database.</p>
        </div>
        <Link className="btn btn-primary" href="/projects/new">
          New project
        </Link>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {!projects ? (
        <LoadingSkeleton label="Loading projects" />
      ) : projects.length === 0 ? (
        <EmptyState
          title={orgs.length === 0 ? 'Create an organization first' : 'No projects yet'}
          hint={
            orgs.length === 0
              ? 'Projects live inside organizations.'
              : 'Create a project to provision infrastructure automatically.'
          }
          action={
            <Link className="btn btn-primary" href={orgs.length === 0 ? '/organizations' : '/projects/new'}>
              {orgs.length === 0 ? 'Create organization' : 'Create project'}
            </Link>
          }
        />
      ) : (
        <>
          {orgs.length > 1 ? (
            <div className="field" style={{ maxWidth: 320 }}>
              <label htmlFor="project-org-filter">Organization</label>
              <select id="project-org-filter" value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="">All organizations</option>
                {orgs.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Database</th>
                    <th scope="col">Health</th>
                    <th scope="col">
                      <span className="mono">Region</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(p => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}`}>{p.name}</Link>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {p.slug}
                        </div>
                      </td>
                      <td>
                        {p.database ? (
                          <Badge tone={statusTone(p.database.status)}>{p.database.status}</Badge>
                        ) : (
                          <Badge tone="warn">provisioning</Badge>
                        )}
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <StatusDot tone={statusTone(p.database?.health ?? 'unknown')} />
                          {p.database?.health ?? '—'}
                        </span>
                      </td>
                      <td className="muted">{p.region}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="muted">No projects in this organization yet.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
