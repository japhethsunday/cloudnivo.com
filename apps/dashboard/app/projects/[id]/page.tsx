'use client';

import Link from 'next/link';
import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { formatBytes, timeAgo } from '../../../lib/format';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, StatusDot, statusTone } from '../../../components/ui';

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
}

interface Project {
  id: string;
  name: string;
  database: { status: string; health?: string } | null;
}

interface StorageUsage {
  files: number;
  bytes: number;
}

interface RealtimeStats {
  channelCount: number;
  deliveredCount: number;
  presenceEntries: number;
}

export default function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [counts, setCounts] = useState<{
    keys: number;
    tables: number;
    buckets: number;
    functions: number;
    files: number;
    bytes: number;
    channels: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, j, k, s, b, f, u, r] = await Promise.all([
      apiFetch<{ project: Project }>(`/api/v1/projects/${id}`),
      apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${id}/jobs`),
      apiFetch<{ keys: unknown[] }>(`/api/v1/projects/${id}/keys`),
      apiFetch<{ tables: { name: string }[] }>(`/api/v1/projects/${id}/database/schema`),
      apiFetch<{ buckets: unknown[] }>(`/api/v1/projects/${id}/storage/buckets`),
      apiFetch<{ functions: unknown[] }>(`/api/v1/projects/${id}/functions`),
      apiFetch<StorageUsage>(`/api/v1/projects/${id}/storage/usage`),
      apiFetch<{ stats: RealtimeStats }>(`/api/v1/projects/${id}/realtime/stats`),
    ]);
    if (!j.ok) setError(j.error ?? 'Could not load project activity');
    else setJobs(j.data?.jobs ?? []);
    if (p.ok && p.data) setProject(p.data.project);
    setCounts({
      keys: k.ok && k.data ? k.data.keys.length : 0,
      tables: s.ok && s.data ? s.data.tables.length : 0,
      buckets: b.ok && b.data ? b.data.buckets.length : 0,
      functions: f.ok && f.data ? f.data.functions.length : 0,
      files: u.ok && u.data ? (u.data.files ?? 0) : 0,
      bytes: u.ok && u.data ? (u.data.bytes ?? 0) : 0,
      channels: r.ok && r.data ? (r.data.stats.channelCount ?? 0) : 0,
    });
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !jobs) return <ErrorState title="Couldn't load project overview" message={error} retry={() => void load()} />;
  if (!jobs || !counts) return <LoadingSkeleton label="Loading overview" rows={5} />;

  const recent = jobs.slice(0, 5);
  const failed = jobs.filter(j => j.status === 'failed').length;
  const dbStatus = project?.database?.status ?? 'provisioning';
  const dbHealth = project?.database?.health ?? 'unknown';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="section-head">
          <p className="eyebrow">Project</p>
          <h2>Infrastructure health</h2>
        </div>
        <ul className="health-list">
          <li className="health-row">
            <StatusDot tone={statusTone(dbHealth)} pulse={dbStatus === 'provisioning'} />
            <span className="grow">
              <span className="name">Database</span>
              <div className="detail">
                PostgreSQL · {dbStatus}
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/database`}>
              Open →
            </Link>
          </li>
          <li className="health-row">
            <StatusDot tone={counts.tables > 0 ? 'ok' : 'muted'} />
            <span className="grow">
              <span className="name">API</span>
              <div className="detail">
                {counts.tables} table{counts.tables === 1 ? '' : 's'} exposed · {counts.keys} key
                {counts.keys === 1 ? '' : 's'}
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/api`}>
              Open →
            </Link>
          </li>
          <li className="health-row">
            <StatusDot tone={counts.buckets > 0 ? 'ok' : 'muted'} />
            <span className="grow">
              <span className="name">Storage</span>
              <div className="detail">
                {counts.buckets} bucket{counts.buckets === 1 ? '' : 's'} · {counts.files} file
                {counts.files === 1 ? '' : 's'} · {formatBytes(counts.bytes)}
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/storage`}>
              Open →
            </Link>
          </li>
          <li className="health-row">
            <StatusDot tone={counts.channels > 0 ? 'ok' : 'muted'} />
            <span className="grow">
              <span className="name">Realtime</span>
              <div className="detail">
                {counts.channels} active channel{counts.channels === 1 ? '' : 's'}
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/realtime`}>
              Open →
            </Link>
          </li>
          <li className="health-row">
            <StatusDot tone={counts.functions > 0 ? 'ok' : 'muted'} />
            <span className="grow">
              <span className="name">Functions</span>
              <div className="detail">
                {counts.functions} function{counts.functions === 1 ? '' : 's'} deployed
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/functions`}>
              Open →
            </Link>
          </li>
          <li className="health-row">
            <StatusDot tone={failed > 0 ? 'bad' : 'ok'} />
            <span className="grow">
              <span className="name">Jobs</span>
              <div className="detail">
                {jobs.length} total{failed > 0 ? ` · ${failed} failed` : ' · none failed'}
              </div>
            </span>
            <Link className="value" href={`/projects/${id}/logs`}>
              View logs →
            </Link>
          </li>
        </ul>
      </div>

      <div className="card">
        <div className="section-head split">
          <div>
            <p className="eyebrow">Project</p>
            <h2>Recent activity</h2>
          </div>
          <Link href={`/projects/${id}/logs`}>All logs →</Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No jobs yet" hint="Provisioning, deploys, and lifecycle operations appear here." />
        ) : (
          <ul className="feed">
            {recent.map(j => (
              <li key={j.id} className="feed-item">
                <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                <span className="grow">
                  <span className="title">
                    <code>{j.kind}</code>
                  </span>
                  <span className="meta">
                    <span>{timeAgo(j.updatedAt)}</span>
                    {j.lastError ? <span>{j.lastError.slice(0, 120)}</span> : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
