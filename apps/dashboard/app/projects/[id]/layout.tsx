'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { setSelectedProject } from '../../../lib/selection';
import { RequireAuth } from '../../../components/RequireAuth';
import { ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, StatusDot, statusTone } from '../../../components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
  database: { status: string; health?: string } | null;
}

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/database', label: 'Database' },
  { href: '/sql', label: 'SQL Editor' },
  { href: '/api', label: 'API & Keys' },
  { href: '/auth', label: 'Auth' },
  { href: '/storage', label: 'Storage' },
  { href: '/realtime', label: 'Realtime' },
  { href: '/functions', label: 'Functions' },
  { href: '/ai', label: 'AI Builder' },
  { href: '/logs', label: 'Logs' },
  { href: '/usage', label: 'Usage' },
  { href: '/settings', label: 'Settings' },
];

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <RequireAuth>
      <Workspace id={id}>{children}</Workspace>
    </RequireAuth>
  );
}

function Workspace({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await apiFetch<{ project: Project }>(`/api/v1/projects/${id}`);
    if (!r.ok) setError(r.error ?? 'Project not found');
    else if (r.data) {
      setProject(r.data.project);
      setSelectedProject(r.data.project.id);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !project) return <ErrorState message={error} />;
  if (!project) return <LoadingSkeleton label="Loading project" />;

  const base = `/projects/${id}`;
  const status = project.database?.status ?? 'provisioning';
  const health = project.database?.health ?? 'unknown';

  return (
    <section aria-labelledby="ws-title">
      <p className="crumbs">
        <Link href="/projects">Projects</Link> <span aria-hidden>›</span> {project.name}
      </p>
      <div className="page-head">
        <div>
          <h1 id="ws-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {project.name}
            <Badge tone={statusTone(status)}>{status}</Badge>
          </h1>
          <p className="sub muted" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code>{project.id}</code>
            <span aria-hidden>·</span>
            <span>{project.region}</span>
            <span aria-hidden>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <StatusDot tone={statusTone(health)} pulse={status === 'provisioning' || status === 'pending'} />
              {health}
            </span>
          </p>
        </div>
      </div>
      <nav className="tabs" aria-label="Project sections">
        {TABS.map(t => {
          const href = `${base}${t.href}`;
          const active = t.href === '' ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={t.href} href={href} aria-current={active ? 'page' : undefined}>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </section>
  );
}
