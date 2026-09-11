'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { setSelectedProject } from '../../../lib/selection';
import { RequireAuth } from '../../../components/RequireAuth';
import { ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, Breadcrumbs, CopyButton, StatusDot, statusTone } from '../../../components/ui';

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
  { href: '/api', label: 'API' },
  { href: '/auth', label: 'Authentication' },
  { href: '/storage', label: 'Storage' },
  { href: '/realtime', label: 'Realtime' },
  { href: '/functions', label: 'Functions' },
  { href: '/automations', label: 'Automations' },
  { href: '/logs', label: 'Logs' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/usage', label: 'Usage' },
  { href: '/api#keys', label: 'API Keys' },
  { href: '/ai', label: 'AI Builder' },
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
  const [hash, setHash] = useState('');

  useEffect(() => {
    const sync = (): void => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

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
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !project) return <ErrorState title="Couldn't open project" message={error} retry={() => void load()} />;
  if (!project) return <LoadingSkeleton label="Loading project" rows={4} />;

  const base = `/projects/${id}`;
  const status = project.database?.status ?? 'provisioning';
  const health = project.database?.health ?? 'unknown';

  return (
    <section aria-labelledby="ws-title">
      <Breadcrumbs trail={[{ label: 'Projects', href: '/projects' }, { label: project.name }]} />
      <div className="ws-head">
        <div style={{ minWidth: 0 }}>
          <h1 id="ws-title" className="ws-title">
            {project.name}
            <Badge tone={statusTone(status)}>{status}</Badge>
          </h1>
          <div className="ws-meta">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <StatusDot tone={statusTone(health)} pulse={status === 'provisioning' || status === 'pending'} />
              {health === 'unknown' ? 'health unknown' : health}
            </span>
            <span aria-hidden>·</span>
            <span title="Environment / region">Env · {project.region}</span>
            <span aria-hidden>·</span>
            <code title={project.id}>{project.id.slice(0, 8)}…</code>
            <CopyButton text={project.id} label="Copy ID" />
          </div>
          <div className="ws-services" aria-label="Enabled services">
            {['PostgreSQL', 'API', 'Storage', 'Realtime', 'Functions'].map(s => (
              <span key={s} className="ws-service">
                <StatusDot tone={status === 'provisioning' ? 'warn' : 'ok'} />
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
      <nav className="tabs" aria-label="Project sections">
        {TABS.map(t => {
          const [path, anchor] = t.href.split('#');
          const href = `${base}${t.href}`;
          let active: boolean;
          if (anchor != null) {
            active = pathname === `${base}${path}` && hash === `#${anchor}`;
          } else if (t.href === '') {
            active = pathname === base;
          } else if (t.href === '/api') {
            // The keys tab owns the #keys anchor on this same page.
            active = (pathname === href || pathname.startsWith(`${href}/`)) && hash !== '#keys';
          } else {
            active = pathname === href || pathname.startsWith(`${href}/`);
          }
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
