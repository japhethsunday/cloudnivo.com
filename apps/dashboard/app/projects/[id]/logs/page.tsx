'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';
import { Badge, statusTone } from '../../../../components/ui';

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  lastError: string | null;
  logs?: string[];
}

interface FnRecord {
  id: string;
  name: string;
  slug: string;
}

interface LogEntry {
  id: string;
  version: number;
  timestamp: string;
  level: string;
  message: string;
  executionTimeMs: number | null;
  status: string;
}

export default function ProjectLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [functions, setFunctions] = useState<FnRecord[]>([]);
  const [activeFn, setActiveFn] = useState('');
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const [j, f] = await Promise.all([
      apiFetch<{ jobs: Job[] }>(`/api/v1/projects/${id}/jobs`),
      apiFetch<{ functions: FnRecord[] }>(`/api/v1/projects/${id}/functions`),
    ]);
    if (!j.ok) setError(j.error ?? 'Could not load logs');
    else setJobs(j.data?.jobs ?? []);
    if (f.ok && f.data) {
      setFunctions(f.data.functions);
      setActiveFn(current => current || f.data?.functions[0]?.id || '');
    }
  }, [id]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!activeFn) {
      setEntries(null);
      return;
    }
    let live = true;
    void apiFetch<{ logs: LogEntry[] }>(`/api/v1/projects/${id}/functions/${activeFn}/logs?limit=100`).then(
      r => {
        if (live) {
          if (r.ok && r.data) setEntries(r.data.logs);
          else setError(r.error ?? 'Could not load function logs');
        }
      },
    );
    return () => {
      live = false;
    };
  }, [id, activeFn]);

  if (error && !jobs) return <ErrorState message={error} />;
  if (!jobs) return <LoadingSkeleton label="Loading logs" />;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Infrastructure jobs</h2>
        {jobs.length === 0 ? (
          <EmptyState title="No jobs yet" hint="Provisioning and lifecycle operations appear here." />
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id}>
                    <td>
                      <code>{j.kind}</code>
                    </td>
                    <td>
                      <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {j.lastError ?? (j.logs && j.logs.length > 0 ? j.logs[j.logs.length - 1] : '—')}
                    </td>
                    <td className="muted">{new Date(j.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Function logs</h2>
        {functions.length === 0 ? (
          <EmptyState title="No functions yet" hint="Deploy a function to stream execution logs here." />
        ) : (
          <>
            <div className="field" style={{ maxWidth: 320 }}>
              <label htmlFor="log-fn">Function</label>
              <select id="log-fn" value={activeFn} onChange={e => setActiveFn(e.target.value)}>
                {functions.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.slug})
                  </option>
                ))}
              </select>
            </div>
            {!entries ? (
              <LoadingSkeleton label="Loading entries" />
            ) : entries.length === 0 ? (
              <EmptyState title="No executions logged" hint="Invoke the function to produce log entries." />
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Level</th>
                      <th scope="col">Message</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(e => (
                      <tr key={e.id}>
                        <td className="muted">{new Date(e.timestamp).toLocaleString()}</td>
                        <td>
                          <Badge tone={e.level === 'error' ? 'bad' : 'muted'}>{e.level}</Badge>
                        </td>
                        <td style={{ fontSize: 13 }}>{e.message}</td>
                        <td>
                          <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
