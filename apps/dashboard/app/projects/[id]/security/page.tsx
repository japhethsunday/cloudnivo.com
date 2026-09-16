'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import Link from 'next/link';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

type Severity = 'high' | 'medium' | 'low';

interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** Where this is fixed, so each finding carries its own way out. */
  fix?: { label: string; href: string };
}

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 10, medium: 4, low: 1 };

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
    const penalize = (
      sev: Severity,
      title: string,
      detail: string,
      fix?: { label: string; href: string },
    ): void => {
      out.push({ severity: sev, title, detail, fix });
      s -= SEVERITY_WEIGHT[sev];
    };
    const storageFix = { label: 'Storage', href: `/projects/${id}/storage` };
    const authFix = { label: 'Authentication', href: `/projects/${id}/auth` };
    const usageFix = { label: 'Usage', href: `/projects/${id}/usage` };
    try {
      const [buckets, cors, project] = await Promise.all([
        apiFetch<{ buckets: { name: string; visibility: string }[] }>(
          `/api/v1/projects/${id}/storage/buckets`,
        ),
        apiFetch<{ config: { allowedOrigins: string[] } }>(`/api/v1/projects/${id}/auth/config`),
        apiFetch<{ project: { organizationId: string } }>(`/api/v1/projects/${id}`),
      ]);
      if (buckets.ok && buckets.data) {
        for (const b of buckets.data.buckets) {
          if (b.visibility === 'public') {
            penalize(
              'medium',
              `Public bucket: ${b.name}`,
              'Anyone with the URL can read objects. Make it private unless that is intentional.',
              storageFix,
            );
          }
        }
      } else if (!buckets.ok && buckets.status !== 404) {
        penalize(
          'low',
          'Storage scan unavailable',
          buckets.error ?? 'Could not list buckets',
          storageFix,
        );
      }
      if (cors.ok && cors.data) {
        const origins = cors.data.config.allowedOrigins ?? [];
        if (origins.includes('*')) {
          penalize(
            'high',
            'Wildcard CORS origin',
            'Credentials must never pair with *. Restrict this to explicit origins.',
            authFix,
          );
        } else if (origins.length === 0) {
          penalize(
            'low',
            'CORS inherits global list',
            'Set an explicit per-project allowlist for least privilege.',
            authFix,
          );
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
              penalize(
                'high',
                `Quota breached: ${key}`,
                `${sl.total} used of ${limit} allowed.`,
                usageFix,
              );
            } else if (typeof limit === 'number' && limit > 0 && sl.total >= limit * 0.9) {
              penalize(
                'medium',
                `Quota warning: ${key}`,
                `${sl.total} used of ${limit} allowed (90% or more).`,
                usageFix,
              );
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
          penalize(
            'low',
            unverified === 1 ? '1 unverified user' : `${unverified} unverified users`,
            'Gate sensitive actions on emailVerified.',
            authFix,
          );
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
          <p>
            Live posture scan — public buckets, open CORS, quota breaches and unverified cohorts.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void scan()}>
          Re-scan
        </button>
      </div>
      {error ? <ErrorState title="Scan failed" message={error} retry={() => void scan()} /> : null}
      {!findings || score === null ? (
        <LoadingSkeleton label="Scanning posture" rows={3} />
      ) : findings.length === 0 ? (
        <EmptyState
          icon="security"
          title={`Score ${score} — no findings`}
          hint="Buckets are private, CORS is explicit, quotas are inside their limits and every user is verified."
        />
      ) : (
        <div className="posture">
          <div className="card posture-score">
            <div
              className="posture-score-value"
              role="status"
              aria-label={`Posture score ${score} of 100`}
            >
              <strong>{score}</strong>
              <span>/ 100</span>
            </div>
            <ul className="posture-legend">
              {(['high', 'medium', 'low'] as Severity[]).map(sev => {
                const n = findings.filter(f => f.severity === sev).length;
                return (
                  <li key={sev} className={n > 0 ? `sev-${sev}` : 'sev-none'}>
                    <span className="posture-legend-n">{n}</span>
                    <span className="posture-legend-k">
                      <span className="posture-sev">{sev}</span>{' '}
                      <span className="muted">−{SEVERITY_WEIGHT[sev]} each</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <ul className="finding-list">
            {findings.map((f, i) => (
              <li className="card finding" key={`${f.title}-${i}`}>
                <span className={`sev-tag sev-${f.severity}`}>{f.severity}</span>
                <div className="finding-body">
                  <p className="finding-title">{f.title}</p>
                  <p className="finding-detail">{f.detail}</p>
                </div>
                {f.fix ? (
                  <Link className="btn btn-sm" href={f.fix.href}>
                    Fix in {f.fix.label}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
