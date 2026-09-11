'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg, setSelectedOrg } from '../../lib/selection';
import { formatMetric, timeAgo } from '../../lib/format';
import { listAgentTokens, type AgentTokenView } from '../../lib/agents';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingTable } from '../../components/States';
import { Badge } from '../../components/ui';

type Severity = 'critical' | 'high' | 'medium' | 'low';

interface Finding {
  key: string;
  severity: Severity;
  service: string;
  title: string;
  resource: string;
  detail: string;
  fix: string;
  href: string;
}

interface Project {
  id: string;
  name: string;
  organizationId: string;
}

interface Bucket {
  name: string;
  visibility: 'public' | 'private';
}

interface ApiKey {
  id: string;
  name: string;
  role: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface AuthUser {
  id: string;
  emailVerified: boolean;
  status: string;
}

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
}

interface UsageSlice {
  service: string;
  metric: string;
  total: number;
}

const DANGEROUS_SCOPES = new Set([
  'projects.delete',
  'database.migrate',
  'database.destructive',
  'functions.deploy',
  'functions.delete',
  'storage.delete',
]);

const QUOTA_METERS: { limitKey: string; metric: string; label: string }[] = [
  { limitKey: 'apiRequestsPerMonth', metric: 'api_requests', label: 'API requests' },
  { limitKey: 'bandwidthMbPerMonth', metric: 'api_bandwidth_bytes', label: 'Bandwidth' },
  { limitKey: 'storageMb', metric: 'storage_bytes', label: 'Storage' },
  { limitKey: 'functionInvocationsPerMonth', metric: 'function_invocations', label: 'Function invocations' },
  { limitKey: 'aiTokensPerMonth', metric: 'ai_tokens', label: 'AI tokens' },
  { limitKey: 'realtimeMessagesPerMonth', metric: 'realtime_messages', label: 'Realtime messages' },
];

const MB_METRICS = new Set(['api_bandwidth_bytes', 'storage_bytes']);

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 };
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function gradeFor(score: number): string {
  if (score >= 90) return 'Strong';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Needs attention';
  return 'At risk';
}

export default function SecurityPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <SecurityBody />
    </RequireAuth>
  );
}

