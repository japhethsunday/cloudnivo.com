'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg } from '../../lib/selection';
import { formatMetric, prettifyKey, timeAgo } from '../../lib/format';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { ProjectCard, type ProjectCardData } from '../../components/ProjectCard';
import { Badge, StatusDot, statusTone } from '../../components/ui';

interface Org {
  id: string;
  name: string;
  slug: string;
}

interface Health {
  status: string;
  components?: Record<string, boolean>;
}

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
}

interface ActivityItem extends Job {
  projectId: string;
  projectName: string;
}

interface UsageSlice {
  service: string;
  metric: string;
  total: number;
}

interface Usage {
  period: string;
  planId: string;
  slices: UsageSlice[];
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
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageOrg, setUsageOrg] = useState<Org | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [p, o, h] = await Promise.all([
      apiFetch<{ projects: ProjectCardData[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
      apiFetch<Health>('/api/v1/health/ready'),
    ]);
    if (!p.ok) {
      setError(p.error ?? 'Could not load projects');
      setProjects([]);
    } else {
      const list = p.data?.projects ?? [];
      setProjects(list);
      // Recent activity: bounded fan-out over the newest project set.
      // Real provisioning/deploy jobs only — never synthesized.
      void loadActivity(list).then(setActivity);
    }
    if (o.ok && o.data) {
      const list = o.data.organizations;
      setOrgs(list);
      const preferred = getSelectedOrg();
      const scope = list.find(x => x.id === preferred) ?? list[0] ?? null;
      setUsageOrg(scope);
      if (scope) {
        void apiFetch<Usage>(`/api/v1/organizations/${scope.id}/billing/usage`).then(r => {
          if (r.ok && r.data) setUsage(r.data);
        });
      }
    }
    if (h.ok && h.data) setHealth(h.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = (projects ?? []).filter(p => p.database?.health === 'healthy').length;
  const degraded = (projects ?? []).filter(
    p => !p.database || ['pending', 'retrying', 'provisioning'].includes(p.database.status),
  ).length;
  const components = health?.components ? Object.entries(health.components) : [];
  const upCount = components.filter(([, v]) => v).length;
  const usageTop = (usage?.slices ?? [])
    .filter(s => s.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return (
    <section aria-labelledby="dashboard-title">
      <div className="page-head">
        <div>
          <h1 id="dashboard-title">Good day{user?.displayName ? `, ${user.displayName}` : ''}</h1>
          <p className="sub muted">Live command center for your organizations, projects, and infrastructure.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" href="/projects">
            All projects
          </Link>
          <Link className="btn btn-primary" href="/projects/new">
            New project
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} retry={() => void load()} /> : null}

      {!projects ? (
        <LoadingSkeleton label="Loading dashboard" rows={4} />
      ) : (
        <>
          <div className="stat-grid" role="list" aria-label="Resource totals">
            <div className="stat" role="listitem">
              <div className="k">Projects</div>
              <div className="v">{projects.length}</div>
              <div className="s">
                {running} healthy{degraded > 0 ? ` · ${degraded} provisioning` : ''}
              </div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Organizations</div>
              <div className="v">{orgs.length}</div>
              <div className="s">{orgs.length === 1 ? '1 membership' : `${orgs.length} memberships`}</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Control plane</div>
              <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot tone={health?.status === 'ready' ? 'ok' : 'warn'} pulse={health?.status !== 'ready'} />
                <span style={{ fontSize: 18 }}>{health ? health.status : '…'}</span>
              </div>
              <div className="s">{upCount} of {components.length} components reporting</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Recent activity</div>
              <div className="v">{activity === null ? '…' : activity.length}</div>
              <div className="s">
                {activity && activity.length > 0 ? (
                  <Link href="/activity">View feed →</Link>
                ) : (
                  'jobs appear as infrastructure runs'
                )}
              </div>
            </div>
          </div>

          {projects.length === 0 ? (
            <EmptyState
              icon="⬣"
              title={orgs.length === 0 ? 'Create your first organization' : 'Create your first project'}
              hint={
                orgs.length === 0
                  ? 'Organizations own projects and billing. It takes ten seconds.'
                  : 'Create an isolated CloudNivo backend with PostgreSQL, APIs, authentication, storage, realtime and serverless functions.'
              }
              action={
                <Link className="btn btn-primary" href={orgs.length === 0 ? '/organizations' : '/projects/new'}>
                  {orgs.length === 0 ? 'Create organization' : 'Create project'}
                </Link>
              }
              secondary={
                <Link className="btn" href="/developer">
                  Explore CLI &amp; SDK
                </Link>
              }
            />
          ) : (
            <>
              <div className="ov-grid" style={{ marginBottom: 12 }}>
                <div className="card">
                  <h2 style={{ marginTop: 0 }}>Infrastructure health</h2>
                  {components.length === 0 ? (
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      {health ? 'No component breakdown reported.' : 'Probing control plane…'}
                    </p>
                  ) : (
                    <ul className="health-list">
                      {components.map(([name, up]) => (
                        <li key={name} className="health-row">
                          <StatusDot tone={up ? 'ok' : 'bad'} />
                          <span className="grow">
                            <span className="name">{prettifyKey(name)}</span>
                          </span>
                          <span className="value">{up ? 'Operational' : 'Degraded'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ul className="health-list" style={{ marginTop: components.length > 0 ? 8 : 0 }}>
                    <li className="health-row">
                      <StatusDot tone={degraded > 0 ? 'warn' : 'ok'} pulse={degraded > 0} />
                      <span className="grow">
                        <span className="name">Project databases</span>
                        <div className="detail">
                          {running} healthy{degraded > 0 ? ` · ${degraded} provisioning` : ''}
                        </div>
                      </span>
                      <Link className="value" href="/projects">
                        Details →
                      </Link>
                    </li>
                  </ul>
                </div>

                <div className="card">
                  <h2 style={{ marginTop: 0 }}>
                    Usage{usageOrg ? <span className="muted" style={{ fontWeight: 500 }}> · {usageOrg.name}</span> : ''}
                  </h2>
                  {!usage ? (
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      {usageOrg ? 'Loading current-period meters…' : 'Join an organization to see usage.'}
                    </p>
                  ) : usageTop.length === 0 ? (
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      No metered activity in {usage.period} yet — traffic lands here as it happens.
                    </p>
                  ) : (
                    <ul className="health-list">
                      {usageTop.map(s => (
                        <li key={`${s.service}:${s.metric}`} className="health-row">
                          <span className="grow">
                            <span className="name">{prettifyKey(s.metric)}</span>
                            <div className="detail">{prettifyKey(s.service)}</div>
                          </span>
                          <span className="value">{formatMetric(s.metric, s.total)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p style={{ margin: '10px 0 0', fontSize: 13 }}>
                    <Link href="/billing">Open billing →</Link>
                  </p>
                </div>
              </div>

              <div className="section-head split">
                <div>
                  <p className="eyebrow">Workspace</p>
                  <h2>Your projects</h2>
                </div>
                {projects.length > 6 ? <Link href="/projects">View all {projects.length} →</Link> : null}
              </div>
              <div className="proj-grid" style={{ marginBottom: 16 }}>
                {projects.slice(0, 6).map(p => (
                  <ProjectCard
                    key={p.id}
                    project={{ ...p, orgName: orgs.find(o => o.id === p.organizationId)?.name }}
                  />
                ))}
              </div>

              <div className="card">
                <div className="section-head split">
                  <div>
                    <p className="eyebrow">Workspace</p>
                    <h2>Recent activity</h2>
                  </div>
                  <Link href="/activity">Full feed →</Link>
                </div>
                {activity === null ? (
                  <LoadingSkeleton label="Loading activity" />
                ) : activity.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No infrastructure jobs yet — provisioning and deploys appear here.
                  </p>
                ) : (
                  <ul className="feed">
                    {activity.slice(0, 5).map(a => (
                      <li key={`${a.projectId}:${a.id}`} className="feed-item">
                        <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                        <span className="grow">
                          <span className="title">
                            <code>{a.kind}</code> · <Link href={`/projects/${a.projectId}`}>{a.projectName}</Link>
                          </span>
                          <span className="meta">
                            <span>{timeAgo(a.updatedAt)}</span>
                            {a.lastError ? <span>{a.lastError.slice(0, 100)}</span> : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

async function loadActivity(projects: ProjectCardData[]): Promise<ActivityItem[]> {
  const scoped = projects.slice(0, 8);
  const settled = await Promise.all(
    scoped.map(async (p): Promise<ActivityItem[]> => {
      try {
        const r = await apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${p.id}/jobs`);
        if (!r.ok || !r.data) return [];
        return r.data.jobs.map(j => ({ ...j, projectId: p.id, projectName: p.name }));
      } catch {
        return [];
      }
    }),
  );
  return settled
    .flat()
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 8);
}
