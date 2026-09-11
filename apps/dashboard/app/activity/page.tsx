'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, statusTone } from '../../components/ui';

interface Project {
  id: string;
  name: string;
  organizationId: string;
}

interface Org {
  id: string;
  name: string;
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

const FANOUT_CAP = 12;

export default function ActivityPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <ActivityBody />
    </RequireAuth>
  );
}

function ActivityBody(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setItems(null);
    const [p, o] = await Promise.all([
      apiFetch<{ projects: Project[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
    ]);
    if (!p.ok) {
      setError(p.error ?? 'Could not load activity');
      setProjects([]);
      setItems([]);
      return;
    }
    const list = p.data?.projects ?? [];
    setProjects(list);
    if (o.ok && o.data) setOrgs(o.data.organizations);
    const scoped = list.slice(0, FANOUT_CAP);
    setTruncated(list.length > scoped.length);
    const settled = await Promise.all(
      scoped.map(async (proj): Promise<ActivityItem[]> => {
        try {
          const r = await apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${proj.id}/jobs`);
          if (!r.ok || !r.data) return [];
          return r.data.jobs.map(j => ({ ...j, projectId: proj.id, projectName: proj.name }));
        } catch {
          return [];
        }
      }),
    );
    setItems(
      settled
        .flat()
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    return (items ?? []).filter(
      a =>
        (status === '' || a.status === status) &&
        (projectFilter === '' || a.projectId === projectFilter),
    );
  }, [items, status, projectFilter]);

  const orgName = useCallback(
    (projectId: string) => {
      const proj = (projects ?? []).find(p => p.id === projectId);
      return orgs.find(o => o.id === proj?.organizationId)?.name;
    },
    [projects, orgs],
  );

  return (
    <section aria-labelledby="activity-title">
      <div className="page-head">
        <div>
          <h1 id="activity-title">Activity</h1>
          <p className="sub muted">Real infrastructure jobs across your workspace — provisioning, deploys, lifecycle.</p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error ? <ErrorState message={error} retry={() => void load()} /> : null}

      {!items || !projects ? (
        <LoadingSkeleton label="Loading activity" rows={5} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="◷"
          title="No activity yet"
          hint="Create a project and every provisioning run, deploy, and lifecycle job lands in this feed."
          action={
            <Link className="btn btn-primary" href="/projects/new">
              Create project
            </Link>
          }
        />
      ) : (
        <>
          <div className="toolbar">
            <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)} aria-label="Filter by project">
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
            </select>
            <span className="muted" style={{ fontSize: 13 }} aria-live="polite">
              {visible.length} event{visible.length === 1 ? '' : 's'}
            </span>
          </div>

          {truncated ? (
            <div className="banner info" role="status">
              <span aria-hidden>ⓘ</span>
              <div className="grow">
                Showing jobs from the first {FANOUT_CAP} projects. Narrow the project filter to see the rest.
              </div>
            </div>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState
              icon="◷"
              title="Nothing matches"
              hint="No jobs match these filters yet."
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setStatus('');
                    setProjectFilter('');
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <div className="card" style={{ padding: '4px 16px' }}>
              <ul className="feed">
                {visible.slice(0, 50).map(a => (
                  <li key={`${a.projectId}:${a.id}`} className="feed-item">
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                    <span className="grow">
                      <span className="title">
                        <code>{a.kind}</code> · <Link href={`/projects/${a.projectId}`}>{a.projectName}</Link>
                        {orgName(a.projectId) ? <span className="muted"> · {orgName(a.projectId)}</span> : null}
                      </span>
                      <span className="meta">
                        <span>{timeAgo(a.updatedAt)}</span>
                        {a.lastError ? <span>{a.lastError.slice(0, 140)}</span> : null}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
