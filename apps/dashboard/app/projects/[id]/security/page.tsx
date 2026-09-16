'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

interface Finding {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

export default function ProjectSecurityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setError(null);
    setFindings(null);
    const out: Finding[] = [];
    let s = 100;
    const penalize = (sev: Finding['severity'], title: string, detail: string): void => {
      out.push({ severity: sev, title, detail });
      s -= sev === 'high' ? 10 : sev === 'medium' ? 4 : 1;
    };
    try {
      const [buckets, cors, project] = await Promise.all([
        apiFetch<{ buckets: { name: string; visibility: string }[] }>(
          `/api/v1/projects/${id}/storage/buckets`,
        ),
        apiFetch<{ config: { allowedOrigins: string[] } }>(
          `/api/v1/projects/${id}/auth/config`,
        ),
        apiFetch<{ project: { organizationId: string } }>(`/api/v1/projects/${id}`),
      ]);
      if (buckets.ok && buckets.data) {
        for (const b of buckets.data.buckets) {
          if (b.visibility === 'public') {
            penalize('medium', `Public bucket: ${b.name}`, 'Anyone with the URL can read objects. Make private unless this is intentional.');
          }
        }
      } else if (!buckets.ok && buckets.status !== 404) {
        penalize('low', 'Storage scan unavailable', buckets.error ?? 'Could not list buckets');
      }
      if (cors.ok && cors.data) {
        const origins = cors.data.config.allowedOrigins ?? [];
        if (origins.includes('*')) {
          penalize('high', 'Wildcard CORS origin', 'Credentials must never pair with *. Restrict to explicit origins.');
        } else if (origins.length === 0) {
          penalize('low', 'CORS inherits global list', 'Set an explicit per-project allowlist for least privilege.');
        }
      }
      if (project.ok && project.data) {
        const orgId = project.data.project.organizationId;
        const [plan, usage] = await Promise.all([
          apiFetch<{ plan: { limits?: Record<string, number> } }>(
            `/api/v1/organizations/${orgId}/billing/plan`,
          ),
          apiFetch<{ slices: { service: string; metric: string; total: number }[] }>(
            `/api/v1/organizations/${orgId}/billing/usage`,
          ),
        ]);
        if (plan.ok && usage.ok && plan.data && usage.data) {
          const limits = plan.data.plan.limits ?? {};
          for (const sl of usage.data.slices) {
            const key = `${sl.service}.${sl.metric}`;
            const limit = limits[key] ?? limits[sl.metric];
            if (typeof limit === 'number' && limit > 0 && sl.total >= limit) {
              penalize('high', `Quota breached: ${key}`, `${sl.total} used of ${limit} allowed.`);
            } else if (typeof limit === 'number' && limit > 0 && sl.total >= limit * 0.9) {
              penalize('medium', `Quota warning: ${key}`, `${sl.total} used of ${limit} allowed (≥90%).`);
            }
          }
        }
      }
      const users = await apiFetch<{ users: { emailVerified: boolean }[] }>(
        `/api/v1/projects/${id}/auth/admin/users`,
      );
      if (users.ok && users.data) {
        const unverified = users.data.users.filter(u => !u.emailVerified).length;
        if (unverified > 0) {
          penalize('low', `${unverified} unverified user(s)`, 'Gate sensitive actions on emailVerified.');
        }
      }
      setFindings(out);
      setScore(Math.max(0, s));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    }
  }, [id]);

  useEffect(() => {
    void scan();
  }, [scan]);

  return (
    <div>
      <div className="section-head split">
        <div>
          <h2>Security</h2>
          <p>Live posture scan — public buckets, open CORS, quota breaches and unverified cohorts.</p>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void scan()}>Re-scan</button>
      </div>
      {error ? <ErrorState title="Scan failed" message={error} retry={() => void scan()} /> : null}
      {!findings || score === null ? (
        <LoadingSkeleton label="Scanning posture" rows={3} />
      ) : findings.length === 0 ? (
        <div className="card"><p style={{ margin: 0 }} role="status">Score 100 — no findings. Least privilege holds.</p></div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="card"><p style={{ margin: 0 }}>Score <strong>{score}</strong> · {findings.length} finding(s) (high −10, medium −4, low −1).</p></div>
          {findings.map((f, i) => (
            <div className="card" key={i}>
              <p style={{ margin: 0 }}><strong>[{f.severity}]</strong> {f.title}</p>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>{f.detail}</p>
            </div>
          ))}
        </div>
      )}
      {findings && findings.length === 0 ? null : null}
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>Fix where it lives</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Buckets → <a href={`/projects/${id}/storage`}>Storage</a> · CORS →{' '}
          <a href={`/projects/${id}/auth`}>Authentication</a> · quotas →{' '}
          <a href={`/projects/${id}/usage`}>Usage</a> · users →{' '}
          <a href={`/projects/${id}/auth`}>user directory</a>.
        </p>
      </div>
      {findings !== null && findings.length === 0 ? <EmptyState title="Clean" hint="No action needed." /> : null}
    </div>
  );
}
