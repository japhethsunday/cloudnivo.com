'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getSelectedProject, setSelectedOrg, setSelectedProject } from '../lib/selection';

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
  region: string;
  organizationId: string;
}

interface OrgLite {
  id: string;
  name: string;
  slug: string;
}

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  keywords: string;
  run: () => void;
}

const PROJECT_SECTIONS = [
  { suffix: '', label: 'Project overview', icon: '◈' },
  { suffix: '/database', label: 'Database', icon: '▤' },
  { suffix: '/sql', label: 'SQL Editor', icon: '❯' },
  { suffix: '/api', label: 'API & keys', icon: '⎋' },
  { suffix: '/auth', label: 'Authentication', icon: '◉' },
  { suffix: '/storage', label: 'Storage', icon: '▦' },
  { suffix: '/realtime', label: 'Realtime', icon: '〜' },
  { suffix: '/functions', label: 'Functions', icon: 'λ' },
  { suffix: '/logs', label: 'Logs', icon: '☰' },
  { suffix: '/usage', label: 'Usage', icon: '◔' },
  { suffix: '/ai', label: 'AI Builder', icon: '✦' },
  { suffix: '/settings', label: 'Project settings', icon: '⚙' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [orgs, setOrgs] = useState<OrgLite[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    let live = true;
    void Promise.all([
      apiFetch<{ projects: ProjectLite[] }>('/api/v1/projects'),
      apiFetch<{ organizations: OrgLite[] }>('/api/v1/organizations'),
    ]).then(([p, o]) => {
      if (!live) return;
      if (p.ok && p.data) setProjects(p.data.projects);
      if (o.ok && o.data) setOrgs(o.data.organizations);
    });
    return () => {
      live = false;
    };
  }, [open ]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open ]);

  const selectedProject = projects.find(p => p.id === getSelectedProject()) ?? null;

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => (): void => {
      onClose();
      router.push(href);
    };
    const list: Command[] = [];
    const selected = projects.find(p => p.id === getSelectedProject()) ?? null;

    // Current-project sections (only when a project is selected).
    if (selected) {
      for (const s of PROJECT_SECTIONS) {
        list.push({
          id: `projsec:${s.suffix}`,
          group: `Project · ${selected.name}`,
          label: s.label,
          hint: selected.slug,
          icon: s.icon,
          keywords: `${selected.name} ${selected.slug} ${s.label}`,
          run: go(`/projects/${selected.id}${s.suffix}`),
        });
      }
    }

    // Project switching.
    for (const p of projects) {
      list.push({
        id: `open:${p.id}`,
        group: 'Projects',
        label: p.name,
        hint: `${p.slug} · ${p.region}`,
        icon: '⬣',
        keywords: `${p.name} ${p.slug} open project switch`,
        run: () => {
          setSelectedProject(p.id);
          setSelectedOrg(p.organizationId);
          onClose();
          router.push(`/projects/${p.id}`);
        },
      });
    }

    // Organizations.
    for (const o of orgs) {
      list.push({
        id: `org:${o.id}`,
        group: 'Organizations',
        label: `Switch to ${o.name}`,
        hint: o.slug,
        icon: '⛉',
        keywords: `${o.name} ${o.slug} organization switch workspace`,
        run: () => {
          setSelectedOrg(o.id);
          const first = projects.find(p => p.organizationId === o.id);
          setSelectedProject(first?.id ?? null);
          onClose();
          router.push('/dashboard');
        },
      });
    }

    // Creation + workspace destinations.
    list.push(
      {
        id: 'new-project',
        group: 'Actions',
        label: 'Create project',
        hint: 'provision infrastructure',
        icon: '+',
        keywords: 'create new project provision',
        run: go('/projects/new'),
      },
      {
        id: 'new-apikey',
        group: 'Actions',
        label: selected ? `Create API key in ${selected.name}` : 'Create API key',
        hint: selected?.slug ?? 'pick a project first',
        icon: '⚿',
        keywords: 'create api key token',
        run: go(selected ? `/projects/${selected.id}/api` : '/projects'),
      },
      {
        id: 'ai-builder',
        group: 'Actions',
        label: selected ? `Open AI Builder in ${selected.name}` : 'Open AI Builder',
        hint: 'describe → plan → approve → apply',
        icon: '✦',
        keywords: 'ai builder plan generate',
        run: go(selected ? `/projects/${selected.id}/ai` : '/projects'),
      },
      { id: 'go-activity', group: 'Go to', label: 'Activity', icon: '◷', keywords: 'activity recent events feed', run: go('/activity') },
      { id: 'go-agents', group: 'Go to', label: 'Agent Access', icon: '✦', keywords: 'agent access tokens claude permissions', run: go('/agents') },
      { id: 'go-billing', group: 'Go to', label: 'Billing', icon: '❏', keywords: 'billing plan subscription invoices usage', run: go('/billing') },
      { id: 'go-developer', group: 'Go to', label: 'CLI & SDK', icon: '❯', keywords: 'cli sdk developer tools docs', run: go('/developer') },
      { id: 'go-orgs', group: 'Go to', label: 'Organizations', icon: '⛉', keywords: 'organizations teams membership', run: go('/organizations') },
      { id: 'go-account', group: 'Go to', label: 'Account', icon: '☺', keywords: 'account profile security sessions', run: go('/account') },
      { id: 'go-settings', group: 'Go to', label: 'Settings', icon: '⚙', keywords: 'settings preferences appearance theme', run: go('/settings') },
    );
    return list;
  }, [projects, orgs, onClose, router]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter(c => c.keywords.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    : commands;
  const visible = filtered.slice(0, 60);
  const safeCursor = Math.min(cursor, Math.max(visible.length - 1, 0));

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor(c => Math.min(c + 1, visible.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(c => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        visible[safeCursor]?.run();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  if (!open) return null;

  let lastGroup = '';
  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <span className="icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search projects, organizations, actions…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-autocomplete="list"
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {visible.length === 0 ? (
            <p className="cmdk-empty">
              No matches for “{query}”. Try a project name, an organization, or an action like “create”.
            </p>
          ) : (
            visible.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {header ? <p className="cmdk-group">{header}</p> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === safeCursor}
                    className="cmdk-item"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => c.run()}
                  >
                    <span className="icon" aria-hidden>
                      {c.icon}
                    </span>
                    <span className="grow">{c.label}</span>
                    {c.hint ? <span className="sub">{c.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="cmdk-foot" aria-hidden>
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          {selectedProject ? <span>Project: {selectedProject.name}</span> : null}
        </div>
      </div>
    </div>
  );
}
