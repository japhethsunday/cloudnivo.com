'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/api';
import { getSectionTab, setSectionTab, subscribeSectionTab } from '../lib/sectiontab';
import { getSelectedOrg, getSelectedProject, setSelectedOrg, setSelectedProject } from '../lib/selection';
import { CommandPalette } from './CommandPalette';
import { LogoMark } from './LogoMark';
import { Notifications } from './Notifications';
import { useSession } from './SessionProvider';
import { ThemeToggle } from './ThemeToggle';
import { Menu, ToastProvider } from './ui';
import {
  IconAccount,
  IconActivity,
  IconAgents,
  IconAIBuilder,
  IconAPI,
  IconAuth,
  IconBilling,
  IconCheck,
  IconChevronDown,
  IconCLI,
  IconCollapse,
  IconDatabase,
  IconExpand,
  IconFunctions,
  IconMenu,
  IconOrganizations,
  IconOverview,
  IconProjects,
  IconRealtime,
  IconSearch,
  IconSettings,
  IconShield,
  IconSQL,
  IconStorage,
  IconUsage,
  IconWorkflows,
} from './icons';

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (pathname: string) => boolean;
}

const WORKSPACE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: <IconOverview size={16} />, match: p => p === '/dashboard' },
  { href: '/projects', label: 'Projects', icon: <IconProjects size={16} />, match: p => p === '/projects' || p === '/projects/new' },
  { href: '/activity', label: 'Activity', icon: <IconActivity size={16} />, match: p => p === '/activity' },
  { href: '/organizations', label: 'Organizations', icon: <IconOrganizations size={16} />, match: p => p === '/organizations' },
  { href: '/account', label: 'Account', icon: <IconAccount size={16} />, match: p => p === '/account' },
];

const MANAGE_NAV: NavItem[] = [
  { href: '/security', label: 'Security', icon: <IconShield size={16} />, match: p => p === '/security' },
  { href: '/agents', label: 'Agent Access', icon: <IconAgents size={16} />, match: p => p === '/agents' },
  { href: '/billing', label: 'Billing', icon: <IconBilling size={16} />, match: p => p === '/billing' },
  { href: '/settings', label: 'Settings', icon: <IconSettings size={16} />, match: p => p === '/settings' },
];

interface ProjectChild {
  label: string;
  /** Same-page suffix: `?tab=<id>` for tabbed sections, `#<anchor>` for cards. */
  suffix: string;
  /** Optional subgroup label rendered Supabase-style (Manage, Configuration). */
  group?: string;
}

interface ProjectNavEntry {
  suffix: string;
  label: string;
  icon: React.ReactNode;
  children?: ProjectChild[];
}

const PROJECT_NAV: ProjectNavEntry[] = [
  {
    suffix: '/database', label: 'Database', icon: <IconDatabase size={16} />,
    children: [
      { label: 'Connection', suffix: '?tab=connection', group: 'Manage' },
      { label: 'Table editor', suffix: '?tab=tables', group: 'Manage' },
      { label: 'Routines', suffix: '?tab=routines', group: 'Manage' },
      { label: 'Extensions', suffix: '?tab=extensions', group: 'Configuration' },
      { label: 'Row-level security', suffix: '?tab=rls', group: 'Configuration' },
      { label: 'Replicas', suffix: '?tab=replicas', group: 'Configuration' },
      { label: 'Backups', suffix: '?tab=backups', group: 'Configuration' },
    ],
  },
  {
    suffix: '/api', label: 'API', icon: <IconAPI size={16} />,
    children: [
      { label: 'API keys', suffix: '#keys' },
      { label: 'Try it', suffix: '#request' },
      { label: 'Endpoints', suffix: '#endpoints' },
      { label: 'OpenAPI', suffix: '#openapi' },
    ],
  },
  {
    suffix: '/auth', label: 'Authentication', icon: <IconAuth size={16} />,
    children: [
      { label: 'Overview', suffix: '?tab=overview' },
      { label: 'Users', suffix: '?tab=users', group: 'Manage' },
      { label: 'Sessions', suffix: '?tab=sessions', group: 'Manage' },
      { label: 'MFA', suffix: '?tab=mfa', group: 'Manage' },
      { label: 'Sign-in methods', suffix: '?tab=signin', group: 'Configuration' },
      { label: 'Security', suffix: '?tab=security', group: 'Configuration' },
    ],
  },
  {
    suffix: '/storage', label: 'Storage', icon: <IconStorage size={16} />,
    children: [
      { label: 'Buckets', suffix: '#buckets', group: 'Manage' },
      { label: 'Files', suffix: '#objects', group: 'Manage' },
      { label: 'Access', suffix: '#policies', group: 'Configuration' },
    ],
  },
  {
    suffix: '/realtime', label: 'Realtime', icon: <IconRealtime size={16} />,
    children: [
      { label: 'Monitor', suffix: '' },
      { label: 'Broadcast', suffix: '#broadcast' },
    ],
  },
  { suffix: '/functions', label: 'Functions', icon: <IconFunctions size={16} /> },
  { suffix: '/automations', label: 'Automations', icon: <IconWorkflows size={16} /> },
  { suffix: '/metrics', label: 'Metrics', icon: <IconUsage size={16} /> },
];

