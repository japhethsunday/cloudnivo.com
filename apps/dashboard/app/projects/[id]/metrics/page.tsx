'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { formatMetric, prettifyKey, timeAgo } from '../../../../lib/format';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

interface ServiceSummary {
  service: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

interface RouteSummary {
  method: string;
  route: string;
  requests: number;
  errors: number;
}

interface Bucket {
  at: number;
  requests: number;
  errors: number;
}

interface Metrics {
  window: string;
  sinceBoot: string;
  note: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  byService: ServiceSummary[];
  topRoutes: RouteSummary[];
  timeline: Bucket[];
}

const WINDOWS = ['1h', '6h', '24h', '7d'];

export default function ProjectMetricsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [window, setWindow] = useState('1h');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const p = await apiFetch<{ project: { organizationId: string } }>(`/api/v1/projects/${id}`);
    if (!p.ok || !p.data) {
      setError(p.error ?? 'Project not found');
      return;
    }
    const r = await apiFetch<Metrics>(
      `/api/v1/organizations/${p.data.project.organizationId}/metrics?window=${window}&projectId=${id}`,
    );
    if (!r.ok) setError(r.error ?? 'Could not load metrics');
    else if (r.data) setMetrics(r.data);
  }, [id, window]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = Math.max(1, ...((metrics?.timeline ?? []).map(b => b.requests)));

  return (
    <div>
      <div className="section-head split">
        <div>
          <p className="eyebrow">Project</p>
          <h2>Metrics</h2>
          <p>Real request counts, errors, and latency measured by the API{metrics ? ` since ${timeAgo(metrics.sinceBoot)}` : ''}.</p>
        </div>
        <select value={window} onChange={e => setWindow(e.target.value)} aria-label="Time window">
          {WINDOWS.map(w => (
            <option key={w} value={w}>
              Last {w}
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorState title="Couldn't load metrics" message={error} retry={() => void load()} /> : null}
      {!metrics && !error ? (
        <LoadingSkeleton label="Loading metrics" rows={5} />
      ) : metrics ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="stat-grid" role="list" aria-label="Request totals">
            <div className="stat" role="listitem">
              <div className="k">Requests</div>
              <div className="v">{formatMetric('api_requests', metrics.requests)}</div>
              <div className="s">last {metrics.window}</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Errors</div>
              <div className="v">{formatMetric('api_requests', metrics.errors)}</div>
              <div className="s">{(metrics.errorRate * 100).toFixed(1)}% error rate</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Latency p50</div>
              <div className="v">{Math.round(metrics.p50Ms)}<span style={{ fontSize: 14, fontWeight: 500 }}> ms</span></div>
              <div className="s">median response</div>
            </div>
            <div className="stat" role="listitem">
              <div className="k">Latency p95</div>
              <div className="v">{Math.round(metrics.p95Ms)}<span style={{ fontSize: 14, fontWeight: 500 }}> ms</span></div>
              <div className="s">tail response</div>
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <h2 style={{ fontSize: 15 }}>Throughput</h2>
              <p>Requests per 5-minute bucket. Taller bars are busier windows — never targets.</p>
            </div>
            {metrics.timeline.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No traffic in this window yet.
              </p>
            ) : (
              <div className="bars" role="img" aria-label={`${metrics.requests} requests across ${metrics.timeline.length} buckets`}>
                {metrics.timeline.map(b => (
                  <div
                    key={b.at}
                    className={`bar${b.errors > 0 ? ' errors' : ''}`}
                    style={{ height: `${Math.max(4, Math.round((b.requests / peak) * 72))}px` }}
                    title={`${new Date(b.at).toLocaleString()}: ${b.requests} requests, ${b.errors} errors`}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="ov-grid">
            <div className="card">
              <div className="section-head">
                <h2 style={{ fontSize: 15 }}>By service</h2>
              </div>
              {metrics.byService.length === 0 ? (
                <EmptyState title="No service traffic" hint="Calls to this project appear here broken down by service." />
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Service</th>
                        <th scope="col">Requests</th>
                        <th scope="col">Errors</th>
                        <th scope="col">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.byService.map(s => (
                        <tr key={s.service}>
                          <td>{prettifyKey(s.service)}</td>
                          <td>{formatMetric('api_requests', s.requests)}</td>
                          <td className="muted">{(s.errorRate * 100).toFixed(1)}%</td>
                          <td className="muted">{Math.round(s.p95Ms)} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="card">
              <div className="section-head">
                <h2 style={{ fontSize: 15 }}>Top routes</h2>
              </div>
              {metrics.topRoutes.length === 0 ? (
                <EmptyState title="No routes yet" hint="The most-called endpoints land here." />
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Route</th>
                        <th scope="col">Requests</th>
                        <th scope="col">Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.topRoutes.slice(0, 8).map(r => (
                        <tr key={`${r.method} ${r.route}`}>
                          <td>
                            <code>
                              {r.method} {r.route}
                            </code>
                          </td>
                          <td>{formatMetric('api_requests', r.requests)}</td>
                          <td className="muted">{r.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {metrics.note}
          </p>
        </div>
      ) : null}
    </div>
  );
}
