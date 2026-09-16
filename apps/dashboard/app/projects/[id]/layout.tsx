'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { setSelectedProject } from '../../../lib/selection';
import { RequireAuth } from '../../../components/RequireAuth';
import { EnvSwitcher } from '../../../components/EnvSwitcher';
import { ErrorState, LoadingSkeleton } from '../../../components/States';
import { Badge, Breadcrumbs, CopyField, Menu, statusTone } from '../../../components/ui';
import { databaseState, type ProvisionJobLike } from '../../../lib/dbstate';
import { IconChevronDown, IconSettings } from '../../../components/icons';

interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
}

interface ProjectDatabase {
  status: string;
  health?: string;
}

/**
 * Project sections, split by how often a working session touches them.
 * Eighteen equal tabs in one strip overflowed the bar at every window width
 * and hid the tail behind a fade with nothing to click. The daily surfaces
 * stay in the bar; the rest live in one "More" menu that names the current
 * section when the route is inside it, so nothing became unreachable.
 */
const PRIMARY_TABS = [
  { href: '', label: 'Overview' },
  { href: '/database', label: 'Database' },
  { href: '/sql', label: 'SQL Editor' },
  { href: '/api', label: 'API' },
  { href: '/auth', label: 'Authentication' },
  { href: '/storage', label: 'Storage' },
  { href: '/realtime', label: 'Realtime' },
  { href: '/functions', label: 'Functions' },
];

const MORE_TABS = [
  { href: '/automations', label: 'Automations' },
  { href: '/ai', label: 'AI' },
  { href: '/security', label: 'Security' },
  { href: '/logs', label: 'Observability' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/environments', label: 'Environments' },
  { href: '/deployments', label: 'Deployments' },
  { href: '/integrations', label: 'Integrations' },
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
  const [database, setDatabase] = useState<ProjectDatabase | null>(null);
  const [job, setJob] = useState<ProvisionJobLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState('');

  useEffect(() => {
    const sync = (): void => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const load = useCallback(async () => {
    const r = await apiFetch<{
      project: Project;
      database: ProjectDatabase | null;
      job: ProvisionJobLike | null;
    }>(`/api/v1/projects/${id}`);
    if (!r.ok) setError(r.error ?? 'Project not found');
    else if (r.data) {
      setProject(r.data.project);
      // Sibling of the project, not a field on it — see the overview page.
      setDatabase(r.data.database ?? null);
      setJob(r.data.job ?? null);
      setSelectedProject(r.data.project.id);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !project)
    return <ErrorState title="Couldn't open project" message={error} retry={() => void load()} />;
  if (!project) return <LoadingSkeleton label="Loading project" rows={4} />;

  const base = `/projects/${id}`;
  const activeMore =
    MORE_TABS.find(
      t => pathname === `${base}${t.href}` || pathname.startsWith(`${base}${t.href}/`),
    ) ?? null;
  const status = databaseState(database, job).label;
  const health = database?.health ?? 'unknown';
  const healthLabel =
    health === 'healthy' ? 'Healthy' : health === 'unknown' ? 'Health unknown' : health;

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
            {/* The strip states health in the state's own colour; the dot it
                used to carry said the same thing twice. */}
            <span className={`state-word state-${statusTone(health)}`}>{healthLabel}</span>
            <span aria-hidden>·</span>
            <EnvSwitcher projectId={project.id} region={project.region} />
          </div>
        </div>
        <div className="ws-actions">
          <Menu
            label="Project details"
            align="right"
            button={<span className="ws-details-trigger">Details</span>}
          >
            <div className="ws-details" role="none">
              <div className="ws-details-row">
                <span className="ws-details-k">Project ID</span>
                <CopyField text={project.id} label="Project ID" />
              </div>
              <div className="ws-details-row">
                <span className="ws-details-k">Region</span>
                <span>{project.region}</span>
              </div>
              <div className="ws-details-row">
                <span className="ws-details-k">Status</span>
                <span>{status}</span>
              </div>
              <div className="ws-details-row">
                <span className="ws-details-k">Health</span>
                <span>{healthLabel}</span>
              </div>
            </div>
          </Menu>
          <Link
            className="icon-btn"
            href={`${base}/settings`}
            aria-label="Project settings"
            title="Project settings"
          >
            <IconSettings size={16} />
          </Link>
          <Link className="btn btn-primary btn-sm" href={`${base}/database#connection`}>
            Connect
          </Link>
        </div>
      </div>
      <nav className="tabs-row" aria-label="Project sections">
        <div className="tabs">
          {PRIMARY_TABS.map(t => {
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
        </div>
        <Menu
          label="More project sections"
          align="right"
          button={
            <span className="tabs-more" aria-current={activeMore ? 'page' : undefined}>
              {activeMore ? activeMore.label : 'More'}
              <IconChevronDown size={14} />
            </span>
          }
        >
          {MORE_TABS.map(t => (
            <Link
              key={t.href}
              href={`${base}${t.href}`}
              role="menuitem"
              aria-current={activeMore?.href === t.href ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ))}
        </Menu>
      </nav>
      {children}
    </section>
  );
}
