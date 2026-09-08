'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { CreateProjectForm, TokenBar } from '../../components/ProjectForms';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';

interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  database: { status: string; health?: string } | null;
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

export default function ProjectsPage(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, o] = await Promise.all([
      apiFetch<{ projects: Project[] }>('/api/v1/projects'),
      apiFetch<{ organizations: Org[] }>('/api/v1/organizations'),
    ]);
    if (!p.ok) setError(p.error);
    else setProjects(p.data?.projects ?? []);
    if (o.ok && o.data) setOrgs(o.data.organizations);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="projects-title">
      <div className="topbar">
        <div>
          <h1 id="projects-title" style={{ margin: 0 }}>
            Projects
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            Each project gets an isolated PostgreSQL, provisioned via Docker.
          </p>
        </div>
      </div>
      <TokenBar onChange={() => void load()} />
      {error ? <ErrorState message={error} /> : null}
      {!projects ? (
        <LoadingSkeleton label="Loading projects" />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects in your organizations"
          hint="Projects are always scoped to an organization — you can never see another org's projects."
        />
      ) : (
        <div className="grid">
          {projects.map(p => (
            <div className="card" key={p.id}>
              <strong>
                <Link href={`/projects/${p.id}`}>{p.name}</Link>
              </strong>
              <p className="muted">
                {p.slug} · {p.region} · db: {p.database ? `${p.database.status}` : 'provisioning…'}
              </p>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <CreateProjectForm orgs={orgs} onCreated={() => void load()} />
      </div>
    </section>
  );
}
