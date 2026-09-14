'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

interface Fn {
  slug: string;
  status?: string;
}
interface Deployment {
  id: string;
  status: string;
  version?: number;
  createdAt?: string;
}
interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
}

export default function ProjectDeploymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [functions, setFunctions] = useState<Fn[] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, j] = await Promise.all([
      apiFetch<{ functions: Fn[] }>(`/api/v1/projects/${id}/functions`),
      apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${id}/jobs`),
    ]);
    if (!f.ok) setError(f.error ?? 'Could not load functions');
    else {
      setFunctions(f.data?.functions ?? []);
      const all: Deployment[] = [];
      await Promise.all(
        (f.data?.functions ?? []).slice(0, 10).map(async fn => {
          const r = await apiFetch<{ deployments: Deployment[] }>(
            `/api/v1/projects/${id}/functions/${fn.slug}/deployments`,
          );
          if (r.ok && r.data) all.push(...r.data.deployments);
        }),
      );
      setDeployments(all.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, 20));
    }
    if (j.ok && j.data) setJobs(j.data.jobs);
    else if (!j.ok) setError(j.error ?? 'Could not load jobs');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !functions) return <ErrorState title="Couldn't load deployments" message={error} retry={() => void load()} />;
  if (!functions || !jobs) return <LoadingSkeleton label="Loading deployments" rows={4} />;

  const deployJobs = jobs.filter(j => /deploy|provision|branch|restore|import/i.test(j.kind));

  return (
    <div>
      <div className="section-head split">
        <div>
          <p className="eyebrow">Project · Deployments</p>
          <h2>Deployments</h2>
          <p>Function deploys with versions and rollback, plus provisioning and lifecycle jobs.</p>
        </div>
        <Link className="btn btn-sm" href={`/projects/${id}/functions`}>Open Functions →</Link>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Recent function deployments · {deployments.length}</h2>
          {deployments.length === 0 ? (
            <EmptyState title="No deployments yet" hint="Deploy from Functions — every deploy becomes a version you can roll back." />
          ) : (
            <ul className="health-list">
              {deployments.map(d => (
                <li key={d.id} className="health-row">
                  <span className="grow">
                    <span className="name"><code>{d.id.slice(0, 8)}</code> · {d.status}{d.version ? ` · v${d.version}` : ''}</span>
                    <div className="detail">{d.createdAt ? new Date(d.createdAt).toLocaleString() : ''}</div>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Lifecycle jobs · {deployJobs.length}</h2>
          {deployJobs.length === 0 ? (
            <EmptyState title="No lifecycle jobs" hint="Provisioning, branch, restore and import jobs appear here." />
          ) : (
            <ul className="health-list">
              {deployJobs.slice(0, 10).map(j => (
                <li key={j.id} className="health-row">
                  <span className="grow">
                    <span className="name"><code>{j.kind}</code> · {j.status}</span>
                    <div className="detail">{j.lastError ? j.lastError.slice(0, 140) : new Date(j.updatedAt).toLocaleString()}</div>
                  </span>
                  <Link className="value" href={`/projects/${id}/logs`}>Logs →</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
