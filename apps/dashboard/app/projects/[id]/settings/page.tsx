'use client';

import { useRouter } from 'next/navigation';
import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { setSelectedProject } from '../../../../lib/selection';
import {
  ENV_SLUG_RE,
  createEnvironment,
  deleteEnvironment,
  envKind,
  envKindLabel,
  getActiveEnvironmentId,
  listBranches,
  listEnvironments,
  pinEnvironmentBranch,
  setActiveEnvironmentId,
  type DbBranchLite,
  type DbEnvironment,
} from '../../../../lib/environments';
import { ErrorState, EmptyState, LoadingSkeleton } from '../../../../components/States';
import { Modal, StatusDot, useToast } from '../../../../components/ui';
import { SectionCapabilities } from '../../../../components/SectionCapabilities';
import { BranchesPanel, DbToolsPanel, VaultPanel } from '../../../../components/AdvancedPanels';

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
  if (error && !project) return <ErrorState title="Couldn't load project settings" message={error} />;
  if (!project) return <LoadingSkeleton label="Loading settings" />;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <div className="section-head">
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

      <EnvironmentsCard projectId={project.id} />

      <BranchesPanel projectId={project.id} />

      <VaultPanel projectId={project.id} />

      <DbToolsPanel projectId={project.id} />

      <SectionCapabilities category="Environments" projectId={project.id} />

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
        {error && project ? <ErrorState title="Couldn't delete project" message={error} /> : null}
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

function EnvironmentsCard({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [envs, setEnvs] = useState<DbEnvironment[] | null>(null);
  const [branches, setBranches] = useState<DbBranchLite[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [preview, setPreview] = useState(true);
  const [deleting, setDeleting] = useState<DbEnvironment | null>(null);

  const load = useCallback(async () => {
    const [e, b] = await Promise.all([listEnvironments(projectId), listBranches(projectId)]);
    if (!e.ok) {
      if (e.status === 404) setUnsupported(true);
      else setError(e.error ?? 'Could not load environments');
      return;
    }
    setUnsupported(false);
    setEnvs(e.envs ?? []);
    if (b.ok) setBranches(b.branches);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    const cleanName = name.trim();
    const cleanSlug = slug.trim().toLowerCase();
    if (!cleanName || !ENV_SLUG_RE.test(cleanSlug)) return;
    setBusy(true);
    const r = await createEnvironment(projectId, { name: cleanName, slug: cleanSlug, preview });
    setBusy(false);
    if (!r.ok || !r.env) {
      setError(r.error ?? 'Create failed');
      return;
    }
    setName('');
    setSlug('');
    setPreview(true);
    toast(`Environment ${r.env.name} created`, 'ok');
    void load();
  }

  async function pin(env: DbEnvironment, branchId: string | null): Promise<void> {
    const r = await pinEnvironmentBranch(projectId, env.id, branchId);
    if (!r.ok) {
      setError(r.error ?? 'Branch pin failed');
      return;
    }
    toast(branchId ? `${env.name} pinned to branch` : `${env.name} back on main`, 'ok');
    void load();
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    const r = await deleteEnvironment(projectId, deleting.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Delete failed');
      return;
    }
    if (getActiveEnvironmentId(projectId) === deleting.id) setActiveEnvironmentId(projectId, null);
    toast(`Environment ${deleting.name} deleted`, 'ok');
    setDeleting(null);
    void load();
  }

  const slugValid = slug.trim().length === 0 || ENV_SLUG_RE.test(slug.trim().toLowerCase());

  return (
    <div className="card" id="environments">
      <div className="section-head">
        <h2 style={{ fontSize: 15 }}>Environments</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Environments pin this project to a database branch (or main). The header switcher shows the
        active one — production never shares styling with previews.
      </p>
      {unsupported ? (
        <EmptyState
          title="Environments need a newer API"
          hint="This backend predates database environments (Phase 15). Connect staging or upgrade the API to manage them."
        />
      ) : error && envs === null ? (
        <ErrorState title="Couldn't load environments" message={error} retry={() => void load()} />
      ) : envs === null ? (
        <LoadingSkeleton label="Loading environments" rows={2} />
      ) : envs.length === 0 ? (
        <EmptyState
          title="No environments yet"
          hint="Create one (for example production, or a preview) to pin this project to a database branch."
        />
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {envs.map(e => {
            const kind = envKind(e);
            return (
              <div key={e.id} className="env-row">
                <StatusDot
                  tone={kind === 'production' ? 'bad' : kind === 'preview' ? 'warn' : 'ok'}
                />
                <span className="grow">
                  <strong>{e.name}</strong> <code>{e.slug}</code>{' '}
                  <span className={`badge env-${kind}`}>{envKindLabel(kind)}</span>
                </span>
                <label className="muted" htmlFor={`branch-${e.id}`}>
                  Branch
                </label>
                <select
                  id={`branch-${e.id}`}
                  value={e.branchId ?? ''}
                  onChange={ev => void pin(e, ev.target.value === '' ? null : ev.target.value)}
                  aria-label={`Database branch for ${e.name}`}
                >
                  <option value="">Main database</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.status})
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => setDeleting(e)}>
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error && envs !== null ? (
        <ErrorState title="Environment action failed" message={error} />
      ) : null}
      {!unsupported ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <div className="field" style={{ flex: '2 1 160px', margin: 0 }}>
            <label htmlFor="env-name">Name</label>
            <input
              id="env-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Production"
              autoComplete="off"
              maxLength={100}
            />
          </div>
          <div className="field" style={{ flex: '2 1 140px', margin: 0 }}>
            <label htmlFor="env-slug">Slug</label>
            <input
              id="env-slug"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="production"
              autoComplete="off"
              maxLength={63}
              aria-invalid={!slugValid}
            />
            {!slugValid ? <p className="hint">Lowercase letters, digits, dashes.</p> : null}
          </div>
          <div
            className="field"
            style={{ flex: '0 1 auto', margin: 0, justifyContent: 'flex-end' }}
          >
            <label htmlFor="env-preview">
              <input
                id="env-preview"
                type="checkbox"
                checked={preview}
                onChange={e => setPreview(e.target.checked)}
              />{' '}
              Preview (auto-branch)
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || name.trim().length === 0 || !slugValid || slug.trim().length === 0}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create environment'}
            </button>
          </div>
        </div>
      ) : null}
      {deleting ? (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p className="muted">
            Removes the environment pointer only — its branch database is kept. Team members viewing
            this environment fall back to the project default.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Delete environment'}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
