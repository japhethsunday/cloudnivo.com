'use client';

import Link from 'next/link';
import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { formatBytes, timeAgo } from '../../../lib/format';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, statusTone, useToast } from '../../../components/ui';
import { databaseState, type ProvisionJobLike } from '../../../lib/dbstate';

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
}

interface ProjectDatabase {
  status: string;
  health?: string;
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
  const toast = useToast();
  const [database, setDatabase] = useState<ProjectDatabase | null>(null);
  const [provisionJob, setProvisionJob] = useState<ProvisionJobLike | null>(null);
  const [retrying, setRetrying] = useState(false);
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
      apiFetch<{ database: ProjectDatabase | null; job: ProvisionJobLike | null }>(
        `/api/v1/projects/${id}`,
      ),
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
    if (p.ok && p.data) {
      // The database is a sibling of the project in this payload, not a field
      // on it. Reading `project.database` here always produced undefined,
      // which is why the console reported a healthy database as unprovisioned.
      setDatabase(p.data.database ?? null);
      setProvisionJob(p.data.job ?? null);
    }
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

  if (error && !jobs)
    return (
      <ErrorState
        title="Couldn't load project overview"
        message={error}
        retry={() => void load()}
      />
    );
  if (!jobs || !counts) return <LoadingSkeleton label="Loading overview" rows={5} />;

  const recent = jobs.slice(0, 5);
  const failed = jobs.filter(j => j.status === 'failed').length;
  const dbState = databaseState(database, provisionJob);
  const dbStatus = dbState.label;
  const dbHealth = database?.health ?? 'unknown';

  async function provision(): Promise<void> {
    setRetrying(true);
    const r = await apiFetch(`/api/v1/projects/${id}/database/provision`, { method: 'POST' });
    setRetrying(false);
    if (!r.ok) {
      toast(r.error ?? 'Could not start provisioning', 'bad');
      return;
    }
    toast('Provisioning started', 'ok');
    void load();
  }

  const systems: {
    name: string;
    tone: 'ok' | 'warn' | 'bad' | 'muted';
    state: string;
    reading: string;
    href: string;
  }[] = [
    {
      name: 'Database',
      tone: database ? statusTone(dbHealth) : dbState.pending ? 'warn' : 'bad',
      state: dbStatus,
      reading: database
        ? `PostgreSQL · health ${dbHealth}`
        : (dbState.error ?? 'No database record for this project'),
      href: `/projects/${id}/database`,
    },
    {
      name: 'API',
      tone: counts.tables > 0 ? 'ok' : 'muted',
      state: counts.tables > 0 ? 'serving' : 'idle',
      reading: `${counts.tables} table${counts.tables === 1 ? '' : 's'} · ${counts.keys} key${counts.keys === 1 ? '' : 's'}`,
      href: `/projects/${id}/api`,
    },
    {
      name: 'Storage',
      tone: counts.buckets > 0 ? 'ok' : 'muted',
      state: counts.buckets > 0 ? 'in use' : 'empty',
      reading: `${counts.buckets} bucket${counts.buckets === 1 ? '' : 's'} · ${counts.files} file${counts.files === 1 ? '' : 's'} · ${formatBytes(counts.bytes)}`,
      href: `/projects/${id}/storage`,
    },
    {
      name: 'Realtime',
      tone: counts.channels > 0 ? 'ok' : 'muted',
      state: counts.channels > 0 ? 'connected' : 'quiet',
      reading: `${counts.channels} active channel${counts.channels === 1 ? '' : 's'}`,
      href: `/projects/${id}/realtime`,
    },
    {
      name: 'Functions',
      tone: counts.functions > 0 ? 'ok' : 'muted',
      state: counts.functions > 0 ? 'deployed' : 'none',
      reading: `${counts.functions} function${counts.functions === 1 ? '' : 's'} deployed`,
      href: `/projects/${id}/functions`,
    },
    {
      name: 'Jobs',
      tone: failed > 0 ? 'bad' : 'ok',
      state: failed > 0 ? `${failed} failed` : 'clear',
      reading: `${jobs.length} total this project`,
      href: `/projects/${id}/logs`,
    },
  ];

  return (
    <div className="board">
      {dbState.actionable ? (
        <div className="card alarm" role="alert">
          <div className="section-head split">
            <div>
              <h2>Database {dbState.label}</h2>
              <p style={{ margin: '4px 0 0' }}>
                {dbState.error ??
                  'This project has no database yet. Provisioning never completed.'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={retrying}
              onClick={() => void provision()}
            >
              {retrying ? 'Starting…' : 'Provision database'}
            </button>
          </div>
        </div>
      ) : null}

      {failed > 0 ? (
        <div className="card alarm" role="alert">
          <div className="section-head split">
            <div>
              <h2>
                {failed} failed operation{failed === 1 ? '' : 's'}
              </h2>
              <p style={{ margin: '4px 0 0' }}>
                {jobs
                  .filter(j => j.status === 'failed')
                  .slice(0, 3)
                  .map(j => j.kind)
                  .join(', ')}
              </p>
            </div>
            <Link className="btn btn-sm" href={`/projects/${id}/logs`}>
              Investigate →
            </Link>
          </div>
        </div>
      ) : null}

      <div className="board-main">
        <div className="card">
          <div className="section-head">
            <h2>System state</h2>
          </div>
          <ul className="health-list">
            {systems.map(sys => (
              <li
                className={`health-row state-row state-${sys.tone}${
                  sys.name === 'Database' && dbState.pending ? ' state-working' : ''
                }`}
                key={sys.name}
              >
                <span className="grow">
                  <span className="name">{sys.name}</span>
                  <div className="detail">{sys.reading}</div>
                </span>
                <span className={`state-word state-${sys.tone}`}>{sys.state}</span>
                <Link className="value" href={sys.href} aria-label={`Open ${sys.name}`}>
                  Open →
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="section-head split">
            <div>
              <h2>Activity</h2>
            </div>
            <Link href={`/projects/${id}/logs`}>All logs →</Link>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              title="No jobs yet"
              hint="Provisioning, deploys, and lifecycle operations appear here."
            />
          ) : (
            <ul className="feed">
              {recent.map(j => (
                <li key={j.id} className="feed-item">
                  <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                  <span className="grow">
                    {/* The job kind is a real API value, shown as text: boxed in
                      <code> next to a status badge it read as debug output. */}
                    <span className="title">{j.kind}</span>
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
    </div>
  );
}
