'use client';

import Link from 'next/link';
import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, statusTone } from '../../../components/ui';

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [counts, setCounts] = useState<{ keys: number; buckets: number; functions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [j, k, b, f] = await Promise.all([
      apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${id}/jobs`),
      apiFetch<{ keys: unknown[] }>(`/api/v1/projects/${id}/keys`),
      apiFetch<{ buckets: unknown[] }>(`/api/v1/projects/${id}/storage/buckets`),
      apiFetch<{ functions: unknown[] }>(`/api/v1/projects/${id}/functions`),
    ]);
    if (!j.ok) setError(j.error ?? 'Could not load project activity');
    else setJobs(j.data?.jobs ?? []);
    setCounts({
      keys: k.ok && k.data ? k.data.keys.length : 0,
      buckets: b.ok && b.data ? b.data.buckets.length : 0,
      functions: f.ok && f.data ? f.data.functions.length : 0,
    });
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !jobs) return <ErrorState message={error} />;
  if (!jobs || !counts) return <LoadingSkeleton label="Loading overview" />;

  const recent = jobs.slice(0, 5);
  const failed = jobs.filter(j => j.status === 'failed').length;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">API keys</div>
          <div className="v">{counts.keys}</div>
          <div className="s">
            <Link href={`/projects/${id}/api`}>Manage keys</Link>
          </div>
        </div>
        <div className="stat">
          <div className="k">Buckets</div>
          <div className="v">{counts.buckets}</div>
          <div className="s">
            <Link href={`/projects/${id}/storage`}>Manage storage</Link>
          </div>
        </div>
        <div className="stat">
          <div className="k">Functions</div>
          <div className="v">{counts.functions}</div>
          <div className="s">
            <Link href={`/projects/${id}/functions`}>Manage functions</Link>
          </div>
        </div>
        <div className="stat">
          <div className="k">Jobs</div>
          <div className="v">{jobs.length}</div>
          <div className="s">{failed > 0 ? `${failed} failed` : 'none failed'}</div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent activity</h2>
        {recent.length === 0 ? (
          <EmptyState title="No jobs yet" hint="Provisioning, deploys, and lifecycle operations appear here." />
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(j => (
                  <tr key={j.id}>
                    <td>
                      <code>{j.kind}</code>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {j.id.slice(0, 8)}
                      </div>
                    </td>
                    <td>
                      <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                      {j.lastError ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {j.lastError.slice(0, 120)}
                        </div>
                      ) : null}
                    </td>
                    <td className="muted">{new Date(j.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
