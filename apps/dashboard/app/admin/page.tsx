'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatCount, timeAgo } from '../../lib/format';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingTable } from '../../components/States';
import { Badge, SectionHead, statusTone } from '../../components/ui';
import { GrowthChart, type GrowthPoint } from '../../components/GrowthChart';

/**
 * Platform operator console.
 *
 * Every number here is read from /api/v1/admin, which is staff-gated and
 * read-only. Nothing on this page is a placeholder or a sample: a platform
 * with one project says one project. The API answers 404 to a non-staff
 * caller, so a developer who guesses the URL sees the same "not found" as a
 * stranger, and this page says so plainly rather than rendering empty chrome.
 */

interface Overview {
  totals: { users: number; organizations: number; projects: number; databases: number };
  recent: {
    usersThisWeek: number;
    usersThisMonth: number;
    projectsThisWeek: number;
    projectsThisMonth: number;
  };
  growth: GrowthPoint[];
  databases: Record<string, number>;
  provisioning: { failed: number };
  generatedAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  members: number;
  projects: number;
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  organizationName: string | null;
  region: string;
  databaseStatus: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
}

interface JobRow {
  id: string;
  projectId: string;
  organizationId: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): React.JSX.Element {
  return (
    <li className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </li>
  );
}

function AdminConsole(): React.JSX.Element {
  const { user } = useSession();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [o, og, p, u, j] = await Promise.all([
        apiFetch<Overview>('/api/v1/admin/overview'),
        apiFetch<{ organizations: OrgRow[] }>('/api/v1/admin/organizations?limit=8'),
        apiFetch<{ projects: ProjectRow[] }>('/api/v1/admin/projects?limit=8'),
        apiFetch<{ users: UserRow[] }>('/api/v1/admin/users?limit=8'),
        apiFetch<{ jobs: JobRow[] }>('/api/v1/admin/jobs?limit=10'),
      ]);
      /**
       * The API answers 404 to a caller who is not staff, so a failure here
       * is far more likely to be "you are not staff" than a broken console.
       * Say that instead of showing a raw request error.
       */
      if (!o.ok || !o.data) {
        setError(
          o.status === 404
            ? 'The operator console is limited to CloudNivo staff.'
            : (o.error ?? 'Could not load the operator console'),
        );
        return;
      }
      setOverview(o.data);
      setOrgs(og.data?.organizations ?? []);
      setProjects(p.data?.projects ?? []);
      setUsers(u.data?.users ?? []);
      setJobs(j.data?.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the operator console');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (user && !user.isPlatformAdmin) {
    return (
      <EmptyState
        title="Not available"
        hint="The operator console is limited to CloudNivo staff. Your account is signed in and working normally — this page is simply not yours to see."
      />
    );
  }

  if (loading && !overview) return <LoadingTable label="Loading the platform" rows={4} />;
  if (error) return <ErrorState message={error} retry={() => void load()} title="Couldn't load the platform" />;
  if (!overview) return <EmptyState title="No platform data" hint="The console returned nothing." />;

  const dbStatuses = Object.entries(overview.databases).sort((a, b) => b[1] - a[1]);

  return (
    <section aria-labelledby="admin-title">
      <div className="page-head">
        <div>
          <h1 id="admin-title">Platform</h1>
          <p className="sub muted">Every tenant on this deployment. Read-only, staff only.</p>
        </div>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {overview.provisioning.failed > 0 ? (
        <div className="card alarm">
          <h3>
            {overview.provisioning.failed} provisioning{' '}
            {overview.provisioning.failed === 1 ? 'job has' : 'jobs have'} failed
          </h3>
          <p>
            These projects have no database and will not get one without help. Each row carries the
            provisioner&apos;s own error.
          </p>
        </div>
      ) : null}

      <ul className="stat-grid" aria-label="Platform totals">
        <Stat
          label="Signups"
          value={formatCount(overview.totals.users)}
          sub={`${overview.recent.usersThisWeek} this week · ${overview.recent.usersThisMonth} this month`}
        />
        <Stat label="Organizations" value={formatCount(overview.totals.organizations)} />
        <Stat
          label="Projects"
          value={formatCount(overview.totals.projects)}
          sub={`${overview.recent.projectsThisWeek} this week · ${overview.recent.projectsThisMonth} this month`}
        />
        <Stat
          label="Databases"
          value={formatCount(overview.totals.databases)}
          sub={dbStatuses.map(([s, n]) => `${n} ${s}`).join(' · ') || undefined}
        />
      </ul>

      <div className="card">
        <SectionHead title="Growth" desc="Signups and projects created each month." split={false} />
        <GrowthChart data={overview.growth} />
      </div>

      <div className="admin-split">
        <div className="card">
          <SectionHead title="Organizations" desc="By project count." split={false} />
          {orgs.length === 0 ? (
            <EmptyState title="No organizations yet" hint="The first signup creates one." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Organization</th>
                    <th scope="col">Members</th>
                    <th scope="col">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.map(o => (
                    <tr key={o.id}>
                      <th scope="row">
                        <span className="admin-name">{o.name}</span>
                        <span className="muted">{o.slug}</span>
                      </th>
                      <td>{o.members}</td>
                      <td>{o.projects}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <SectionHead title="Newest projects" desc="With the state of their database." split={false} />
          {projects.length === 0 ? (
            <EmptyState title="No projects yet" hint="Nothing has been provisioned." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Database</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map(p => (
                    <tr key={p.id}>
                      <th scope="row">
                        <Link href={`/projects/${p.id}`} className="admin-name">
                          {p.name}
                        </Link>
                        <span className="muted">{p.organizationName ?? p.organizationId}</span>
                      </th>
                      <td>
                        {p.databaseStatus ? (
                          <Badge tone={statusTone(p.databaseStatus)}>{p.databaseStatus}</Badge>
                        ) : (
                          <Badge tone="warn">not provisioned</Badge>
                        )}
                      </td>
                      <td>{timeAgo(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <SectionHead
          title="Failed provisioning"
          desc="Jobs that exhausted their attempts. Open the project to retry."
          split={false}
        />
        {jobs.length === 0 ? (
          <EmptyState title="Nothing failed" hint="Every provisioning job has completed." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Error</th>
                  <th scope="col">Last tried</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id}>
                    <th scope="row">
                      <Link href={`/projects/${j.projectId}`} className="admin-name">
                        {j.projectId.slice(0, 8)}
                      </Link>
                      <span className="muted">{j.kind}</span>
                    </th>
                    <td>
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="admin-error">{j.lastError ?? 'no error recorded'}</td>
                    <td>{timeAgo(j.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <SectionHead title="Newest signups" split={false} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <th scope="row">
                    <span className="admin-name">{u.displayName ?? u.email}</span>
                    {u.displayName ? <span className="muted">{u.email}</span> : null}
                  </th>
                  <td>{u.isPlatformAdmin ? <Badge tone="ok">staff</Badge> : 'developer'}</td>
                  <td>{timeAgo(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted admin-asof">Read at {new Date(overview.generatedAt).toLocaleString()}.</p>
    </section>
  );
}

export default function AdminPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AdminConsole />
    </RequireAuth>
  );
}
