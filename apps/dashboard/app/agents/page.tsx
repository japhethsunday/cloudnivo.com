'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { getSelectedOrg, setSelectedOrg } from '../../lib/selection';
import {
  createAgentToken,
  decideApproval,
  listActivity,
  listAgentTokens,
  listApprovals,
  revokeAgentToken,
  type ActivityView,
  type AgentTokenView,
  type ApprovalView,
  type ScopeView,
} from '../../lib/agents';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/States';
import { Badge, Modal, StatusDot, statusTone, useToast } from '../../components/ui';

interface ProjectLite {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
}

export default function AgentsPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AgentsBody />
    </RequireAuth>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'in the future';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function expiryLabel(token: AgentTokenView): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (token.revokedAt) return { text: 'revoked', tone: 'bad' };
  if (!token.expiresAt) return { text: 'never expires', tone: 'muted' };
  const ms = Date.parse(token.expiresAt) - Date.now();
  if (ms <= 0) return { text: 'expired', tone: 'bad' };
  if (ms < 7 * 86_400_000) return { text: `expires ${relativeTime(token.expiresAt).replace(' ago', '')} left`.replace('just now left', 'soon'), tone: 'warn' };
  return { text: `expires ${new Date(token.expiresAt).toLocaleDateString()}`, tone: 'muted' };
}

