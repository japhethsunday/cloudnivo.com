'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { getSelectedOrg, setSelectedOrg, setSelectedProject } from '../../../lib/selection';
import { RequireAuth } from '../../../components/RequireAuth';
import { EmptyState, ErrorState } from '../../../components/States';

interface Org {
  id: string;
  name: string;
  slug: string;
}

type Stage = 'details' | 'provisioning' | 'done' | 'failed';

const REGIONS = ['local', 'eu-west', 'us-east', 'us-west', 'ap-south'];

export default function NewProjectPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <Wizard />
    </RequireAuth>
  );
}

function Wizard(): React.JSX.Element {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [region, setRegion] = useState('local');
  const [stage, setStage] = useState<Stage>('details');
  const [status, setStatus] = useState('creating');
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOrgs = useCallback(async () => {
    const r = await apiFetch<{ organizations: Org[] }>('/api/v1/organizations');
    if (r.ok && r.data) {
      setOrgs(r.data.organizations);
      const preferred = getSelectedOrg();
      const first = r.data.organizations.find(o => o.id === preferred) ?? r.data.organizations[0];
      if (first) setOrgId(first.id);
    } else {
      setOrgs([]);
    }
  }, []);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  function autoSlug(value: string): void {
    setName(value);
    setSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40),
    );
  }

  async function pollJob(pid: string, jobId: string): Promise<void> {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const j = await apiFetch<{ job: { status: string; lastError?: string } }>(
        `/api/v1/projects/${pid}/jobs/${jobId}`,
      );
      const st = j.ok && j.data ? j.data.job.status : 'pending';
      setStatus(st);
      if (st === 'completed') {
        setStage('done');
        return;
      }
      if (st === 'failed') {
        setError(j.ok && j.data?.job.lastError ? j.data.job.lastError : 'Provisioning failed');
        setStage('failed');
        return;
      }
      if (Date.now() > deadline) {
        setError('Provisioning is taking longer than expected — check the project page for live status.');
        setStage('failed');
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ project: { id: string }; jobId: string }>('/api/v1/projects', {
      method: 'POST',
      body: { name, slug, organizationId: orgId, region },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Creation failed');
      return;
    }
    setProjectId(res.data.project.id);
    setSelectedProject(res.data.project.id);
    // Keep the persisted workspace scope on the org the project was created
    // in — otherwise the projects list filter (and sidebar) keep pointing at
    // the previously selected org and the new project looks unopenable.
    setSelectedOrg(orgId);
    setStage('provisioning');
    setStatus('creating');
    await pollJob(res.data.project.id, res.data.jobId);
  }

  return (
    <section aria-labelledby="new-title" style={{ maxWidth: 640 }}>
      <p className="crumbs">
        <Link href="/projects">Projects</Link> <span aria-hidden>›</span> New project
      </p>
      <h1 id="new-title" style={{ marginTop: 0 }}>
        Create project
      </h1>

      {orgs !== null && orgs.length === 0 ? (
        <EmptyState
          title="Create an organization first"
          hint="Projects live inside organizations."
          action={
            <Link className="btn btn-primary" href="/organizations">
              Create organization
            </Link>
          }
        />
      ) : stage === 'details' ? (
        <form onSubmit={submit} className="card" aria-label="New project details">
          <div className="field">
            <label htmlFor="np-org">1 · Organization</label>
            <select
              id="np-org"
              value={orgId}
              onChange={e => {
                setOrgId(e.target.value);
                // Persist immediately so a reload mid-wizard keeps the scope.
                setSelectedOrg(e.target.value || null);
              }}
              required
            >
              {(orgs ?? []).map(o => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.slug})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-name">2 · Project name</label>
            <input
              id="np-name"
              required
              minLength={2}
              value={name}
              onChange={e => autoSlug(e.target.value)}
              placeholder="Acme shop"
            />
          </div>
          <div className="field">
            <label htmlFor="np-slug">Slug</label>
            <input
              id="np-slug"
              required
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
              value={slug}
              onChange={e => setSlug(e.target.value)}
            />
            <span className="hint">Used in database names. Lowercase, hyphens allowed.</span>
          </div>
          <div className="field">
            <label htmlFor="np-region">3 · Environment / region</label>
            <select id="np-region" value={region} onChange={e => setRegion(e.target.value)}>
              {REGIONS.map(r => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          {error ? <ErrorState message={error} /> : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !orgId}>
            {busy ? 'Creating…' : '4 · Create project and provision'}
          </button>
        </form>
      ) : (
        <div className="card">
          <ol className="steps" aria-live="polite">
            <li className="done">
              <div>
                <div className="t">Project created</div>
                <div className="d">Record stored in your organization.</div>
              </div>
            </li>
            <li className={stage === 'provisioning' ? 'active' : stage === 'done' ? 'done' : 'failed'}>
              <div>
                <div className="t">Provisioning infrastructure</div>
                <div className="d">
                  {stage === 'provisioning'
                    ? `Isolated PostgreSQL is being provisioned… (${status})`
                    : stage === 'done'
                      ? 'Database is running and healthy.'
                      : (error ?? 'Provisioning failed.')}
                </div>
              </div>
            </li>
            <li className={stage === 'done' ? 'done' : ''}>
              <div>
                <div className="t">Project ready</div>
                <div className="d">Open the workspace to build.</div>
              </div>
            </li>
          </ol>
          {stage === 'failed' && error ? <ErrorState message={error} /> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {stage === 'done' && projectId ? (
              <button type="button" className="btn btn-primary" onClick={() => router.push(`/projects/${projectId}`)}>
                Open project
              </button>
            ) : null}
            {stage === 'failed' && projectId ? (
              <>
                <button type="button" className="btn btn-primary" onClick={() => router.push(`/projects/${projectId}`)}>
                  Open project anyway
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setStage('details');
                    setError(null);
                  }}
                >
                  Back to details
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
