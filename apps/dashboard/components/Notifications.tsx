'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { timeAgo } from '../lib/format';
import { listApprovals, type ApprovalView } from '../lib/agents';
import { useSession } from './SessionProvider';
import { IconBell } from './icons';
import { Badge, statusTone } from './ui';

interface Job {
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  projectId: string;
  projectName: string;
}

interface ProjectLite {
  id: string;
  name: string;
}

interface Notice {
  key: string;
  kind: 'approval' | 'failure';
  title: string;
  detail: string;
  at: string;
  href: string;
}

/**
 * Live operations inbox. Every entry is fetched when the panel opens —
 * pending agent approvals and failed infrastructure jobs. Nothing is
 * synthesized, and there is no read-state to go stale: it recomputes.
 */
export function Notifications(): React.JSX.Element {
  const { orgs, token, ready } = useSession();
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const found: Notice[] = [];
    const approvals = await Promise.all(
      orgs.map(async o => {
        const r = await listApprovals(o.id, 'pending');
        return (r.ok && r.approvals ? r.approvals : []).map((a: ApprovalView) => ({ org: o, a }));
      }),
    );
    for (const { org, a } of approvals.flat()) {
      found.push({
        key: `approval:${a.id}`,
        kind: 'approval',
        title: `Approval needed · ${a.action}`,
        detail: `${org.name} · expires ${timeAgo(a.expiresAt)}`,
        at: a.createdAt,
        href: '/agents',
      });
    }
    try {
      const p = await apiFetch<{ projects: ProjectLite[] }>('/api/v1/projects');
      const list = p.ok && p.data ? p.data.projects.slice(0, 8) : [];
      const settled = await Promise.all(
        list.map(async proj => {
          try {
            const r = await apiFetch<{ jobs: Omit<Job, 'projectId' | 'projectName'>[] }>(
              `/api/v1/projects/${proj.id}/jobs`,
            );
            if (!r.ok || !r.data) return [];
            return r.data.jobs
              .filter(j => j.status === 'failed')
              .map(j => ({ ...j, projectId: proj.id, projectName: proj.name }));
          } catch {
            return [];
          }
        }),
      );
      for (const j of settled.flat().slice(0, 8)) {
        found.push({
          key: `job:${j.projectId}:${j.id}`,
          kind: 'failure',
          title: `Job failed · ${j.kind}`,
          detail: `${j.projectName} · ${timeAgo(j.updatedAt)}`,
          at: j.updatedAt,
          href: `/projects/${j.projectId}/logs`,
        });
      }
    } catch {
      // Jobs feed is best-effort; approvals above still render.
    }
    found.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    setNotices(found.slice(0, 12));
  }, [orgs]);

  useEffect(() => {
    if (open && ready && token) void load();
  }, [open, ready, token, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const count = notices?.length ?? 0;

  return (
    <div className="notif" ref={ref}>
      <button
        type="button"
        className="icon-btn notif-btn"
        aria-label={count > 0 ? `Notifications, ${count} unread operational items` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)}
      >
        <IconBell size={17} />
        {count > 0 ? (
          <span className="notif-badge" aria-hidden>
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="notif-panel" role="dialog" aria-label="Operational notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <Link href="/activity" onClick={() => setOpen(false)}>
              View activity
            </Link>
          </div>
          {notices === null ? (
            <p className="muted" style={{ padding: '12px 14px', margin: 0 }}>
              Checking approvals and jobs…
            </p>
          ) : notices.length === 0 ? (
            <div style={{ padding: '18px 14px', textAlign: 'center' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 650 }}>You&apos;re all caught up</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                No pending approvals or failed jobs.
              </p>
            </div>
          ) : (
            <ul className="notif-list">
              {notices.map(n => (
                <li key={n.key}>
                  <Link href={n.href} onClick={() => setOpen(false)}>
                    <Badge tone={n.kind === 'approval' ? 'warn' : statusTone('failed')}>
                      {n.kind === 'approval' ? 'approval' : 'failed'}
                    </Badge>
                    <span className="grow">
                      <span className="title">{n.title}</span>
                      <span className="meta">{n.detail}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
