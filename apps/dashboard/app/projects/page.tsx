'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg, setSelectedOrg } from '../../lib/selection';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingCards } from '../../components/States';
import { ProjectCard, type ProjectCardData } from '../../components/ProjectCard';

interface Org {
  id: string;
  name: string;
  slug: string;
}

export default function ProjectsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <ProjectsBody />
    </RequireAuth>
  );
}

function ProjectsBody(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectCardData[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [p, o] = await Promise.all([
      apiFetch<{ projects: ProjectCardData[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
    ]);
    if (!p.ok) {
      setError(p.error ?? 'Could not load projects');
      setProjects([]);
    } else {
      setProjects(p.data?.projects ?? []);
    }
    if (o.ok && o.data) {
      setOrgs(o.data.organizations);
      // Respect the persisted workspace selection, but never strand the user
      // on an empty scope: fall back to "all" when the selected org is gone.
      const preferred = getSelectedOrg();
      if (preferred && o.data.organizations.some(x => x.id === preferred)) {
        setFilter(preferred);
      } else {
        setFilter('');
        setSelectedOrg(null);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orgNameOf = useCallback(
    (id: string) => orgs.find(o => o.id === id)?.name,
    [orgs],
  );

  const visible = useMemo(() => {
    const scoped = filter ? (projects ?? []).filter(p => p.organizationId === filter) : (projects ?? []);
    const q = query.trim().toLowerCase();
    const searched = q
      ? scoped.filter(p => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
      : scoped;
    return [...searched].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, filter, query]);

  const hiddenByScope = (projects ?? []).length > 0 && filter !== '' && visible.length === 0 && query.trim() === '';

  return (
    <section aria-labelledby="projects-title">
      <div className="page-head">
        <div>
          <h1 id="projects-title">Projects</h1>
          <p className="sub muted">
            Each project is an isolated backend — PostgreSQL, APIs, auth, storage, realtime, functions.
          </p>
        </div>
        <Link className="btn btn-primary" href="/projects/new">
          New project
        </Link>
      </div>

      {error ? <ErrorState message={error} retry={() => void load()} /> : null}

      {!projects ? (
        <LoadingCards label="Loading projects" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="⬣"
          title={orgs.length === 0 ? 'Create an organization first' : 'No projects yet'}
          hint={
            orgs.length === 0
              ? 'Projects live inside organizations. Create one to get started — it takes ten seconds.'
              : 'Create an isolated CloudNivo backend with PostgreSQL, APIs, authentication, storage, realtime and serverless functions.'
          }
          action={
            <Link className="btn btn-primary" href={orgs.length === 0 ? '/organizations' : '/projects/new'}>
              {orgs.length === 0 ? 'Create organization' : 'Create project'}
            </Link>
          }
          secondary={
            orgs.length === 0 ? null : (
              <Link className="btn" href="/developer">
                Explore CLI &amp; SDK
              </Link>
            )
          }
        />
      ) : (
        <>
          <div className="toolbar" role="search">
            <div className="search">
              <span className="icon" aria-hidden>
                ⌕
              </span>
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search projects…"
                aria-label="Search projects"
              />
            </div>
            {orgs.length > 1 ? (
              <select
                value={filter}
                onChange={e => {
                  setFilter(e.target.value);
                  setSelectedOrg(e.target.value || null);
                }}
                aria-label="Filter by organization"
              >
                <option value="">All organizations</option>
                {orgs.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="muted" style={{ fontSize: 13 }} aria-live="polite">
              {visible.length} of {projects.length}
            </span>
          </div>

          {hiddenByScope ? (
            <div className="banner info" role="status">
              <span aria-hidden>ⓘ</span>
              <div className="grow">
                <strong>No projects in this organization.</strong>
                <p>
                  Your other organizations hold {(projects ?? []).length} project
                  {(projects ?? []).length === 1 ? '' : 's'}. Switch the filter to find them.
                </p>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>
                Show all
              </button>
            </div>
          ) : null}

          {visible.length === 0 && !hiddenByScope ? (
            <EmptyState
              icon="⌕"
              title="No matching projects"
              hint={`Nothing matches “${query.trim()}”. Try a different name or slug.`}
              action={
                <button type="button" className="btn" onClick={() => setQuery('')}>
                  Clear search
                </button>
              }
            />
          ) : (
            <div className="proj-grid">
              {visible.map(p => (
                <ProjectCard key={p.id} project={{ ...p, orgName: orgNameOf(p.organizationId) }} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