const DEVELOPMENT: { suffix: string | null; label: string; icon: React.ReactNode }[] = [
  { suffix: '/sql', label: 'SQL Editor', icon: <IconSQL size={16} /> },
  { suffix: '/ai', label: 'AI Builder', icon: <IconAIBuilder size={16} /> },
  { suffix: null, label: 'CLI & SDK', icon: <IconCLI size={16} /> },
];

/**
 * Routes that render WITHOUT the workspace chrome: the marketing home and
 * every page of the signed-out auth flow. A page missing from this list
 * renders its auth card inside the signed-in sidebar and top bar, which is
 * how /forgot-password and /reset-password first shipped — so any new page
 * in the auth flow belongs here, and tests/e2e/password-reset.spec.ts
 * asserts the whole flow stays bare.
 */
const BARE_ROUTES = new Set([
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
]);

function isAuthRoute(pathname: string): boolean {
  return BARE_ROUTES.has(pathname);
}

function projectIdFromPath(pathname: string): string | null {
  const m = /^\/projects\/([^/]+)/.exec(pathname);
  return m?.[1] && m[1] !== 'new' ? (m[1] as string) : null;
}

/** Bucket children into ungrouped-first, then subgroups in first-seen order. */
function groupNavChildren(children: ProjectChild[]): { label: string | null; items: ProjectChild[] }[] {
  const groups: { label: string | null; items: ProjectChild[] }[] = [];
  for (const c of children) {
    const label = c.group ?? null;
    let bucket = groups.find(g => g.label === label);
    if (!bucket) {
      bucket = { label, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(c);
  }
  return groups;
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
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('cn_sidebar') === 'collapsed';
  });
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  const toggleSidebar = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem('cn_sidebar', next ? 'collapsed' : 'expanded');
      } catch {
        // Private browsing: the toggle still works for this session.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
    if (!ready || orgs.length === 0) return;
    const persisted = getSelectedOrg();
    if (persisted && orgs.some(o => o.id === persisted)) {
      if (persisted !== orgId) setOrgId(persisted);
      return;
    }
    if (!persisted) {
      const fallback = orgs[0]?.id ?? null;
      setOrgId(fallback);
      setSelectedOrg(fallback);
    } else {
      setOrgId(null);
      setSelectedOrg(null);
    }
  }, [ready, orgs, orgId]);

  useEffect(() => {
    const fromPath = projectIdFromPath(pathname);
    if (fromPath && fromPath !== getSelectedProject()) {
      setProjectId(fromPath);
      setSelectedProject(fromPath);
      const known = projects.find(p => p.id === fromPath);
      if (known && known.organizationId !== getSelectedOrg()) {
        setOrgId(known.organizationId);
        setSelectedOrg(known.organizationId);
      }
    }
  }, [pathname, projects]);

  const org = orgs.find(o => o.id === orgId) ?? orgs[0] ?? null;
  const project = projects.find(p => p.id === projectId) ?? null;
  const viewingProject = projectIdFromPath(pathname)
    ? (projects.find(p => p.id === projectIdFromPath(pathname)) ?? project)
    : null;
  const orgProjects = org ? projects.filter(p => p.organizationId === org.id) : projects;
  /** Project scoping the resource/development nav: the viewed project, else the selected one. */
  const scopeProject = viewingProject ?? project;
  const projHref = (suffix: string): string => (scopeProject ? `/projects/${scopeProject.id}${suffix}` : '/projects');
  const projActive = (suffix: string): boolean | undefined => {
    if (!scopeProject) return undefined;
    const href = `/projects/${scopeProject.id}${suffix}`;
    return pathname === href || pathname.startsWith(`${href}/`) ? true : undefined;
  };
  const usageHref = scopeProject ? `/projects/${scopeProject.id}/usage` : '/projects';

  /* Nested-nav signals: shared tab (?tab=) + location hash (#anchor). */
  const sectionTab = useSyncExternalStore(subscribeSectionTab, getSectionTab, () => null);
  const [hash, setHash] = useState('');
  useEffect(() => {
    const sync = (): void => {
      try {
        setHash(window.location.hash);
      } catch {
        setHash('');
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [pathname]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      if (typeof window === 'undefined') return {};
      return (JSON.parse(window.localStorage.getItem('cn_nav_expanded') ?? '{}') ?? {}) as Record<string, boolean>;
    } catch {
      return {};
    }
  });

  function groupActive(entry: ProjectNavEntry): boolean {
    if (!scopeProject) return false;
    const href = `/projects/${scopeProject.id}${entry.suffix}`;
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  function isOpen(entry: ProjectNavEntry): boolean {
    return expanded[entry.suffix] ?? groupActive(entry);
  }
  function toggleGroup(entry: ProjectNavEntry): void {
    setExpanded(prev => {
      const next = { ...prev, [entry.suffix]: !isOpen(entry) };
      try {
        window.localStorage.setItem('cn_nav_expanded', JSON.stringify(next));
      } catch {
        // Private browsing: expansion still works for this session.
      }
      return next;
    });
  }
  function childActive(entry: ProjectNavEntry, child: ProjectChild): boolean {
    if (!scopeProject) return false;
    const base = `/projects/${scopeProject.id}${entry.suffix}`;
    if (pathname !== base) return false;
    if (child.suffix.startsWith('?tab=')) {
      return (sectionTab ?? 'overview') === child.suffix.slice('?tab='.length);
    }
    if (child.suffix.startsWith('#')) return hash === child.suffix;
    return hash === '';
  }

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
    const known = projects.find(p => p.id === id);
    if (known) {
      setOrgId(known.organizationId);
      setSelectedOrg(known.organizationId);
    }
    router.push(`/projects/${id}`);
  }

  function doLogout(): void {
    logout();
    setSelectedProject(null);
    router.replace('/login');
  }

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}${navOpen ? ' nav-open' : ''}`}>
      <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
      <aside className="sidebar" aria-label="Sidebar">
        <button
          type="button"
          className="rail-toggle"
          onClick={toggleSidebar}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <IconExpand size={15} /> : <IconCollapse size={15} />}
        </button>
        <Link className="brand" href="/dashboard" aria-label="CloudNivo home">
          <span className="brand-mark">
            <LogoMark size={15} />
          </span>
          <span className="brand-text">CloudNivo</span>
        </Link>

        <div className="only-mobile">
          <p className="nav-label">Organization</p>
          <OrgMenu org={org} orgs={orgs} onPick={pickOrg} />
          <p className="nav-label">Project</p>
          <ProjectMenu project={project} projects={orgProjects} onPick={pickProject} />
        </div>

        {viewingProject ? (
          <div className="nav-project-tag" aria-label={`Current project: ${viewingProject.name}`}>
            <span className="dot ok" aria-hidden />
            <span className="grow">{viewingProject.name}</span>
            <Link href="/projects">All</Link>
          </div>
        ) : null}

        <nav className="nav" aria-label="Primary">
          <div className="nav-group">
            <p className="nav-context">Workspace</p>
            {WORKSPACE_NAV.map(l => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={l.match(pathname) ? 'page' : undefined}
                aria-label={l.label}
              >
                <span className="nav-icon" aria-hidden>
                  {l.icon}
                </span>
                <span className="nav-text">{l.label}</span>
              </Link>
            ))}
          </div>
          <div className="nav-group">
            <p className="nav-context">Resources</p>
            {PROJECT_NAV.map(r => {
              const hasKids = !!r.children && !!scopeProject;
              const active = projActive(r.suffix);
              const open = hasKids && isOpen(r);
              if (!hasKids) {
                return (
                  <Link key={r.suffix} href={projHref(r.suffix)} aria-current={active} aria-label={r.label}>
                    <span className="nav-icon" aria-hidden>
                      {r.icon}
                    </span>
                    <span className="nav-text">{r.label}</span>
                  </Link>
                );
              }
              const hasTabs = r.children?.some(c => c.suffix.startsWith('?tab=')) ?? false;
              return (
                <div key={r.suffix} className="nav-parent" data-open={open ? 'true' : 'false'}>
                  <div className="nav-parent-row">
                    <Link
                      href={projHref(r.suffix)}
                      aria-current={active}
                      aria-label={r.label}
                      onClick={hasTabs ? () => setSectionTab(null) : undefined}
                    >
                      <span className="nav-icon" aria-hidden>
                        {r.icon}
                      </span>
                      <span className="nav-text">{r.label}</span>
                    </Link>
                    <button
                      type="button"
                      className="nav-toggle"
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${r.label} submenu`}
                      onClick={() => toggleGroup(r)}
                    >
                      <IconChevronDown size={14} />
                    </button>
                  </div>
                  <div className="nav-children">
                    <div className="nav-children-inner">
                      {groupNavChildren(r.children ?? []).map((g, gi) => (
                        <Fragment key={g.label ?? `top-${gi}`}>
                          {g.label ? (
                            <p className="nav-sublabel" aria-hidden>
                              {g.label}
                            </p>
                          ) : null}
                          {g.items.map(c => (
                            <Link
                              key={c.suffix === '' ? `${r.suffix}#top` : c.suffix}
                              className="nav-child"
                              href={`${projHref(r.suffix)}${c.suffix}`}
                              aria-current={childActive(r, c) ? 'page' : undefined}
                              onClick={
                                c.suffix.startsWith('?tab=')
                                  ? () => setSectionTab(c.suffix.slice('?tab='.length))
                                  : undefined
                              }
                            >
                              <span className="nav-text">{c.label}</span>
                            </Link>
                          ))}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="nav-group">
            <p className="nav-context">Development</p>
            {DEVELOPMENT.map(d =>
              d.suffix === null ? (
                <Link
                  key="cli"
                  href="/developer"
                  aria-current={pathname === '/developer' ? 'page' : undefined}
                  aria-label={d.label}
                >
                  <span className="nav-icon" aria-hidden>
                    {d.icon}
                  </span>
                  <span className="nav-text">{d.label}</span>
                </Link>
              ) : (
                <Link key={d.suffix} href={projHref(d.suffix)} aria-current={projActive(d.suffix)} aria-label={d.label}>
                  <span className="nav-icon" aria-hidden>
                    {d.icon}
                  </span>
                  <span className="nav-text">{d.label}</span>
                </Link>
              ),
            )}
          </div>
          <div className="nav-group">
            <p className="nav-context">Management</p>
            <Link
              href={usageHref}
              aria-label="Usage"
              aria-current={
                scopeProject && (pathname === usageHref || pathname.startsWith(`${usageHref}/`))
                  ? 'page'
                  : undefined
              }
            >
              <span className="nav-icon" aria-hidden>
                <IconUsage size={16} />
              </span>
              <span className="nav-text">Usage</span>
            </Link>
            {MANAGE_NAV.map(l => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={l.match(pathname) ? 'page' : undefined}
                aria-label={l.label}
              >
                <span className="nav-icon" aria-hidden>
                  {l.icon}
                </span>
                <span className="nav-text">{l.label}</span>
              </Link>
            ))}
          </div>
          {/*
            Platform group. Rendered only for staff — not as a security
            control (the API answers 404 to everyone else) but because a
            sidebar entry that leads to "not available" is worse than no
            entry. The flag comes from /api/v1/me, re-read each session.
          */}
          {user?.isPlatformAdmin ? (
            <div className="nav-group">
              <p className="nav-context">Platform</p>
              <Link
                href="/admin"
                aria-current={pathname === '/admin' ? 'page' : undefined}
                aria-label="Operator console"
              >
                <span className="nav-icon" aria-hidden>
                  <IconShield size={16} />
                </span>
                <span className="nav-text">Operator console</span>
              </Link>
            </div>
          ) : null}
        </nav>

        <div className="sidebar-foot">
          <ThemeToggle />
        </div>
      </aside>
      <div className="content">
        <header className="topbar" aria-label="Workspace">
          <button
            type="button"
            className="icon-btn only-mobile"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
            onClick={() => setNavOpen(o => !o)}
          >
            <IconMenu size={18} />
          </button>
          <div className="topbar-switchers only-desktop">
            <OrgMenu org={org} orgs={orgs} onPick={pickOrg} />
            <ProjectMenu project={project} projects={orgProjects} onPick={pickProject} />
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="search-trigger topbar-search"
            onClick={openPalette}
            aria-label="Open command palette"
          >
            <IconSearch size={16} />
            <span className="search-text" style={{ flex: 1, textAlign: 'left' }}>
              Search…
            </span>
            <span className="kbd-inline">⌘K</span>
          </button>
          <Notifications />
          <AccountMenu
            email={user?.email ?? null}
            onLogout={doLogout}
            onAccount={() => router.push('/account')}
          />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
          <IconChevronDown size={14} />
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
          {o.id === org.id ? (
            <span className="sel" aria-hidden>
              <IconCheck size={13} />
            </span>
          ) : null}
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
          <IconChevronDown size={14} />
        </>
      }
    >
      {projects.map(p => (
        <button key={p.id} type="button" role="menuitem" onClick={() => onPick(p.id)}>
          <span className="grow">
            {p.name}
            <span className="sub">{p.slug}</span>
          </span>
          {p.id === project.id ? (
            <span className="sel" aria-hidden>
              <IconCheck size={13} />
            </span>
          ) : null}
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
      button={
        <>
          <span className="avatar" aria-hidden>
            {email.slice(0, 1)}
          </span>
          <span className="grow account-email">
            {email}
          </span>
        </>
      }
    >
      <button type="button" role="menuitem" onClick={onAccount}>
        <IconAccount size={14} aria-hidden />
        Account settings
      </button>
      <button type="button" role="menuitem" onClick={onLogout}>
        Log out
      </button>
    </Menu>
  );
}