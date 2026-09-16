'use client';

import { use } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../../../components/States';

interface Webhook {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled?: boolean;
}
interface Domain {
  id: string;
  hostname: string;
  domain?: string;
  status?: string;
  verified?: boolean;
  verifiedAt?: string | null;
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

  const [ghRepo, setGhRepo] = useState('');
  const [ghUrl, setGhUrl] = useState('');
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
    if (d.ok && d.data) {
      setDomains(
        d.data.domains.map(x => ({
          ...x,
          hostname: x.hostname ?? x.domain ?? '',
          verified: x.verified ?? (x.status === 'verified' || x.verifiedAt != null),
        })),
      );
    }
    if (dr.ok && dr.data) setDrains(dr.data.drains);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connectGithub(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const repo = ghRepo.trim();
    const url = ghUrl.trim();
    if (!repo || !url) return;
    // Honest integration: CloudNivo delivers signed deployment events to YOUR
    // receiver URL (CI endpoint, deploy hook). The repository name labels the
    // subscription so you can tell subscriptions apart.
    setGhStatus(null);
    const r = await apiFetch(`/api/v1/projects/${id}/webhooks`, {
      method: 'POST',
      body: { name: `github-${repo}`.slice(0, 64), url, eventTypes: ['function.deployed'] },
    });
    if (!r.ok) setGhStatus(`Could not create subscription: ${r.error}`);
    else {
      setGhStatus(`Subscribed — signed function.deployed events for ${repo} will be delivered to your endpoint.`);
      setGhRepo('');
      setGhUrl('');
      void load();
    }
  }

  if (error && !webhooks) return <ErrorState title="Couldn't load integrations" message={error} retry={() => void load()} />;
  if (!webhooks) return <LoadingSkeleton label="Loading integrations" rows={3} />;

  return (
    <div>
      <div className="section-head">
        <h2>Integrations</h2>
        <p>Where this project connects to the rest of your stack.</p>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="card">
          <h2>GitHub</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Subscribe a repository&apos;s pipeline to signed <code>function.deployed</code> events.
            Deliveries go to your own receiver URL (CI endpoint or deploy hook) with HMAC
            signatures — manage, replay and rotate them under Automations.
          </p>
          <form onSubmit={e => void connectGithub(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={ghRepo} onChange={e => setGhRepo(e.target.value)} placeholder="owner/repo" aria-label="GitHub repository" style={{ flex: '1 1 160px' }} />
            <input value={ghUrl} onChange={e => setGhUrl(e.target.value)} placeholder="https://ci.example.com/hooks/cloudnivo" aria-label="Receiver URL" style={{ flex: '2 1 240px' }} />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!ghRepo.trim() || !ghUrl.trim()}>Subscribe repository</button>
          </form>
          {ghStatus ? <p role="status" style={{ fontSize: 13 }}>{ghStatus}</p> : null}
        </div>
        <div className="card">
          <h2>Outbound webhooks · {webhooks.length}</h2>
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks" hint="Create one in Automations — deliveries, replay and rotation live there." />
          ) : (
            <ul className="health-list">
              {webhooks.map(w => (
                <li key={w.id} className="health-row">
                  <span className="grow">
                    <span className="name"><code>{w.name}</code></span>
                    <div className="detail"><code>{w.url}</code> · {(w.eventTypes ?? []).join(', ')}{w.enabled === false ? ' · paused' : ''}</div>
                  </span>
                  <a className="value" href={`/projects/${id}/automations`}>Manage →</a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Custom domains{orgId ? '' : ''}</h2>
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
          <h2>Log drains</h2>
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
