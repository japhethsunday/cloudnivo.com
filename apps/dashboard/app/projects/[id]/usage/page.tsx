'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';
import { Badge } from '../../../../components/ui';

interface Slice {
  service: string;
  metric: string;
  total: number;
  byProject: { projectId: string; total: number }[];
}

interface Usage {
  period: string;
  planId: string;
  subscriptionStatus?: string;
  slices: Slice[];
  creditBalanceCents?: number;
}

export default function ProjectUsagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [invoices, setInvoices] = useState<{ id: string; number: string; amountCents: number; status: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await apiFetch<{ project: { organizationId: string } }>(`/api/v1/projects/${id}`);
    if (!p.ok || !p.data) {
      setError(p.error ?? 'Project not found');
      return;
    }
    const orgId = p.data.project.organizationId;
    const [u, inv] = await Promise.all([
      apiFetch<Usage>(`/api/v1/organizations/${orgId}/billing/usage`),
      apiFetch<{ invoices: { id: string; number: string; amountCents: number; status: string }[] }>(
        `/api/v1/organizations/${orgId}/billing/invoices`,
      ),
    ]);
    if (!u.ok) setError(u.error ?? 'Could not load usage');
    else if (u.data) setUsage(u.data);
    if (inv.ok && inv.data) setInvoices(inv.data.invoices);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !usage) return <ErrorState title="Couldn't load usage" message={error} />;
  if (!usage) return <LoadingSkeleton label="Loading usage" />;

  const mine = usage.slices
    .map(s => ({
      ...s,
      mine: s.byProject.filter(b => b.projectId === id).reduce((n, b) => n + b.total, 0),
    }))
    .filter(s => s.mine > 0 || s.total > 0);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Usage</h2>
        <p>Metered activity for this project in {usage.period}, against the organization plan.</p>
      </div>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">Period</div>
          <div className="v" style={{ fontSize: 18 }}>{usage.period}</div>
          <div className="s">UTC month</div>
        </div>
        <div className="stat">
          <div className="k">Plan</div>
          <div className="v" style={{ fontSize: 18 }}>{usage.planId}</div>
          <div className="s">{usage.subscriptionStatus ?? ''}</div>
        </div>
        {typeof usage.creditBalanceCents === 'number' ? (
          <div className="stat">
            <div className="k">Credit balance</div>
            <div className="v" style={{ fontSize: 18 }}>${(usage.creditBalanceCents / 100).toFixed(2)}</div>
            <div className="s">Applied to open invoices</div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>This project&apos;s metered usage</h2>
        {mine.length === 0 ? (
          <EmptyState title="No usage recorded yet" hint="API calls, storage, and function runs appear here." />
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Metric</th>
                  <th scope="col">This project</th>
                  <th scope="col">Org total</th>
                </tr>
              </thead>
              <tbody>
                {mine.map(s => (
                  <tr key={`${s.service}/${s.metric}`}>
                    <td>
                      <code>{s.service}</code>
                    </td>
                    <td>
                      <code>{s.metric}</code>
                    </td>
                    <td>{s.mine.toLocaleString()}</td>
                    <td className="muted">{s.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Organization invoices</h2>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices" hint="Invoices generate from real metered usage." />
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(i => (
                  <tr key={i.id}>
                    <td>
                      <code>{i.number}</code>
                    </td>
                    <td>${(i.amountCents / 100).toFixed(2)}</td>
                    <td>
                      <Badge tone={i.status === 'paid' ? 'ok' : i.status === 'void' ? 'bad' : 'warn'}>{i.status}</Badge>
                    </td>
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
