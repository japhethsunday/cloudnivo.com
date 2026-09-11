'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getSelectedOrg, getSelectedProject, setSelectedOrg, setSelectedProject } from '../lib/selection';
import { useSession } from './SessionProvider';
import { ThemeToggle } from './ThemeToggle';
import { Menu, ToastProvider } from './ui';

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
}

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: '⌂' },
  { href: '/projects', label: 'Projects', icon: '▦' },
  { href: '/organizations', label: 'Organizations', icon: '⛉' },
  { href: '/account', label: 'Account', icon: '☺' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

function isAuthRoute(pathname: string): boolean {
  return pathname === '/login' || pathname === '/signup' || pathname === '/';
}

export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  if (isAuthRoute(pathname)) {
    return (
      <ToastProvider>
        <div className="auth-shell">{children}</div>
      </ToastProvider>
    );
  }
  return (
    <ToastProvider>
      <ShellBody pathname={pathname}>{children}</ShellBody>
    </ToastProvider>
  );
}

function ShellBody({
  pathname,
  children,
}: {
  pathname: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { user, orgs, token, ready, logout } = useSession();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!ready || !token) return;
    setOrgId(getSelectedOrg());
    setProjectId(getSelectedProject());
    let live = true;
    void apiFetch<{ projects: ProjectLite[] }>('/api/v1/projects').then(r => {
      if (live && r.ok && r.data) setProjects(r.data.projects);
    });
    return () => {
      live = false;
    };
  }, [ready, token, pathname]);

  useEffect(() => {
    if (ready && orgs.length > 0 && !orgs.some(o => o.id === orgId)) {
      const fallback = orgs[0]?.id ?? null;
      setOrgId(fallback);
      setSelectedOrg(fallback);
    }
  }, [ready, orgs, orgId]);

  const org = orgs.find(o => o.id === orgId) ?? orgs[0] ?? null;
  const project = projects.find(p => p.id === projectId) ?? null;
  const orgProjects = org ? projects.filter(p => p.organizationId === org.id) : projects;

  function pickOrg(id: string): void {
    setOrgId(id);
    setSelectedOrg(id);
    const first = projects.find(p => p.organizationId === id);
    setProjectId(first?.id ?? null);
    setSelectedProject(first?.id ?? null);
  }

  function pickProject(id: string): void {
    setProjectId(id);
    setSelectedProject(id);
    router.push(`/projects/${id}`);
  }

  function doLogout(): void {
    logout();
    setSelectedProject(null);
    router.replace('/login');
  }

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}${navOpen ? ' nav-open' : ''}`}>
      <div className="mobilebar">
        <button
          type="button"
          className="icon-btn"
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          onClick={() => setNavOpen(o => !o)}
        >
          ☰
        </button>
        <span className="brand">
          <span className="brand-mark">C</span>CloudNivo
        </span>
        <span className="spacer" />
        {user ? <span className="avatar" aria-label={user.email}>{user.email.slice(0, 1)}</span> : null}
      </div>
      <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
      <aside className="sidebar" aria-label="Sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>CloudNivo
        </div>

        <div>
          <p className="nav-label">Organization</p>
          <OrgMenu org={org} orgs={orgs} onPick={pickOrg} />
        </div>

        <div>
          <p className="nav-label">Project</p>
          <ProjectMenu project={project} projects={orgProjects} onPick={pickProject} />
        </div>

        <nav className="nav" aria-label="Primary">
          <p className="nav-label">Workspace</p>
          {NAV.map(l => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href || pathname.startsWith(`${l.href}/`) ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden>
                {l.icon}
              </span>
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ThemeToggle />
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => setCollapsed(c => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? '→ Expand' : '← Collapse'}
          </button>
          <AccountMenu
            email={user?.email ?? null}
            onLogout={doLogout}
            onAccount={() => router.push('/account')}
          />
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function OrgMenu({
  org,
  orgs,
  onPick,
}: {
  org: { id: string; name: string; slug: string } | null;
  orgs: { id: string; name: string; slug: string }[];
  onPick: (id: string) => void;
}): React.JSX.Element {
  if (!org) {
    return (
      <Link className="btn btn-sm" href="/organizations">
        + New organization
      </Link>
    );
  }
  return (
    <Menu
      label="Switch organization"
      button={
        <>
          <span className="grow">
            {org.name}
            <span className="sub">{org.slug}</span>
          </span>
          <span aria-hidden>▾</span>
        </>
      }
    >
      <OrgMenuItems org={org} orgs={orgs} onPick={onPick} />
    </Menu>
  );
}

function OrgMenuItems({
  org,
  orgs,
  onPick,
}: {
  org: { id: string };
  orgs: { id: string; name: string; slug: string }[];
  onPick: (id: string) => void;
}): React.JSX.Element {
  return (
    <>
      {orgs.map(o => (
        <button key={o.id} type="button" role="menuitem" onClick={() => onPick(o.id)}>
          <span className="grow">
            {o.name}
            <span className="sub">{o.slug}</span>
          </span>
          {o.id === org.id ? <span className="sel" aria-hidden>✓</span> : null}
        </button>
      ))}
      <Link href="/organizations">+ Manage organizations</Link>
    </>
  );
}

function ProjectMenu({
  project,
  projects,
  onPick,
}: {
  project: ProjectLite | null;
  projects: ProjectLite[];
  onPick: (id: string) => void;
}): React.JSX.Element {
  if (!project) {
    return (
      <Link className="btn btn-sm" href="/projects/new">
        + New project
      </Link>
    );
  }
  return (
    <Menu
      label="Switch project"
      button={
        <>
          <span className="grow">
            {project.name}
            <span className="sub">{project.slug}</span>
          </span>
          <span aria-hidden>▾</span>
        </>
      }
    >
      {projects.map(p => (
        <button key={p.id} type="button" role="menuitem" onClick={() => onPick(p.id)}>
          <span className="grow">
            {p.name}
            <span className="sub">{p.slug}</span>
          </span>
          {p.id === project.id ? <span className="sel" aria-hidden>✓</span> : null}
        </button>
      ))}
      <Link href="/projects/new">+ New project</Link>
    </Menu>
  );
}

function AccountMenu({
  email,
  onLogout,
  onAccount,
}: {
  email: string | null;
  onLogout: () => void;
  onAccount: () => void;
}): React.JSX.Element {
  if (!email) {
    return (
      <Link className="btn btn-sm" href="/login">
        Log in
      </Link>
    );
  }
  return (
    <Menu
      label={`Account: ${email}`}
      up
      button={
        <>
          <span className="avatar" aria-hidden>
            {email.slice(0, 1)}
          </span>
          <span className="grow" style={{ fontWeight: 500, fontSize: 12 }}>
            {email}
          </span>
        </>
      }
    >
      <button type="button" role="menuitem" onClick={onAccount}>
        Account settings
      </button>
      <button type="button" role="menuitem" onClick={onLogout}>
        Log out
      </button>
    </Menu>
  );
}
