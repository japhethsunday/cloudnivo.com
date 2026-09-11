'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg, setSelectedOrg } from '../../lib/selection';
import { formatMetric, prettifyKey, timeAgo } from '../../lib/format';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, statusTone, useToast } from '../../components/ui';

interface PlanInfo {
  id: string;
  name: string;
  priceCents: number | null;
  currency: string;
}

interface PlanResponse {
  planId: string;
  plan: PlanInfo;
  subscriptionStatus: string;
  limits: Record<string, number>;
}

interface PlansResponse {
  plans: (PlanInfo & { description?: string })[];
}

interface UsageSlice {
  service: string;
  metric: string;
  total: number;
  byProject: { projectId: string; total: number }[];
}

interface UsageResponse {
  period: string;
  planId: string;
  subscriptionStatus: string;
  creditBalanceCents: number;
  slices: UsageSlice[];
}

interface Invoice {
  id: string;
  number: string;
  amountCents: number;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

interface Payment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface Project {
  id: string;
  name: string;
}

/** Map plan-limit keys to the usage metric that fills them. -1 = unlimited. */
const QUOTA_METERS: { limitKey: string; metric: string; label: string }[] = [
  { limitKey: 'apiRequestsPerMonth', metric: 'api_requests', label: 'API requests' },
  { limitKey: 'bandwidthMbPerMonth', metric: 'api_bandwidth_bytes', label: 'Bandwidth' },
  { limitKey: 'storageMb', metric: 'storage_bytes', label: 'Storage' },
  { limitKey: 'functionInvocationsPerMonth', metric: 'function_invocations', label: 'Function invocations' },
  { limitKey: 'aiTokensPerMonth', metric: 'ai_tokens', label: 'AI tokens' },
  { limitKey: 'realtimeMessagesPerMonth', metric: 'realtime_messages', label: 'Realtime messages' },
];

const MB_METRICS = new Set(['api_bandwidth_bytes', 'storage_bytes']);

function quotaTotal(slices: UsageSlice[], metric: string): number {
  return slices.filter(s => s.metric === metric).reduce((n, s) => n + s.total, 0);
}

/** Normalize a quota limit into the same unit as its usage metric. */
function quotaLimit(limitKey: string, metric: string, raw: number): { value: number; display: string } {
  if (raw < 0) return { value: -1, display: 'Unlimited' };
  if (MB_METRICS.has(metric)) {
    const bytes = raw * 1024 * 1024;
    return { value: bytes, display: formatMetric(metric, bytes) };
  }
  return { value: raw, display: formatMetric(metric, raw) };
}

function money(cents: number | null, currency: string): string {
  if (cents === null || cents === undefined) return 'Custom';
  return `${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

export default function BillingPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <BillingBody />
    </RequireAuth>
  );
}

function BillingBody(): React.JSX.Element {
  const { orgs } = useSession();
  const toast = useToast();
  const [orgId, setOrgId] = useState<string>('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [plans, setPlans] = useState<PlansResponse['plans']>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [targetPlan, setTargetPlan] = useState('');

  useEffect(() => {
    if (orgs.length === 0) return;
    const preferred = getSelectedOrg();
    const next = orgs.some(o => o.id === preferred) ? (preferred as string) : orgs[0].id;
    setOrgId(next);
  }, [orgs]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    setSelectedOrg(orgId);
    const [pl, all, u, inv, pay, projs] = await Promise.all([
      apiFetch<PlanResponse>(`/api/v1/organizations/${orgId}/billing/plan`),
      apiFetch<PlansResponse>(`/api/v1/organizations/${orgId}/billing/plans`),
      apiFetch<UsageResponse>(`/api/v1/organizations/${orgId}/billing/usage`),
      apiFetch<{ invoices: Invoice[] }>(`/api/v1/organizations/${orgId}/billing/invoices`),
      apiFetch<{ payments: Payment[] }>(`/api/v1/organizations/${orgId}/billing/payments`),
      apiFetch<{ projects: Project[] }>('/api/v1/projects'),
    ]);
    if (!pl.ok) {
      setError(pl.error ?? 'Could not load billing');
      return;
    }
    if (pl.data) {
      setPlan(pl.data);
      setTargetPlan(pl.data.planId);
    }
    if (all.ok && all.data) setPlans(all.data.plans);
    if (u.ok && u.data) setUsage(u.data);
    if (inv.ok && inv.data) setInvoices(inv.data.invoices);
    if (pay.ok && pay.data) setPayments(pay.data.payments);
    if (projs.ok && projs.data) setProjects(projs.data.projects);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const projectName = useCallback((id: string) => projects.find(p => p.id === id)?.name ?? id.slice(0, 8), [projects]);

  const meters = useMemo(() => {
    if (!plan || !usage) return [];
    return QUOTA_METERS.map(m => {
      const raw = plan.limits[m.limitKey];
      const used = quotaTotal(usage.slices, m.metric);
      const { value: limit, display } = typeof raw === 'number' ? quotaLimit(m.limitKey, m.metric, raw) : { value: -1, display: '—' };
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      return { ...m, used, limit, display, pct };
    });
  }, [plan, usage]);

  async function changePlan(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!targetPlan || targetPlan === plan?.planId) return;
    setBusy(true);
    const r = await apiFetch(`/api/v1/organizations/${orgId}/billing/subscription`, {
      method: 'POST',
      body: { planId: targetPlan },
    });
    setBusy(false);
    if (!r.ok) {
      toast(r.error ?? 'Plan change failed — owner or admin role required', 'bad');
      return;
    }
    toast(`Plan changed to ${targetPlan}`, 'ok');
    void load();
  }

  async function cancelSubscription(): Promise<void> {
    if (!window.confirm('Cancel the subscription for this organization? Limits fall back to the free plan.')) return;
    setBusy(true);
    const r = await apiFetch(`/api/v1/organizations/${orgId}/billing/subscription`, {
      method: 'POST',
      body: { action: 'cancel' },
    });
    setBusy(false);
    if (!r.ok) {
      toast(r.error ?? 'Cancel failed — owner or admin role required', 'bad');
      return;
    }
    toast('Subscription canceled', 'ok');
    void load();
  }

  async function openPortal(): Promise<void> {
    setBusy(true);
    const r = await apiFetch<{ portal: { url?: string } }>(`/api/v1/organizations/${orgId}/billing/portal`, {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      toast(r.error ?? 'Portal unavailable', 'bad');
      return;
    }
    if (r.data.portal.url) window.open(r.data.portal.url, '_blank', 'noopener');
    else toast('Billing provider is manual — no hosted portal in this environment', 'info');
  }

  const org = orgs.find(o => o.id === orgId);

  return (
    <section aria-labelledby="billing-title">
      <div className="page-head">
        <div>
          <h1 id="billing-title">Billing</h1>
          <p className="sub muted">Plans, quotas, usage, invoices, and payments{org ? ` · ${org.name}` : ''}.</p>
        </div>
        {orgs.length > 1 ? (
          <select value={orgId} onChange={e => setOrgId(e.target.value)} aria-label="Billing organization">
            {orgs.map(o => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? <ErrorState message={error} retry={() => void load()} /> : null}

      {orgs.length === 0 ? (
        <EmptyState
          icon="❏"
          title="No organization yet"
          hint="Billing lives on organizations. Create one to see plans and usage."
          action={
            <Link className="btn btn-primary" href="/organizations">
              Create organization
            </Link>
          }
        />
      ) : !plan ? (
        <LoadingSkeleton label="Loading billing" rows={5} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="ov-grid">
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Organization</p>
                <h2>
                  {plan.plan.name} plan{' '}
                  <Badge tone={statusTone(plan.subscriptionStatus)}>{plan.subscriptionStatus}</Badge>
                </h2>
                <p>
                  {money(plan.plan.priceCents, plan.plan.currency)} per month · period {usage?.period ?? '…'}
                  {typeof usage?.creditBalanceCents === 'number' && usage.creditBalanceCents > 0
                    ? ` · ${(usage.creditBalanceCents / 100).toFixed(2)} credit`
                    : ''}
                </p>
              </div>
              <form onSubmit={e => void changePlan(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select
                  value={targetPlan}
                  onChange={e => setTargetPlan(e.target.value)}
                  aria-label="Target plan"
                  style={{ flex: '1 1 200px' }}
                >
                  {plans.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {money(p.priceCents, p.currency)}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || targetPlan === plan.planId}
                >
                  {busy ? 'Working…' : 'Change plan'}
                </button>
              </form>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void openPortal()}>
                  Manage payment
                </button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void cancelSubscription()}>
                  Cancel subscription
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
                Plan changes and cancellation require the owner or admin role. No charge is collected outside a
                verified provider webhook.
              </p>
            </div>

            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Current period</p>
                <h2>Quota usage</h2>
              </div>
              {meters.map(m => (
                <div className="meter" key={m.limitKey}>
                  <div className="meter-top">
                    <span>{m.label}</span>
                    <span className="v">
                      {formatMetric(m.metric, m.used)} / {m.display}
                    </span>
                  </div>
                  <div className="bar" role="progressbar" aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100} aria-label={m.label}>
                    <div className={`fill${m.pct >= 100 ? ' bad' : m.pct >= 75 ? ' warn' : ' ok'}`} style={{ width: `${m.limit > 0 ? m.pct : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <p className="eyebrow">Current period</p>
              <h2>Metered activity</h2>
              <p>Every row is measured by the backend — counters sum within the period, gauges take the peak.</p>
            </div>
            {!usage || usage.slices.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No metered activity in {usage?.period ?? 'this period'} yet.
              </p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col">Metric</th>
                      <th scope="col">Total</th>
                      <th scope="col">By project</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...usage.slices]
                      .sort((a, b) => b.total - a.total)
                      .map(s => (
                        <tr key={`${s.service}:${s.metric}`}>
                          <td>{prettifyKey(s.service)}</td>
                          <td>{prettifyKey(s.metric)}</td>
                          <td className="mono">{formatMetric(s.metric, s.total)}</td>
                          <td className="muted" style={{ fontSize: 13 }}>
                            {s.byProject.length === 0
                              ? 'org-level'
                              : s.byProject
                                  .slice(0, 3)
                                  .map(b => `${projectName(b.projectId)}: ${formatMetric(s.metric, b.total)}`)
                                  .join(' · ')}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="ov-grid">
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Organization</p>
                <h2>Invoices</h2>
              </div>
              {invoices.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No invoices issued for this organization.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Number</th>
                        <th scope="col">Amount</th>
                        <th scope="col">Status</th>
                        <th scope="col">Issued</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map(inv => (
                        <tr key={inv.id}>
                          <td className="mono">{inv.number}</td>
                          <td>{money(inv.amountCents, inv.currency)}</td>
                          <td>
                            <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
                          </td>
                          <td className="muted">{timeAgo(inv.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Organization</p>
                <h2>Payments</h2>
              </div>
              {payments.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No payments recorded for this organization.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Amount</th>
                        <th scope="col">Status</th>
                        <th scope="col">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map(p => (
                        <tr key={p.id}>
                          <td>{money(p.amountCents, p.currency)}</td>
                          <td>
                            <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                          </td>
                          <td className="muted">{timeAgo(p.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
