'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { CopyField, useToast } from './ui';

/**
 * Organization SSO. The API has had these endpoints since the SSO work
 * landed, with no surface to drive them — a capability nobody could reach.
 *
 * This configures the *existing* generic OIDC connection: one connection per
 * organization, the secret posted once and encrypted server-side, never read
 * back. Presets fill the issuer for known providers so an admin does not have
 * to know that Logto's discovery lives under /oidc.
 */

interface Preset {
  id: string;
  label: string;
  issuerTemplate: string;
  placeholderHint: string;
  applicationType: string;
  scopes: string[];
  notes: string[];
  docsUrl: string;
}

interface Connection {
  id: string;
  provider: string;
  displayName: string;
  issuer: string;
  clientId: string;
  defaultRole: string;
  enabled: boolean;
}

export function SsoPanel({
  orgId,
  orgSlug,
  canManage,
}: {
  orgId: string;
  orgSlug: string;
  canManage: boolean;
}): React.JSX.Element {
  const toast = useToast();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [presetId, setPresetId] = useState('logto');
  const [tenant, setTenant] = useState('');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [defaultRole, setDefaultRole] = useState('member');

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      apiFetch<{ providers: Preset[]; callbackUrl: string }>('/api/v1/auth/sso/providers'),
      apiFetch<{ connections: Connection[] }>(`/api/v1/organizations/${orgId}/sso`),
    ]);
    if (p.ok && p.data) {
      setPresets(p.data.providers);
      setCallbackUrl(p.data.callbackUrl);
    }
    if (c.ok && c.data) {
      setConnections(c.data.connections);
      setError(null);
    } else {
      setConnections([]);
      setError(c.error);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const preset = presets?.find(p => p.id === presetId) ?? null;
  const needsTenant = Boolean(preset?.issuerTemplate.includes('{'));
  const isGeneric = preset ? !preset.issuerTemplate : false;

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      defaultRole,
      displayName: preset?.label,
    };
    if (isGeneric) body['issuer'] = issuer.trim();
    else {
      body['provider'] = presetId;
      body['tenant'] = tenant.trim();
    }
    const r = await apiFetch(`/api/v1/organizations/${orgId}/sso`, { method: 'POST', body });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Could not save the connection');
      return;
    }
    // The secret leaves the browser once and is never read back.
    setClientSecret('');
    setClientId('');
    setTenant('');
    setIssuer('');
    toast('SSO connection saved', 'ok');
    void load();
  }

  async function remove(id: string): Promise<void> {
    const r = await apiFetch(`/api/v1/organizations/${orgId}/sso/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      setError(r.error ?? 'Could not remove the connection');
      return;
    }
    toast('SSO connection removed', 'ok');
    void load();
  }

  return (
    <div className="card" id="sso">
      <div className="section-head split">
        <div>
          <h2>Single sign-on</h2>
          <p>
            Sign in through your identity provider. CloudNivo speaks standard OIDC — discovery,
            PKCE and JWKS verification — so any conformant provider works.
          </p>
        </div>
      </div>

      {error ? <ErrorState message={error} retry={() => void load()} /> : null}

      {!connections ? (
        <LoadingSkeleton label="Loading SSO" rows={2} />
      ) : connections.length === 0 ? (
        <EmptyState
          title="No SSO connection"
          hint="Members sign in with email and password until a connection exists."
        />
      ) : (
        <ul className="health-list">
          {connections.map(c => (
            <li
              key={c.id}
              className={`health-row state-row state-${c.enabled ? 'ok' : 'muted'}`}
            >
              <span className="grow">
                <span className="name">{c.displayName}</span>
                <div className="detail">
                  {c.issuer} · client {c.clientId} · joins as {c.defaultRole}
                </div>
              </span>
              <span className={`state-word state-${c.enabled ? 'ok' : 'muted'}`}>
                {c.enabled ? 'enabled' : 'disabled'}
              </span>
              {canManage ? (
                <button type="button" className="btn btn-sm" onClick={() => void remove(c.id)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {connections && connections.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3 className="sub-head">Sign-in URL</h3>
          <CopyField text={`/api/v1/auth/sso/${orgSlug}/start`} label="SSO start URL" />
        </div>
      ) : null}

      {canManage ? (
        <form onSubmit={e => void create(e)} style={{ marginTop: 16 }}>
          <h3 className="sub-head">Add a connection</h3>
          <div className="form-row">
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor="sso-preset">Provider</label>
              <select
                id="sso-preset"
                value={presetId}
                onChange={e => setPresetId(e.target.value)}
              >
                {(presets ?? []).map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {isGeneric ? (
              <div className="field" style={{ flex: '2 1 260px' }}>
                <label htmlFor="sso-issuer">Issuer URL</label>
                <input
                  id="sso-issuer"
                  value={issuer}
                  onChange={e => setIssuer(e.target.value)}
                  placeholder="https://id.example.com"
                  required
                />
              </div>
            ) : needsTenant ? (
              <div className="field" style={{ flex: '2 1 260px' }}>
                <label htmlFor="sso-tenant">Tenant</label>
                <input
                  id="sso-tenant"
                  value={tenant}
                  onChange={e => setTenant(e.target.value)}
                  placeholder={preset?.id === 'logto' ? 'acme (or the full endpoint)' : ''}
                  required
                />
              </div>
            ) : null}
          </div>
          <div className="form-row">
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label htmlFor="sso-client">Client ID</label>
              <input
                id="sso-client"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                required
              />
            </div>
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label htmlFor="sso-secret">Client secret</label>
              <input
                id="sso-secret"
                type="password"
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                autoComplete="off"
                required
              />
            </div>
            <div className="field" style={{ flex: '1 1 140px' }}>
              <label htmlFor="sso-role">New members join as</label>
              <select
                id="sso-role"
                value={defaultRole}
                onChange={e => setDefaultRole(e.target.value)}
              >
                <option value="member">member</option>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? 'Verifying…' : 'Save connection'}
            </button>
          </div>

          {preset ? (
            <div style={{ marginTop: 12 }}>
              <dl className="kv-inline">
                <dt>Application type</dt>
                <dd>{preset.applicationType}</dd>
                <dt>Scopes requested</dt>
                <dd>{preset.scopes.join(' ')}</dd>
                <dt>Redirect URI</dt>
                <dd>
                  <CopyField text={callbackUrl} label="Redirect URI" />
                </dd>
              </dl>
              {preset.notes.length > 0 ? (
                <ul className="muted" style={{ fontSize: 12.5, margin: '10px 0 0', paddingLeft: 18 }}>
                  {preset.notes.map(n => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
              <p style={{ margin: '8px 0 0', fontSize: 12.5 }}>
                <a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">
                  {preset.label} setup documentation →
                </a>
              </p>
            </div>
          ) : null}
        </form>
      ) : (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          Owners and admins configure SSO for this organization.
        </p>
      )}
    </div>
  );
}
