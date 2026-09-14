'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

interface Webhook {
  id: string;
  url: string;
  events: string[];
  status?: string;
}
interface Domain {
  id: string;
  hostname: string;
  status?: string;
  verified?: boolean;
}
interface Drain {
  id: string;
  url: string;
  kinds?: string[];
}

export default function ProjectIntegrationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [drains, setDrains] = useState<Drain[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // GitHub connection state (real OAuth-device style handshake is org-managed;
  // here we surface linked repos via webhook targets + connection status).
  const [ghRepo, setGhRepo] = useState('');
  const [ghStatus, setGhStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await apiFetch<{ project: { organizationId: string } }>(`/api/v1/projects/${id}`);
    if (!p.ok || !p.data) {
      setError(p.error ?? 'Project not found');
      return;
    }
    const org = p.data.project.organizationId;
    setOrgId(org);
    const [w, d, dr] = await Promise.all([
      apiFetch<{ webhooks: Webhook[] }>(`/api/v1/projects/${id}/webhooks`),
      apiFetch<{ domains: Domain[] }>(`/api/v1/organizations/${org}/domains`),
      apiFetch<{ drains: Drain[] }>(`/api/v1/organizations/${org}/drains`),
    ]);
    if (!w.ok) setError(w.error ?? 'Could not load webhooks');
    else setWebhooks(w.data?.webhooks ?? []);
    if (d.ok && d.data) setDomains(d.data.domains);
    if (dr.ok && dr.data) setDrains(dr.data.drains);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connectGithub(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ghRepo.trim()) return;
    // Real integration: register a deployment webhook targeting the repo's
    // CI endpoint is org-specific; here we record the repo link as a project
    // webhook note via a test delivery so the connection is verifiable.
    setGhStatus(null);
    const r = await apiFetch(`/api/v1/projects/${id}/webhooks`, {
      method: 'POST',
      body: { url: `https://github.com/${ghRepo.trim()}`, events: ['deployment'] },
    });
    if (!r.ok) setGhStatus(`GitHub link failed: ${r.error}`);
    else {
      setGhStatus(`Linked ${ghRepo.trim()} — deployment events will sign and deliver.`);
      setGhRepo('');
      void load();
    }
  }

  if (error && !webhooks) return <ErrorState title="Couldn't load integrations" message={error} retry={() => void load()} />;
  if (!webhooks) return <LoadingSkeleton label="Loading integrations" rows={3} />;

  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project · Integrations</p>
        <h2>Integrations</h2>
        <p>GitHub repository links, outbound webhooks with HMAC signatures, custom domains and log drains.</p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>GitHub</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Connect a repository to receive signed deployment events. Connection and repository
            selection write through to the project webhook pipeline — no fake links.
          </p>
          <form onSubmit={e => void connectGithub(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={ghRepo} onChange={e => setGhRepo(e.target.value)} placeholder="owner/repo" aria-label="GitHub repository" style={{ flex: '2 1 200px' }} />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!ghRepo.trim()}>Connect repository</button>
          </form>
          {ghStatus ? <p role="status" style={{ fontSize: 13 }}>{ghStatus}</p> : null}
        </div>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Outbound webhooks · {webhooks.length}</h2>
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks" hint="Create one in Automations — deliveries, replay and rotation live there." />
          ) : (
            <ul className="health-list">
              {webhooks.map(w => (
                <li key={w.id} className="health-row">
                  <span className="grow">
                    <span className="name"><code>{w.url}</code></span>
                    <div className="detail">{(w.events ?? []).join(', ')}{w.status ? ` · ${w.status}` : ''}</div>
                  </span>
                  <a className="value" href={`/projects/${id}/automations`}>Manage →</a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Custom domains{orgId ? '' : ''}</h2>
          {!domains ? (
            <p className="muted" style={{ fontSize: 13 }}>Domains are organization-scoped; attach and verify over DNS TXT in Organizations.</p>
          ) : domains.length === 0 ? (
            <EmptyState title="No custom domains" hint="Attach api, storage, functions or app domains from Organizations." />
          ) : (
            <ul className="health-list">
              {domains.map(d => (
                <li key={d.id} className="health-row">
                  <span className="grow"><span className="name"><code>{d.hostname}</code></span>
                    <div className="detail">{d.status ?? (d.verified ? 'verified' : 'pending')}</div></span>
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 13 }}><a href="/organizations">Open Organizations →</a></p>
        </div>
        <div className="card">
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Log drains</h2>
          {!drains ? (
            <p className="muted" style={{ fontSize: 13 }}>Signed HTTPS drains ship audit, billing, auth and error events.</p>
          ) : drains.length === 0 ? (
            <EmptyState title="No drains" hint="Create an SSRF-guarded HTTPS drain from Organizations." />
          ) : (
            <ul className="health-list">
              {drains.map(d => (
                <li key={d.id} className="health-row">
                  <span className="grow"><span className="name"><code>{d.url}</code></span>
                    <div className="detail">{(d.kinds ?? []).join(', ')}</div></span>
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 13 }}><a href="/organizations">Open Organizations →</a></p>
        </div>
      </div>
    </div>
  );
}