function AgentsBody(): React.JSX.Element {
  const { orgs } = useSession();
  const toast = useToast();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<AgentTokenView[] | null>(null);
  const [scopes, setScopes] = useState<ScopeView[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [activity, setActivity] = useState<ActivityView[]>([]);
  const [activityToken, setActivityToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<AgentTokenView | null>(null);
  const [revoking, setRevoking] = useState<AgentTokenView | null>(null);

  useEffect(() => {
    const preferred = getSelectedOrg();
    const first = orgs.find(o => o.id === preferred) ?? orgs[0];
    setOrgId(first?.id ?? null);
  }, [orgs]);

  const load = useCallback(async () => {
    if (!orgId) {
      setTokens([]);
      return;
    }
    const [t, a, act, p] = await Promise.all([
      listAgentTokens(orgId),
      listApprovals(orgId, 'pending'),
      listActivity(orgId, { limit: 50 }),
      apiFetch<{ projects: ProjectLite[] }>('/api/v1/projects'),
    ]);
    if (!t.ok) {
      setError(t.error ?? 'Could not load agent tokens');
      setTokens([]);
    } else {
      setTokens(t.tokens ?? []);
      setScopes(t.scopes ?? []);
    }
    if (a.ok && a.approvals) setApprovals(a.approvals);
    if (act.ok && act.activity) setActivity(act.activity);
    if (p.ok && p.data) setProjects(p.data.projects.filter(x => x.organizationId === orgId));
  }, [orgId]);

  useEffect(() => {
    if (orgId !== null) void load();
    else if (orgs.length === 0) setTokens([]);
  }, [orgId, orgs.length, load]);

  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void listActivity(orgId, { tokenId: activityToken || undefined, limit: 50 }).then(r => {
      if (live && r.ok && r.activity) setActivity(r.activity);
    });
    return () => {
      live = false;
    };
  }, [orgId, activityToken]);

  const role = orgs.find(o => o.id === orgId)?.role;
  const canManage = role === 'owner' || role === 'admin';

  async function doRevoke(): Promise<void> {
    if (!revoking || !orgId) return;
    const r = await revokeAgentToken(orgId, revoking.id);
    if (!r.ok) {
      setError(r.error ?? 'Revoke failed');
      return;
    }
    toast('Agent token revoked — it stops working immediately', 'ok');
    setRevoking(null);
    setDetail(null);
    await load();
  }

  async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
    if (!orgId) return;
    const r = await decideApproval(orgId, id, decision);
    if (!r.ok) {
      setError(r.error ?? 'Decision failed');
      return;
    }
    toast(decision === 'approve' ? 'Operation approved' : 'Operation rejected', decision === 'approve' ? 'ok' : 'info');
    await load();
  }

  return (
    <section aria-labelledby="agents-title">
      <div className="page-head">
        <div>
          <h1 id="agents-title">Agent access</h1>
          <p className="sub muted">
            Dedicated <code>cn_agent_…</code> credentials for AI coding agents — scoped, expiring, revocable.
          </p>
        </div>
        {canManage && orgId ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New agent token
          </button>
        ) : null}
      </div>

      <div className="field" style={{ maxWidth: 340 }}>
        <label htmlFor="agent-org">Organization</label>
        <select
          id="agent-org"
          value={orgId ?? ''}
          onChange={e => {
            setOrgId(e.target.value || null);
            setSelectedOrg(e.target.value || null);
          }}
        >
          {orgs.map(o => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.role})
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorState title="Couldn't load agent access" message={error} /> : null}

      {!orgId ? (
        <EmptyState
          title="Select an organization"
          hint="Agent tokens belong to an organization you own or administer."
        />
      ) : !canManage ? (
        <EmptyState
          title="Owners and admins only"
          hint="Agent tokens are powerful credentials. Ask an owner or admin of this organization to manage them."
        />
      ) : tokens === null ? (
        <LoadingSkeleton label="Loading agent tokens" />
      ) : (
        <>
          {approvals.length > 0 ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <h2 style={{ marginTop: 0 }}>
                Approval inbox <Badge tone="warn">{approvals.length} pending</Badge>
              </h2>
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Action</th>
                      <th scope="col">Path</th>
                      <th scope="col">Requested</th>
                      <th scope="col">Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvals.map(a => (
                      <tr key={a.id}>
                        <td>
                          <code>{a.action}</code>
                        </td>
                        <td style={{ fontSize: 13 }}>
                          <code>{a.method}</code> {a.path}
                        </td>
                        <td className="muted">{relativeTime(a.createdAt)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="btn btn-sm btn-primary" onClick={() => void decide(a.id, 'approve')}>
                              Approve
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => void decide(a.id, 'reject')}>
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="card" style={{ marginBottom: 12 }}>
            <h2 style={{ marginTop: 0 }}>Agent tokens</h2>
            {tokens.length === 0 ? (
              <EmptyState
                title="No agent tokens yet"
                hint="Create one for Claude Code, OpenCode, or any compatible agent. The raw value is shown exactly once."
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                    Create agent token
                  </button>
                }
              />
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Scope</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map(t => {
                      const exp = expiryLabel(t);
                      return (
                        <tr key={t.id}>
                          <td>
                            <strong>{t.name}</strong>
                            <div className="muted" style={{ fontSize: 12 }}>
                              <code>{t.prefix}…</code> · {t.requestCount} requests
                              {t.approvalRequired ? (
                                <>
                                  {' '}· <Badge tone="warn">approval mode</Badge>
                                </>
                              ) : null}
                            </div>
                          </td>
                          <td style={{ fontSize: 13 }}>
                            {t.organizationId ? 'org' : 'account'}-wide
                            {t.projectIds.length > 0 ? ` · ${t.projectIds.length} projects` : ''}
                            <div className="muted">{t.scopes.length} scopes</div>
                          </td>
                          <td>
                            <Badge tone={exp.tone}>{exp.text}</Badge>
                          </td>
                          <td className="muted">{relativeTime(t.lastUsedAt)}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" className="btn btn-sm" onClick={() => setDetail(t)}>
                                Details
                              </button>
                              {!t.revokedAt ? (
                                <button type="button" className="btn btn-sm btn-danger" onClick={() => setRevoking(t)}>
                                  Revoke
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, flex: 1 }}>Activity</h2>
              <select
                aria-label="Filter activity by token"
                value={activityToken}
                onChange={e => setActivityToken(e.target.value)}
                style={{ maxWidth: 240 }}
              >
                <option value="">All tokens</option>
                {tokens.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            {activity.length === 0 ? (
              <EmptyState title="No activity yet" hint="Token use, denials, and approvals appear here." />
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Action</th>
                      <th scope="col">Resource</th>
                      <th scope="col">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.slice(0, 30).map(a => (
                      <tr key={a.id}>
                        <td className="muted">{relativeTime(a.createdAt)}</td>
                        <td>
                          <code>{a.action}</code>
                        </td>
                        <td style={{ fontSize: 13 }}>{a.resource || '—'}</td>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <StatusDot tone={statusTone(a.result === 'success' ? 'ok' : a.result === 'denied' || a.result === 'blocked' ? 'warn' : 'bad')} />
                            {a.result}
                          </span>
                          {a.reason ? (
                            <div className="muted" style={{ fontSize: 12 }}>
                              {a.reason}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {creating && orgId ? (
        <CreateTokenModal
          orgId={orgId}
          scopes={scopes}
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            toast('Agent token created — copy it now, it will not be shown again', 'ok');
            void load();
          }}
        />
      ) : null}
      {detail ? (
        <TokenDetailModal
          token={detail}
          scopes={scopes}
          projects={projects}
          onClose={() => setDetail(null)}
          onRevoke={() => setRevoking(detail)}
        />
      ) : null}
      {revoking ? (
        <Modal title={`Revoke ${revoking.name}?`} onClose={() => setRevoking(null)}>
          <p>
            The token <code>{revoking.prefix}…</code> stops working <strong>immediately</strong> on
            every request. Agents using it will start failing until reconfigured.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setRevoking(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void doRevoke()}>
              Revoke now
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function CreateTokenModal({
  orgId,
  scopes,
  projects,
  onClose,
  onCreated,
}: {
  orgId: string;
  scopes: ScopeView[];
  projects: { id: string; name: string; slug: string }[];
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(() => scopes.filter(s => !s.dangerous).map(s => s.scope));
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [expiresIn, setExpiresIn] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setPicked(scopes.filter(s => !s.dangerous).map(s => s.scope));
  }, [scopes]);

  function toggleScope(scope: string): void {
    setPicked(p => (p.includes(scope) ? p.filter(s => s !== scope) : [...p, scope]));
  }

  function toggleProject(id: string): void {
    setProjectIds(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await createAgentToken(orgId, {
      name,
      scopes: picked,
      projectIds,
      approvalRequired,
      expiresIn,
    });
    setBusy(false);
    if (!r.ok || !r.raw) {
      setError(r.error ?? 'Creation failed');
      return;
    }
    setRevealed(r.raw);
  }

  function copy(): void {
    if (!revealed) return;
    void navigator.clipboard?.writeText(revealed).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  if (revealed) {
    return (
      <Modal title="Copy your agent token" onClose={onClose}>
        <p>
          <strong>This is the only time the raw token is shown.</strong> Copy it into your
          agent&apos;s configuration now.
        </p>
        <p>
          <code style={{ userSelect: 'all' }}>{revealed}</code>
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy token'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onClose();
              onCreated();
            }}
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  const grouped = new Map<string, ScopeView[]>();
  for (const s of scopes) {
    const list = grouped.get(s.service) ?? [];
    list.push(s);
    grouped.set(s.service, list);
  }

  return (
    <Modal title="New agent token" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="agent-name">Agent name</label>
          <input
            id="agent-name"
            required
            maxLength={100}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Claude Code"
          />
        </div>
        <div className="field">
          <span className="lbl" id="scope-label">Permissions</span>
          <div role="group" aria-labelledby="scope-label" style={{ display: 'grid', gap: 4, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            {[...grouped.entries()].map(([service, list]) => (
              <div key={service}>
                <p className="muted" style={{ margin: '6px 0 2px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {service}
                </p>
                {list.map(s => (
                  <label key={s.scope} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto', marginTop: 4 }}
                      checked={picked.includes(s.scope)}
                      onChange={() => toggleScope(s.scope)}
                    />
                    <span>
                      <code>{s.scope}</code>
                      {s.dangerous ? (
                        <>
                          {' '}· <Badge tone="warn">dangerous</Badge>
                        </>
                      ) : null}
                      <br />
                      <span className="muted">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lbl" id="proj-label">Projects (empty = whole organization)</span>
          <div role="group" aria-labelledby="proj-label" style={{ display: 'grid', gap: 4, maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            {projects.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>No projects yet — the token will cover the organization.</p>
            ) : (
              projects.map(p => (
                <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={projectIds.includes(p.id)}
                    onChange={() => toggleProject(p.id)}
                  />
                  {p.name} <span className="muted">({p.slug})</span>
                </label>
              ))
            )}
          </div>
        </div>
        <div className="field">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={approvalRequired}
              onChange={e => setApprovalRequired(e.target.checked)}
            />
            Require approval for destructive operations
          </label>
          <span className="hint">Deletes and destructive changes return 428 until you approve them here.</span>
        </div>
        <div className="field">
          <label htmlFor="agent-exp">Expiration</label>
          <select id="agent-exp" value={expiresIn} onChange={e => setExpiresIn(e.target.value)}>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="365d">1 year</option>
            <option value="never">Never</option>
          </select>
        </div>
        {error ? <ErrorState message={error} /> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || picked.length === 0}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TokenDetailModal({
  token,
  scopes,
  projects,
  onClose,
  onRevoke,
}: {
  token: AgentTokenView;
  scopes: ScopeView[];
  projects: { id: string; name: string }[];
  onClose: () => void;
  onRevoke: () => void;
}): React.JSX.Element {
  const byScope = new Map(scopes.map(s => [s.scope, s]));
  const exp = expiryLabel(token);
  return (
    <Modal title={token.name} onClose={onClose}>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">Prefix</th>
            <td>
              <code>{token.prefix}…</code>
            </td>
          </tr>
          <tr>
            <th scope="row">Status</th>
            <td>
              <Badge tone={exp.tone}>{exp.text}</Badge>
            </td>
          </tr>
          <tr>
            <th scope="row">Scope</th>
            <td>
              {token.organizationId ? 'This organization' : 'Account-wide'}
              {token.projectIds.length > 0
                ? ` · ${token.projectIds.map(id => projects.find(p => p.id === id)?.name ?? id.slice(0, 8)).join(', ')}`
                : ' · all projects'}
            </td>
          </tr>
          <tr>
            <th scope="row">Approval mode</th>
            <td>{token.approvalRequired ? 'Destructive ops need approval' : 'Off'}</td>
          </tr>
          <tr>
            <th scope="row">Usage</th>
            <td>
              {token.requestCount} requests · last used {relativeTime(token.lastUsedAt)}
            </td>
          </tr>
          <tr>
            <th scope="row">Created</th>
            <td>{new Date(token.createdAt).toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
      <h3>Scopes ({token.scopes.length})</h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {token.scopes.map(s => (
          <span key={s} title={byScope.get(s)?.description ?? s}>
            <Badge tone={byScope.get(s)?.dangerous ? 'warn' : 'muted'}>{s}</Badge>
          </span>
        ))}
      </div>
      {!token.revokedAt ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-danger" onClick={onRevoke}>
            Revoke token
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
