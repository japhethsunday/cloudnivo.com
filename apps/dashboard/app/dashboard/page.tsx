'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useSession } from '../../components/SessionProvider';
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
  role?: string;
}

interface Health {
  status: string;
  components?: Record<string, boolean>;
}

export default function DashboardPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <DashboardBody />
    </RequireAuth>
  );
}

function DashboardBody(): React.JSX.Element {
  const { user } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, o, h] = await Promise.all([
      apiFetch<{ projects: Project[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
      apiFetch<Health>('/api/v1/health/ready'),
    ]);
    if (!p.ok) {
      setError(p.error ?? 'Could not load projects');
      setProjects([]);
    } else {
      setProjects(p.data?.projects ?? []);
    }
    if (o.ok && o.data) setOrgs(o.data.organizations);
    if (h.ok && h.data) setHealth(h.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = (projects ?? []).filter(p => p.database?.health === 'healthy').length;
  const provisioning = (projects ?? []).filter(
    p => !p.database || ['pending', 'retrying'].includes(p.database.status),
  ).length;

  return (
    <section aria-labelledby="dashboard-title">
      <div className="page-head">
        <div>
          <h1 id="dashboard-title">Good day{user?.displayName ? `, ${user.displayName}` : ''}</h1>
          <p className="sub muted">Live view of your organizations, projects, and infrastructure.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" href="/organizations">
            Manage organizations
          </Link>
          <Link className="btn btn-primary" href="/projects/new">
            New project
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {!projects ? (
        <LoadingSkeleton label="Loading dashboard" />
      ) : (
        <>
          <div className="stat-grid" role="list" aria-label="Resource totals">
            <div className="stat" role="listitem">
              <div className="k">Projects</div>
              <div className="v">{projects.length}</div>
              <div className="s">
                {running} healthy{provisioning > 0 ? ` · ${provisioning} provisioning` : ''}
              </div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Organizations</div>
              <div className="v">{orgs.length}</div>
              <div className="s">{orgs.length === 1 ? '1 membership' : `${orgs.length} memberships`}</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">System health</div>
              <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot tone={health?.status === 'ready' ? 'ok' : 'warn'} pulse={health?.status !== 'ready'} />
                <span style={{ fontSize: 18 }}>{health ? health.status : '…'}</span>
              </div>
              <div className="s">
                {health?.components
                  ? Object.entries(health.components)
                      .filter(([, v]) => v)
                      .length
                  : 0}{' '}
                components reporting
              </div>
            </div>
          </div>

          {projects.length === 0 ? (
            <EmptyState
              title={orgs.length === 0 ? 'Create your first organization' : 'Create your first project'}
              hint={
                orgs.length === 0
                  ? 'Organizations own projects and billing. It takes ten seconds.'
                  : 'Each project provisions an isolated PostgreSQL database automatically.'
              }
              action={
                <Link className="btn btn-primary" href={orgs.length === 0 ? '/organizations' : '/projects/new'}>
                  {orgs.length === 0 ? 'Create organization' : 'Create project'}
                </Link>
              }
            />
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Project</th>
                      <th scope="col">Database</th>
                      <th scope="col">Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.slice(0, 8).map(p => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/projects/${p.id}`}>{p.name}</Link>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {p.slug} · {p.region}
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {projects.length > 8 ? (
                <p className="muted" style={{ padding: '0 16px' }}>
                  <Link href="/projects">View all {projects.length} projects →</Link>
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
