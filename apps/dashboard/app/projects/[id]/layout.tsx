'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { setSelectedProject } from '../../../lib/selection';
import { RequireAuth } from '../../../components/RequireAuth';
import { EnvSwitcher } from '../../../components/EnvSwitcher';
import { ErrorState, LoadingSkeleton } from '../../../components/States';
import { CopyField, Menu, statusTone } from '../../../components/ui';
import { databaseState, type ProvisionJobLike } from '../../../lib/dbstate';
import { IconSettings } from '../../../components/icons';
import { ConnectDialog } from '../../../components/ConnectDialog';

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
  const [connectOpen, setConnectOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [database, setDatabase] = useState<ProjectDatabase | null>(null);
  const [job, setJob] = useState<ProvisionJobLike | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const status = databaseState(database, job).label;
  const health = database?.health ?? 'unknown';
  const healthLabel =
    health === 'healthy' ? 'Healthy' : health === 'unknown' ? 'Health unknown' : health;

  return (
    <section aria-labelledby="ws-title">
      {/*
        The page no longer repeats the project's name or its section list.
        The top bar's breadcrumb already says which organization and project
        you are in and carries Connect; the sidebar carries every section.
        What is left here is the one thing neither of those can show: the
        project's live infrastructure state, in the state's own words.
      */}
      <div className="ws-strip">
        <h1 id="ws-title" className="ws-strip-name">
          {project.name}
        </h1>
        <span className={`state-word state-${statusTone(status)}`}>{status}</span>
        <span className={`state-word state-${statusTone(health)}`}>{healthLabel}</span>
        <EnvSwitcher projectId={project.id} region={project.region} />
        <span className="grow" />
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
          className="icon-btn icon-btn-sm"
          href={`${base}/settings`}
          aria-label="Project settings"
          title="Project settings"
        >
          <IconSettings size={15} />
        </Link>
        {/*
          Kept on the page as well as in the top bar: this is the project's
          primary action, and the e2e suite opens the dialog from here.
        */}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setConnectOpen(true)}
        >
          Connect
        </button>
      </div>
      {connectOpen && project ? (
        <ConnectDialog
          projectId={project.id}
          projectName={project.name}
          onClose={() => setConnectOpen(false)}
        />
      ) : null}
      {children}
    </section>
  );
}
