'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, Modal, useToast } from '../../components/ui';

interface Org {
  id: string;
  name: string;
  slug: string;
  role?: string;
}

export default function OrganizationsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <OrgsBody />
    </RequireAuth>
  );
}

function OrgsBody(): React.JSX.Element {
  const { refresh } = useSession();
  const toast = useToast();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState<Org | null>(null);

  const load = useCallback(async () => {
    const r = await apiFetch<{ organizations: Org[] }>('/api/v1/organizations');
    if (!r.ok) {
      setError(r.error ?? 'Could not load organizations');
      setOrgs([]);
    } else {
      setOrgs(r.data?.organizations ?? []);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="orgs-title">
      <div className="page-head">
        <div>
          <h1 id="orgs-title">Organizations</h1>
          <p className="sub muted">Tenancy boundary: memberships grant access, nothing else does.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New organization
        </button>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {!orgs ? (
        <LoadingSkeleton label="Loading organizations" />
      ) : orgs.length === 0 ? (
        <EmptyState
          title="You are not in an organization yet"
          hint="Create one to start projects and invite members with owner, admin, member, or viewer roles."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Create organization
            </button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col">Role</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orgs.map(o => (
                <tr key={o.id}>
                  <td>
                    <span className="row-link">{o.name}</span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {o.slug} · {o.id.slice(0, 8)}
                    </div>
                  </td>
                  <td>
                    {o.role ? <Badge tone={o.role === 'owner' ? 'info' : 'muted'}>{o.role}</Badge> : '—'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <InviteButton
                      org={o}
                      onClick={() => setInviting(o)}
                      disabled={o.role !== undefined && o.role !== 'owner' && o.role !== 'admin'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateOrgModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            toast('Organization created', 'ok');
            void load();
          }}
        />
      ) : null}
      {inviting ? (
        <InviteModal
          org={inviting}
          onClose={() => setInviting(null)}
          onSent={() => {
            setInviting(null);
            toast('Invite created — share the token with your teammate', 'ok');
          }}
        />
      ) : null}
    </section>
  );
}

function InviteButton({
  org,
  onClick,
  disabled,
}: {
  org: Org;
  onClick: () => void;
  disabled: boolean;
}): React.JSX.Element {
  void org;
  return (
    <button type="button" className="btn btn-sm" onClick={onClick} disabled={disabled} title={disabled ? 'Owners and admins can invite' : 'Invite a member'}>
      Invite member
    </button>
  );
}

function CreateOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiFetch('/api/v1/organizations', { method: 'POST', body: { name, slug } });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? 'Creation failed');
      return;
    }
    onCreated();
  }

  return (
    <Modal title="New organization" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="org-name">Name</label>
          <input id="org-name" required minLength={2} value={name} onChange={e => setName(e.target.value)} placeholder="Acme Inc" />
        </div>
        <div className="field">
          <label htmlFor="org-slug">Slug</label>
          <input
            id="org-slug"
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            value={slug}
            onChange={e => setSlug(e.target.value)}
            placeholder="acme"
          />
          <span className="hint">Lowercase letters, numbers, hyphens.</span>
        </div>
        {error ? <ErrorState message={error} /> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InviteModal({ org, onClose, onSent }: { org: Org; onClose: () => void; onSent: () => void }): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiFetch<{ token: string }>(`/api/v1/organizations/${org.id}/invites`, {
      method: 'POST',
      body: { email, role },
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Invite failed');
      return;
    }
    const t = (r.data as { token?: unknown }).token ?? (r.data as { invite?: { token?: unknown } }).invite?.token;
    setToken(typeof t === 'string' ? t : null);
    onSent();
  }

  return (
    <Modal title={`Invite to ${org.name}`} onClose={onClose}>
      {token ? (
        <>
          <p>Share this one-time invite token with your teammate:</p>
          <p>
            <code>{token}</code>
          </p>
          <p className="muted">They accept it from their account. The raw token is shown only once.</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="inv-email">Teammate email</label>
            <input id="inv-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="inv-role">Role</label>
            <select id="inv-role" value={role} onChange={e => setRole(e.target.value)}>
              <option value="viewer">Viewer — read-only</option>
              <option value="member">Member — build in projects</option>
              <option value="admin">Admin — manage members</option>
            </select>
          </div>
          {error ? <ErrorState message={error} /> : null}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Create invite'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