function SecurityBody(): React.JSX.Element {
  const { orgs } = useSession();
  const [orgId, setOrgId] = useState('');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [severity, setSeverity] = useState('');
  const [service, setService] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgs.length === 0) return;
    const preferred = getSelectedOrg();
    setOrgId(orgs.some(o => o.id === preferred) ? (preferred as string) : orgs[0].id);
  }, [orgs]);

  const scan = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    setFindings(null);
    setSelectedOrg(orgId);
    const out: Finding[] = [];
    try {
      const [p, plan, usage, sub, tok] = await Promise.all([
        apiFetch<{ projects: Project[] }>('/api/v1/projects'),
        apiFetch<{ limits: Record<string, number> }>(`/api/v1/organizations/${orgId}/billing/plan`),
        apiFetch<{ slices: UsageSlice[] }>(`/api/v1/organizations/${orgId}/billing/usage`),
        apiFetch<{ subscription: { status: string } }>(
          `/api/v1/organizations/${orgId}/billing/subscription`,
        ),
        listAgentTokens(orgId),
      ]);
      const scoped = (p.ok && p.data ? p.data.projects : []).filter(pr => pr.organizationId === orgId);

      // ── Organization rules ──
      if (sub.ok && sub.data) {
        const st = sub.data.subscription.status;
        if (st === 'past_due') {
          out.push({
            key: 'org:subscription',
            severity: 'high',
            service: 'Billing',
            title: 'Subscription past due',
            resource: orgs.find(o => o.id === orgId)?.name ?? orgId.slice(0, 8),
            detail: 'Paid limits may stop applying until billing is current.',
            fix: 'Resolve outstanding billing',
            href: '/billing',
          });
        } else if (st === 'canceled') {
          out.push({
            key: 'org:subscription',
            severity: 'medium',
            service: 'Billing',
            title: 'Subscription canceled',
            resource: orgs.find(o => o.id === orgId)?.name ?? orgId.slice(0, 8),
            detail: 'The organization runs on free-plan limits.',
            fix: 'Review plan',
            href: '/billing',
          });
        }
      }
      if (plan.ok && plan.data && usage.ok && usage.data) {
        for (const m of QUOTA_METERS) {
          const raw = plan.data.limits[m.limitKey];
          if (typeof raw !== 'number' || raw < 0) continue;
          const used = usage.data.slices.filter(s => s.metric === m.metric).reduce((n, s) => n + s.total, 0);
          const limit = MB_METRICS.has(m.metric) ? raw * 1024 * 1024 : raw;
          const pct = limit > 0 ? (used / limit) * 100 : 0;
          if (pct >= 100) {
            out.push({
              key: `org:quota:${m.metric}`,
              severity: 'high',
              service: 'Billing',
              title: `${m.label} quota exhausted`,
              resource: `${formatMetric(m.metric, used)} of ${formatMetric(m.metric, limit)}`,
              detail: 'Over-limit traffic may be rejected until the next period or a plan change.',
              fix: 'Raise limits',
              href: '/billing',
            });
          } else if (pct >= 80) {
            out.push({
              key: `org:quota:${m.metric}`,
              severity: 'medium',
              service: 'Billing',
              title: `${m.label} over 80% of quota`,
              resource: `${formatMetric(m.metric, used)} of ${formatMetric(m.metric, limit)}`,
              detail: 'Growth at this pace exhausts the quota before the period ends.',
              fix: 'Review usage',
              href: '/billing',
            });
          }
        }
      }
      if (tok.ok && tok.tokens) {
        for (const t of tok.tokens as AgentTokenView[]) {
          if (t.revokedAt) continue;
          const dangerous = t.scopes.filter(s => DANGEROUS_SCOPES.has(s));
          const expired = t.expiresAt ? Date.parse(t.expiresAt) <= Date.now() : false;
          if (expired) {
            out.push(agentFinding(t, 'low', 'Agent token expired but not revoked', 'Revoke it to keep the inventory exact.'));
          } else if (!t.expiresAt && dangerous.length > 0) {
            out.push(
              agentFinding(
                t,
                'high',
                `Agent token never expires with destructive scope${dangerous.length === 1 ? '' : 's'}`,
                `Scopes: ${dangerous.join(', ')}. A leaked token stays powerful forever.`,
              ),
            );
          } else if (!t.expiresAt) {
            out.push(agentFinding(t, 'medium', 'Agent token never expires', 'Set an expiry so lost tokens die on their own.'));
          } else if (dangerous.length > 0 && !t.approvalRequired) {
            out.push(
              agentFinding(
                t,
                'medium',
                'Destructive scopes without approval gate',
                `Scopes: ${dangerous.join(', ')}. Approval mode turns deletes and deploys into explicit confirmations.`,
              ),
            );
          }
        }
      }

      // ── Project rules (bounded fan-out) ──
      const capped = scoped.slice(0, 10);
      setTruncated(scoped.length > capped.length);
      const settled = await Promise.all(
        capped.map(async proj => {
          const base = `/api/v1/projects/${proj.id}`;
          const [b, k, c, u, j] = await Promise.all([
            apiFetch<{ buckets: Bucket[] }>(`${base}/storage/buckets`),
            apiFetch<{ keys: ApiKey[] }>(`${base}/keys`),
            apiFetch<{ config: { allowedOrigins: string[] } }>(`${base}/auth/config`),
            apiFetch<{ users: AuthUser[] }>(`${base}/auth/admin/users`),
            apiFetch<{ jobs: Job[] }>(`${base}/jobs`),
          ]);
          return { proj, b, k, c, u, j };
        }),
      );
      for (const { proj, b, k, c, u, j } of settled) {
        const pname = proj.name;
        if (b.ok && b.data) {
          for (const bucket of b.data.buckets.filter(x => x.visibility === 'public')) {
            out.push({
              key: `${proj.id}:bucket:${bucket.name}`,
              severity: 'high',
              service: 'Storage',
              title: `Public bucket “${bucket.name}”`,
              resource: pname,
              detail: 'Objects are readable by anyone with the URL. Make it private unless it serves public assets.',
              fix: 'Review bucket',
              href: `/projects/${proj.id}/storage`,
            });
          }
        }
        if (k.ok && k.data) {
          for (const key of k.data.keys.filter(x => !x.revokedAt)) {
            if (key.role === 'service' && !key.expiresAt) {
              out.push({
                key: `${proj.id}:key:${key.id}`,
                severity: 'medium',
                service: 'API',
                title: `Service key “${key.name}” never expires`,
                resource: pname,
                detail: 'Service keys are read-write. Rotate on a schedule or set an expiry.',
                fix: 'Rotate key',
                href: `/projects/${proj.id}/api#keys`,
              });
            } else if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
              out.push({
                key: `${proj.id}:key:${key.id}`,
                severity: 'low',
                service: 'API',
                title: `Expired key “${key.name}” still listed`,
                resource: pname,
                detail: 'It no longer authenticates, but revoking it keeps the inventory exact.',
                fix: 'Revoke key',
                href: `/projects/${proj.id}/api#keys`,
              });
            }
          }
        }
        if (c.ok && c.data && c.data.config.allowedOrigins.includes('*')) {
          out.push({
            key: `${proj.id}:cors`,
            severity: 'high',
            service: 'Authentication',
            title: 'CORS allows any origin',
            resource: pname,
            detail: 'Any website can call this project’s auth endpoints from a browser. Restrict to known origins.',
            fix: 'Restrict origins',
            href: `/projects/${proj.id}/auth`,
          });
        }
        if (u.ok && u.data) {
          const unverified = u.data.users.filter(x => !x.emailVerified && x.status === 'active').length;
          if (unverified > 0) {
            out.push({
              key: `${proj.id}:unverified`,
              severity: 'low',
              service: 'Authentication',
              title: `${unverified} active user${unverified === 1 ? '' : 's'} with unverified email`,
              resource: pname,
              detail: 'Unverified addresses weaken password-reset and notification delivery.',
              fix: 'Review users',
              href: `/projects/${proj.id}/auth`,
            });
          }
          const email = await apiFetch<{ driver: string }>(`/api/v1/projects/${proj.id}/auth/email/status`);
          if (email.ok && email.data && email.data.driver === 'memory' && u.data.users.length > 0) {
            out.push({
              key: `${proj.id}:email`,
              severity: 'medium',
              service: 'Authentication',
              title: 'Verification emails never leave the server',
              resource: pname,
              detail: 'The dev email driver queues messages locally instead of delivering them.',
              fix: 'Configure email',
              href: `/projects/${proj.id}/auth`,
            });
          }
        }
        if (j.ok && j.data) {
          for (const job of j.data.jobs.filter(x => x.status === 'failed').slice(0, 3)) {
            out.push({
              key: `${proj.id}:job:${job.id}`,
              severity: 'medium',
              service: 'Jobs',
              title: `Failed job · ${job.kind}`,
              resource: `${pname} · ${timeAgo(job.updatedAt)}`,
              detail: 'Failed infrastructure work can leave databases or deploys half-finished.',
              fix: 'Inspect logs',
              href: `/projects/${proj.id}/logs`,
            });
          }
        }
      }
      setFindings(out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]));
      setScannedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
      setFindings([]);
    }
  }, [orgId, orgs]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const score = useMemo(() => {
    if (!findings) return null;
    return Math.max(0, 100 - findings.reduce((n, f) => n + SEVERITY_WEIGHT[f.severity], 0));
  }, [findings]);
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings ?? []) c[f.severity] += 1;
    return c;
  }, [findings]);
  const services = useMemo(() => [...new Set((findings ?? []).map(f => f.service))].sort(), [findings]);
  const visible = useMemo(
    () =>
      (findings ?? []).filter(
        f => (severity === '' || f.severity === severity) && (service === '' || f.service === service),
      ),
    [findings, severity, service],
  );

  function agentFinding(t: AgentTokenView, sev: Severity, title: string, detail: string): Finding {
    return {
      key: `agent:${t.id}:${sev}`,
      severity: sev,
      service: 'Agent access',
      title: `${title} — “${t.name}”`,
      resource: orgs.find(o => o.id === t.organizationId)?.name ?? 'organization',
      detail,
      fix: 'Review token',
      href: '/agents',
    };
  }

  const org = orgs.find(o => o.id === orgId);

  return (
    <section aria-labelledby="security-title">
      <div className="page-head">
        <div>
          <h1 id="security-title">Security</h1>
          <p className="sub muted">
            Live posture scan across this organization{org ? ` · ${org.name}` : ''}. Every finding is
            read from the API just now — nothing is sampled or staged.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {orgs.length > 1 ? (
            <select value={orgId} onChange={e => setOrgId(e.target.value)} aria-label="Security organization">
              {orgs.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className="btn" onClick={() => void scan()} disabled={findings === null}>
            Rescan
          </button>
        </div>
      </div>

      {error ? <ErrorState title="Couldn't run security scan" message={error} retry={() => void scan()} /> : null}

      {orgs.length === 0 ? (
        <EmptyState
          icon="settings"
          title="No organization yet"
          hint="Security findings are scoped to an organization. Create one to start scanning."
          action={
            <Link className="btn btn-primary" href="/organizations">
              Create organization
            </Link>
          }
        />
      ) : !findings || score === null ? (
        <LoadingTable label="Scanning security posture" rows={6} />
      ) : (
        <>
          <div className="stat-grid" role="list" aria-label="Security summary">
            <div className="stat" role="listitem">
              <div className="k">Security score</div>
              <div className="v">{score}</div>
              <div className="s">{gradeFor(score)}</div>
            </div>
            {(['high', 'medium', 'low'] as Severity[]).map(s => (
              <div className="stat" role="listitem" key={s}>
                <div className="k">{s}</div>
                <div className="v">{counts[s]}</div>
                <div className="s">open finding{counts[s] === 1 ? '' : 's'}</div>
              </div>
            ))}
            <div className="stat" role="listitem">
              <div className="k">Scanned</div>
              <div className="v" style={{ fontSize: 18 }}>
                {scannedAt ? timeAgo(scannedAt) : '—'}
              </div>
              <div className="s">{truncated ? 'first 10 projects' : 'all projects in scope'}</div>
            </div>
          </div>

          {findings.length === 0 ? (
            <EmptyState
              icon="settings"
              title="No open findings"
              hint="Public buckets, expiring credentials, open CORS, delivery gaps, quota breaches, and failed jobs would appear here the moment they exist."
              action={
                <Link className="btn" href="/activity">
                  View activity
                </Link>
              }
            />
          ) : (
            <>
              <div className="toolbar">
                <select value={severity} onChange={e => setSeverity(e.target.value)} aria-label="Filter by severity">
                  <option value="">All severities</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <select value={service} onChange={e => setService(e.target.value)} aria-label="Filter by service">
                  <option value="">All services</option>
                  {services.map(s => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <span className="muted" style={{ fontSize: 14 }} aria-live="polite">
                  {visible.length} of {findings.length}
                </span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Severity</th>
                      <th scope="col">Finding</th>
                      <th scope="col">Service</th>
                      <th scope="col">Recommended fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(f => (
                      <tr key={f.key}>
                        <td>
                          <Badge tone={f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'muted'}>
                            {f.severity}
                          </Badge>
                        </td>
                        <td>
                          <span className="row-link">{f.title}</span>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {f.resource} · {f.detail}
                          </div>
                        </td>
                        <td className="muted">{f.service}</td>
                        <td>
                          <Link href={f.href}>{f.fix} →</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
