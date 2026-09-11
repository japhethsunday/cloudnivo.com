'use client';

import { useRouter } from 'next/navigation';
import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { setSelectedProject } from '../../../../lib/selection';
import { ErrorState, LoadingSkeleton } from '../../../../components/States';
import { useToast } from '../../../../components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  status: string;
  organizationId: string;
  createdAt: string;
}

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiFetch<{ project: Project }>(`/api/v1/projects/${id}`);
    if (!r.ok) setError(r.error ?? 'Project not found');
    else if (r.data) setProject(r.data.project);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(): Promise<void> {
    if (!project || confirm !== project.slug) return;
    setBusy(true);
    const r = await apiFetch(`/api/v1/projects/${id}`, { method: 'DELETE' });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Delete failed');
      return;
    }
    setSelectedProject(null);
    toast('Project deleted', 'ok');
    router.replace('/projects');
  }

  if (error && !project) return <ErrorState message={error} />;
  if (!project) return <LoadingSkeleton label="Loading settings" />;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Settings</h2>
        <p>Identity, environment, and the danger zone. Destructive actions always ask for confirmation.</p>
      </div>
      <div className="card">
        <div className="section-head">
          <h2 style={{ fontSize: 15 }}>General</h2>
        </div>
        <dl className="fact-grid">
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Slug</dt>
          <dd>
            <code>{project.slug}</code>
          </dd>
          <dt>Project ID</dt>
          <dd>
            <code>{project.id}</code>
          </dd>
          <dt>Region</dt>
          <dd>{project.region}</dd>
          <dt>Status</dt>
          <dd>{project.status}</dd>
          <dt>Created</dt>
          <dd>{project.createdAt ? new Date(project.createdAt).toLocaleString() : '—'}</dd>
        </dl>
      </div>

      <div className="card" style={{ borderColor: 'var(--danger)' }}>
        <h2 style={{ marginTop: 0 }}>Danger zone</h2>
        <p className="muted">
          Deleting a project removes its database, storage objects, functions, and keys. This cannot be undone.
        </p>
        <div className="field">
          <label htmlFor="del-confirm">
            Type <code>{project.slug}</code> to confirm
          </label>
          <input id="del-confirm" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" />
        </div>
        {error && project ? <ErrorState message={error} /> : null}
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || confirm !== project.slug}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete project'}
        </button>
      </div>
    </div>
  );
}
