'use client';

import { useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatCount, timeAgo } from '../../lib/format';
import { EmptyState, ErrorState, LoadingTable } from '../States';
import { GrowthChart } from '../GrowthChart';
import { Modal, statusTone, useToast } from '../ui';
import { FactRow, NotWired, Toolbar, useAdminResource } from './AdminShell';
import type {
  AdminsView,
  AuditRow,
  ConfigView,
  InfrastructureView,
  ObservabilityView,
  OrgDetail,
  OrgRow,
  Overview,
  ProjectDetail,
  ProjectRow,
  SecurityView,
  UserDetail,
  UserRow,
} from './types';

/** Shared gate: one loading/error/empty treatment for every section. */
function Gate<T>({
  view,
  label,
  children,
}: {
  view: ReturnType<typeof useAdminResource<T>>;
  label: string;
  children: (data: T) => React.ReactNode;
}): React.JSX.Element {
  if (view.loading) return <LoadingTable label={`Loading ${label}`} rows={5} />;
  if (view.error)
    return <ErrorState title={`Couldn't load ${label}`} message={view.error} retry={view.reload} />;
  if (!view.data) return <EmptyState title="Nothing to show" hint={`The console returned no ${label}.`} />;
  return <>{children(view.data)}</>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <li className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </li>
  );
}

// ── Overview ────────────────────────────────────────────────────────

export function OverviewSection(): React.JSX.Element {
  const view = useAdminResource<Overview>('/api/v1/admin/overview');
  return (
    <Gate view={view} label="the platform">
      {o => {
        const dbStatuses = Object.entries(o.databases).sort((a, b) => b[1] - a[1]);
        return (
          <>
            {o.provisioning.failed > 0 ? (
              <div className="card alarm" style={{ marginBottom: 12 }}>
                <h3>
                  {o.provisioning.failed} provisioning{' '}
                  {o.provisioning.failed === 1 ? 'job has' : 'jobs have'} failed
                </h3>
                <p>
                  These projects have no database and will not get one without help. Infrastructure
                  carries each provisioner&apos;s own error.
                </p>
              </div>
            ) : null}

            <ul className="stat-grid" aria-label="Platform totals">
              <Stat
                label="Signups"
                value={formatCount(o.totals.users)}
                sub={`${o.recent.usersThisWeek} this week · ${o.recent.usersThisMonth} this month`}
              />
              <Stat label="Organizations" value={formatCount(o.totals.organizations)} />
              <Stat
                label="Projects"
                value={formatCount(o.totals.projects)}
                sub={`${o.recent.projectsThisWeek} this week`}
              />
              <Stat label="Databases" value={formatCount(o.totals.databases)} />
            </ul>

            <div className="grid-2" style={{ marginTop: 12 }}>
              <div className="card">
                <h3>Growth</h3>
                <GrowthChart data={o.growth} />
              </div>
              <div className="card">
                <h3>API traffic</h3>
                <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                  This API process, since {timeAgo(o.trafficSinceBoot.since)}. Process-local — a
                  deploy resets it, and it is not platform-wide history.
                </p>
                <FactRow k="Requests">{formatCount(o.trafficSinceBoot.requests)}</FactRow>
                <FactRow k="Errors (5xx)">{formatCount(o.trafficSinceBoot.errors)}</FactRow>
                <FactRow k="Error rate">
                  {(o.trafficSinceBoot.errorRate * 100).toFixed(2)}%
                </FactRow>
                <FactRow k="Latency p50">{o.trafficSinceBoot.p50Ms} ms</FactRow>
                <FactRow k="Latency p95">{o.trafficSinceBoot.p95Ms} ms</FactRow>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <h3>Databases by status</h3>
              {dbStatuses.length === 0 ? (
                <p className="muted">No databases have been provisioned yet.</p>
              ) : (
                dbStatuses.map(([status, n]) => (
                  <FactRow key={status} k={status}>
                    {formatCount(n)}
                  </FactRow>
                ))
              )}
            </div>
          </>
        );
      }}
    </Gate>
  );
}

// ── Users ───────────────────────────────────────────────────────────

export function UsersSection(): React.JSX.Element {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const path = useMemo(
    () => `/api/v1/admin/users?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
    [q],
  );
  const view = useAdminResource<{ users: UserRow[] }>(path);

  return (
    <>
      <Toolbar value={q} onChange={setQ} placeholder="Search by email or name…">
        <button type="button" className="btn btn-sm btn-quiet" onClick={view.reload}>
          Refresh
        </button>
      </Toolbar>
      <Gate view={view} label="users">
        {d =>
          d.users.length === 0 ? (
            <EmptyState title="No matching accounts" hint="Nothing matches that search." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Standing</th>
                    <th scope="col" className="hide-sm">Role</th>
                    <th scope="col" className="hide-sm">Joined</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.users.map(u => (
                    <tr
                      key={u.id}
                      className={`state-row state-${u.suspendedAt ? 'bad' : 'ok'}`}
                    >
                      <td>
                        {u.email}
                        {u.displayName ? <div className="muted">{u.displayName}</div> : null}
                      </td>
                      <td>
                        <span className={`state-word state-${u.suspendedAt ? 'bad' : 'ok'}`}>
                          {u.suspendedAt ? 'suspended' : 'active'}
                        </span>
                      </td>
                      <td className="reading hide-sm">{u.isPlatformAdmin ? 'staff' : 'developer'}</td>
                      <td className="reading hide-sm">{timeAgo(u.createdAt)}</td>
                      <td style={{ width: 90 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet"
                          onClick={() => setOpenId(u.id)}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Gate>
      {openId ? (
        <UserDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            view.reload();
          }}
        />
      ) : null}
    </>
  );
}

function UserDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const view = useAdminResource<{ user: UserDetail }>(`/api/v1/admin/users/${id}`);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function act(suspend: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await apiFetch<unknown>(
      `/api/v1/admin/users/${id}/${suspend ? 'suspend' : 'restore'}`,
      { method: 'POST', body: suspend ? { reason } : {} },
    );
    setBusy(false);
    setConfirm(false);
    if (!res.ok) {
      setError(res.error ?? 'The action failed.');
      return;
    }
    toast(suspend ? 'Account suspended' : 'Account restored');
    view.reload();
    onChanged();
  }

  return (
    <Modal title="Account" onClose={onClose}>
      <Gate view={view} label="this account">
        {({ user: u }) => (
          <>
            <FactRow k="Email">{u.email}</FactRow>
            <FactRow k="User ID">{u.id}</FactRow>
            <FactRow k="Display name">{u.displayName ?? '—'}</FactRow>
            <FactRow k="Role">{u.isPlatformAdmin ? 'Platform staff' : 'Developer'}</FactRow>
            <FactRow k="Two-factor">{u.totpEnabled ? 'enabled' : 'not enabled'}</FactRow>
            <FactRow k="Joined">{new Date(u.createdAt).toLocaleString()}</FactRow>
            <FactRow k="Standing">
              {u.suspendedAt ? `suspended ${timeAgo(u.suspendedAt)}` : 'active'}
            </FactRow>

            <h3 style={{ marginTop: 16 }}>Organizations</h3>
            {u.organizations.length === 0 ? (
              <p className="muted">No organization memberships.</p>
            ) : (
              u.organizations.map(o => (
                <FactRow key={o.id} k={o.name}>
                  {o.role}
                </FactRow>
              ))
            )}

            <h3 style={{ marginTop: 16 }}>Projects</h3>
            {u.projects.length === 0 ? (
              <p className="muted">No projects in their organizations.</p>
            ) : (
              u.projects.slice(0, 12).map(p => (
                <FactRow key={p.id} k={p.name}>
                  {p.id.slice(0, 8)}
                </FactRow>
              ))
            )}

            {error ? <ErrorState title="Action failed" message={error} /> : null}

            {u.isPlatformAdmin ? (
              <p className="muted" style={{ marginTop: 16, fontSize: 12.5 }}>
                Platform staff cannot be suspended from this console. Removing an operator is a
                deliberate act that goes through the staff flag, not a button that could lock every
                operator out at once.
              </p>
            ) : u.suspendedAt ? (
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void act(false)}
                >
                  {busy ? 'Working…' : 'Restore account'}
                </button>
              </div>
            ) : confirm ? (
              <div className="card alarm" style={{ marginTop: 16 }}>
                <h3>Suspend {u.email}?</h3>
                <p>
                  Their existing session stops working on its next request, and they cannot sign in
                  again until restored.
                </p>
                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor="suspend-reason">Reason (internal)</label>
                  <input
                    id="suspend-reason"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="Abuse report #…"
                  />
                </div>
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void act(true)}
                  >
                    {busy ? 'Working…' : 'Suspend'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>
                  Suspend account
                </button>
              </div>
            )}
          </>
        )}
      </Gate>
    </Modal>
  );
}

// ── Organizations ───────────────────────────────────────────────────

export function OrganizationsSection(): React.JSX.Element {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const path = useMemo(
    () =>
      `/api/v1/admin/organizations?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
    [q],
  );
  const view = useAdminResource<{ organizations: OrgRow[] }>(path);

  return (
    <>
      <Toolbar value={q} onChange={setQ} placeholder="Search organizations…">
        <button type="button" className="btn btn-sm btn-quiet" onClick={view.reload}>
          Refresh
        </button>
      </Toolbar>
      <Gate view={view} label="organizations">
        {d =>
          d.organizations.length === 0 ? (
            <EmptyState title="No organizations" hint="Nothing matches that search." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Organization</th>
                    <th scope="col">Members</th>
                    <th scope="col">Projects</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.organizations.map(o => (
                    <tr key={o.id}>
                      <td>
                        {o.name}
                        <div className="muted">{o.slug}</div>
                      </td>
                      <td className="reading">{o.members}</td>
                      <td className="reading">{o.projects}</td>
                      <td style={{ width: 90 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet"
                          onClick={() => setOpenId(o.id)}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Gate>
      {openId ? <OrgDrawer id={openId} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

function OrgDrawer({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const view = useAdminResource<{ organization: OrgDetail }>(`/api/v1/admin/organizations/${id}`);
  return (
    <Modal title="Organization" onClose={onClose}>
      <Gate view={view} label="this organization">
        {({ organization: o }) => (
          <>
            <FactRow k="Name">{o.name}</FactRow>
            <FactRow k="Slug">{o.slug}</FactRow>
            <FactRow k="Organization ID">{o.id}</FactRow>
            <h3 style={{ marginTop: 16 }}>Members</h3>
            {o.memberList.length === 0 ? (
              <p className="muted">No members.</p>
            ) : (
              o.memberList.map(m => (
                <FactRow key={m.userId} k={m.email ?? m.userId}>
                  {m.role}
                </FactRow>
              ))
            )}
            <h3 style={{ marginTop: 16 }}>Projects</h3>
            {o.projectList.length === 0 ? (
              <p className="muted">No projects.</p>
            ) : (
              o.projectList.map(p => (
                <FactRow key={p.id} k={p.name}>
                  {p.region}
                </FactRow>
              ))
            )}
            <NotWired
              title="Usage and billing for this organization"
              what="Plan, quotas, invoices and payments are recorded per organization by the billing service."
              why="The operator console does not yet expose a cross-tenant billing read. Open the organization's own Billing page for its live figures."
            />
          </>
        )}
      </Gate>
    </Modal>
  );
}

// ── Projects ────────────────────────────────────────────────────────

export function ProjectsSection(): React.JSX.Element {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const path = useMemo(
    () => `/api/v1/admin/projects?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
    [q],
  );
  const view = useAdminResource<{ projects: ProjectRow[] }>(path);

  return (
    <>
      <Toolbar value={q} onChange={setQ} placeholder="Search by project, org or region…">
        <button type="button" className="btn btn-sm btn-quiet" onClick={view.reload}>
          Refresh
        </button>
      </Toolbar>
      <Gate view={view} label="projects">
        {d =>
          d.projects.length === 0 ? (
            <EmptyState title="No projects" hint="Nothing matches that search." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" className="hide-sm">Organization</th>
                    <th scope="col">Database</th>
                    <th scope="col" className="hide-sm">Region</th>
                    <th scope="col" className="hide-sm">Created</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.projects.map(p => (
                    <tr
                      key={p.id}
                      className={`state-row state-${statusTone(p.databaseStatus ?? 'unknown')}`}
                    >
                      <td>
                        {p.name}
                        <div className="muted">{p.slug}</div>
                      </td>
                      <td className="reading hide-sm">{p.organizationName ?? '—'}</td>
                      <td>
                        <span
                          className={`state-word state-${statusTone(p.databaseStatus ?? 'unknown')}`}
                        >
                          {p.databaseStatus ?? 'none'}
                        </span>
                      </td>
                      <td className="reading hide-sm">{p.region}</td>
                      <td className="reading hide-sm">{timeAgo(p.createdAt)}</td>
                      <td style={{ width: 90 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet"
                          onClick={() => setOpenId(p.id)}
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Gate>
      {openId ? <ProjectDrawer id={openId} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

function ProjectDrawer({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const view = useAdminResource<{ project: ProjectDetail }>(`/api/v1/admin/projects/${id}`);
  return (
    <Modal title="Project" onClose={onClose}>
      <Gate view={view} label="this project">
        {({ project: p }) => (
          <>
            <FactRow k="Name">{p.name}</FactRow>
            <FactRow k="Path">{p.slugPath}</FactRow>
            <FactRow k="Project ID">{p.id}</FactRow>
            <FactRow k="Organization">{p.organizationName ?? '—'}</FactRow>
            <FactRow k="Owner">{p.ownerEmail ?? '—'}</FactRow>
            <FactRow k="Region">{p.region}</FactRow>
            <FactRow k="Database">{p.databaseStatus ?? 'not provisioned'}</FactRow>
            <FactRow k="Created">{new Date(p.createdAt).toLocaleString()}</FactRow>
            <NotWired
              title="Per-project resources"
              what="Storage, functions, realtime and AI usage are recorded per project."
              why="Reading a tenant's resources from the operator console would step outside the boundary every other route enforces, so it is deliberately not wired. Open the project itself to inspect it."
            />
          </>
        )}
      </Gate>
    </Modal>
  );
}

// ── Security ────────────────────────────────────────────────────────

export function SecuritySection(): React.JSX.Element {
  const view = useAdminResource<SecurityView>('/api/v1/admin/security?limit=100');
  return (
    <Gate view={view} label="security">
      {s => (
        <>
          <ul className="stat-grid" aria-label="Security totals">
            <Stat label="Failed sign-ins" value={formatCount(s.failedLogins)} sub="recorded events" />
            <Stat
              label="Suspended attempts"
              value={formatCount(s.suspendedLoginAttempts)}
              sub="blocked at sign-in"
            />
            <Stat label="Platform staff" value={formatCount(s.staffCount)} />
          </ul>

          <div className="grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <h3>Posture</h3>
              <FactRow k="CAPTCHA">
                {s.posture.captchaConfigured ? 'configured' : 'not configured'}
              </FactRow>
              <FactRow k="Email driver">{s.posture.emailDriver}</FactRow>
              <FactRow k="Control store">{s.posture.controlStore}</FactRow>
              <FactRow k="Trusted proxy hops">{s.posture.trustedProxyHops}</FactRow>
            </div>
            <div className="card">
              <h3>Edge defence</h3>
              {s.edge ? (
                <>
                  <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                    A filter in front of the whole stack, plus per-IP reputation that escalates
                    throttle → ban on behaviour rather than volume.
                  </p>
                  <FactRow k="WAF">
                    {s.edge.wafMode === 'block'
                      ? `blocking · ${s.edge.rules} rules`
                      : s.edge.wafMode === 'report'
                        ? `report only · ${s.edge.rules} rules`
                        : 'off'}
                  </FactRow>
                  <FactRow k="Blocked (24h)">{formatCount(s.edge.wafBlocked24h)}</FactRow>
                  <FactRow k="Bans (24h)">{formatCount(s.edge.bans24h)}</FactRow>
                  <FactRow k="Throttle / ban at">
                    {s.edge.policy.throttleAt} / {s.edge.policy.banAt}
                  </FactRow>
                  <FactRow k="Ban length">{Math.round(s.edge.policy.banSeconds / 60)} min</FactRow>
                  <FactRow k="Max body">
                    {Math.round(s.edge.maxBodyBytes / 1024).toLocaleString()} KB
                  </FactRow>
                  {s.edge.shared ? null : (
                    <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      The cache is per-process, so these counters and any ban apply to this API
                      instance alone. Set REDIS_URL to share them across instances.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted">
                  <strong>Not reported.</strong> This API build predates the edge defence block, so
                  it sends no WAF or reputation figures. Deploy the API to see them.
                </p>
              )}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <AuditTable rows={s.events} />
          </div>
        </>
      )}
    </Gate>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }): React.JSX.Element {
  if (rows.length === 0)
    return <EmptyState title="No events" hint="Nothing has been recorded in this window." />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col" className="hide-sm">Actor</th>
            <th scope="col" className="hide-sm">Organization</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="reading">{r.action}</td>
              <td className="reading hide-sm">{r.actorUserId ? r.actorUserId.slice(0, 8) : '—'}</td>
              <td className="reading hide-sm">{r.organizationId ? r.organizationId.slice(0, 8) : '—'}</td>
              <td className="reading">{timeAgo(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditSection(): React.JSX.Element {
  const view = useAdminResource<{ audit: AuditRow[] }>('/api/v1/admin/audit?limit=200');
  return (
    <Gate view={view} label="the audit log">
      {d => (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>
            Append-only. Every administrative and security action the platform records, newest
            first.
          </p>
          <AuditTable rows={d.audit} />
        </>
      )}
    </Gate>
  );
}

// ── Observability ───────────────────────────────────────────────────

export function ObservabilitySection(): React.JSX.Element {
  const view = useAdminResource<ObservabilityView>('/api/v1/admin/observability?windowMs=3600000');
  return (
    <Gate view={view} label="observability">
      {m => (
        <>
          <div className="banner info" role="status" style={{ marginBottom: 12 }}>
            <div className="grow">
              <strong>Scope: {m.scope}.</strong>
              <p>
                Collected since {timeAgo(m.since)}. A deploy restarts the process and resets these
                counters — this is live instrumentation, not retained history.
              </p>
            </div>
          </div>

          <ul className="stat-grid" aria-label="Request metrics">
            <Stat label="Requests" value={formatCount(m.requests)} sub="last hour" />
            <Stat label="Errors" value={formatCount(m.errors)} sub="5xx only" />
            <Stat label="Error rate" value={`${(m.errorRate * 100).toFixed(2)}%`} />
            <Stat label="p50" value={`${m.p50Ms} ms`} />
            <Stat label="p95" value={`${m.p95Ms} ms`} />
          </ul>

          <div className="grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <h3>By service</h3>
              {m.byService.length === 0 ? (
                <p className="muted">No requests in this window.</p>
              ) : (
                m.byService.map(s => (
                  <FactRow key={s.service} k={s.service}>
                    {formatCount(s.requests)} req · p95 {s.p95Ms}ms ·{' '}
                    {(s.errorRate * 100).toFixed(1)}% err
                  </FactRow>
                ))
              )}
            </div>
            <div className="card">
              <h3>Top routes</h3>
              {m.topRoutes.length === 0 ? (
                <p className="muted">No requests in this window.</p>
              ) : (
                m.topRoutes.slice(0, 12).map(r => (
                  <FactRow key={`${r.method} ${r.route}`} k={`${r.method} ${r.route}`}>
                    {formatCount(r.requests)}
                    {r.errors > 0 ? ` · ${r.errors} err` : ''}
                  </FactRow>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </Gate>
  );
}

// ── Infrastructure ──────────────────────────────────────────────────

export function InfrastructureSection(): React.JSX.Element {
  const view = useAdminResource<InfrastructureView>('/api/v1/admin/infrastructure?limit=50');
  return (
    <Gate view={view} label="infrastructure">
      {i => (
        <>
          <div className="card">
            <h3>Component health</h3>
            {Object.entries(i.components).map(([name, c]) => (
              <div key={name} className={`state-row state-${c.ok ? 'ok' : 'bad'} health-row`}>
                <span className="grow">{name}</span>
                <span className="reading muted">{c.detail ?? ''}</span>
                <span className={`state-word state-${c.ok ? 'ok' : 'bad'}`}>
                  {c.ok ? 'healthy' : 'down'}
                </span>
              </div>
            ))}
          </div>

          <div className="grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <h3>Configured drivers</h3>
              {Object.entries(i.drivers).map(([k, v]) => (
                <FactRow key={k} k={k}>
                  {v}
                </FactRow>
              ))}
            </div>
            <div className="card">
              <h3>Databases by status</h3>
              {Object.entries(i.databases).length === 0 ? (
                <p className="muted">None provisioned.</p>
              ) : (
                Object.entries(i.databases).map(([k, v]) => (
                  <FactRow key={k} k={k}>
                    {formatCount(v)}
                  </FactRow>
                ))
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Failed provisioning jobs</h3>
            {i.failedJobs.length === 0 ? (
              <p className="muted">No failed jobs. Every provisioning run has succeeded.</p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Job</th>
                      <th scope="col" className="hide-sm">Kind</th>
                      <th scope="col" className="hide-sm">Attempts</th>
                      <th scope="col">Error</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.failedJobs.map(j => (
                      <tr key={j.id} className="state-row state-bad">
                        <td className="reading">{j.id.slice(0, 8)}</td>
                        <td className="reading hide-sm">{j.kind}</td>
                        <td className="reading hide-sm">
                          {j.attempts}/{j.maxAttempts}
                        </td>
                        <td className="row-error">{j.lastError ?? '—'}</td>
                        <td className="reading">{timeAgo(j.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <NotWired
            title="Restart and recovery controls"
            what="Restarting a service, scaling it, or draining a node."
            why="CloudNivo's API does not expose host-level control of the machines it runs on, so a button here would be a button that does nothing. Those actions live with your infrastructure provider."
          />
        </>
      )}
    </Gate>
  );
}

// ── Configuration ───────────────────────────────────────────────────

export function ConfigSection(): React.JSX.Element {
  const view = useAdminResource<ConfigView>('/api/v1/admin/config');
  return (
    <Gate view={view} label="configuration">
      {c => (
        <>
          <div className="grid-2">
            <div className="card">
              <h3>Environment</h3>
              <FactRow k="NODE_ENV">{c.environment}</FactRow>
              <FactRow k="App URL">{c.appUrl}</FactRow>
              <FactRow k="Migrate on boot">{c.migrateOnBoot ? 'yes' : 'no'}</FactRow>
              <FactRow k="Trusted proxy hops">{c.trustedProxyHops}</FactRow>
              <FactRow k="Email sender">{c.senderAddress ?? 'not configured'}</FactRow>
            </div>
            <div className="card">
              <h3>Drivers</h3>
              {Object.entries(c.drivers).map(([k, v]) => (
                <FactRow key={k} k={k}>
                  {v}
                </FactRow>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Credentials present</h3>
            <p className="muted" style={{ marginBottom: 8 }}>
              Whether a secret is configured — never the secret. No key, password or connection
              string crosses this boundary, and a test asserts it.
            </p>
            {Object.entries(c.configured).map(([k, v]) => (
              <FactRow key={k} k={k}>
                <span className={`state-word state-${v ? 'ok' : 'warn'}`}>
                  {v ? 'configured' : 'missing'}
                </span>
              </FactRow>
            ))}
          </div>

          <NotWired
            title="Editing configuration"
            what="Feature flags, rate limits, maintenance mode and system limits."
            why="These are environment variables read at boot. Editing them from a console would require a restart to take effect and would drift from the deployment that owns them, so this section reports rather than edits."
          />
        </>
      )}
    </Gate>
  );
}

// ── Admin management ────────────────────────────────────────────────

export function AdminsSection(): React.JSX.Element {
  const view = useAdminResource<AdminsView>('/api/v1/admin/admins?limit=100');
  return (
    <Gate view={view} label="operators">
      {a => (
        <>
          <div className="card">
            <h3>Platform staff</h3>
            <p className="muted" style={{ marginBottom: 8 }}>
              Staff is a stored flag on the account, re-read on every request — a session minted
              before a demotion stops working immediately. It is granted at boot from
              PLATFORM_ADMIN_EMAILS.
            </p>
            {a.admins.map(u => (
              <FactRow key={u.id} k={u.email}>
                {u.suspendedAt ? 'suspended' : 'active'} · joined {timeAgo(u.createdAt)}
              </FactRow>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <h3 style={{ marginBottom: 8 }}>Operator actions</h3>
            <AuditTable rows={a.actions} />
          </div>

          <NotWired
            title="Granting and revoking staff from here"
            what="Promoting an account to operator, or removing one."
            why="There is deliberately no route for it. Staff is set by deployment configuration so that compromising one operator session cannot mint another operator."
          />
        </>
      )}
    </Gate>
  );
}

// ── Sections with no backing capability yet ──────────────────────────

export function BillingSection(): React.JSX.Element {
  return (
    <NotWired
      title="Platform billing and revenue"
      what="Plans, subscriptions, invoices, payments and overages are real — the billing service records them per organization."
      why="What does not exist is a cross-tenant aggregate: revenue across every organization. Building it from per-org reads would be slow and easy to get wrong, so the console does not estimate it. Each organization's own Billing page carries its live figures."
    />
  );
}

export function DeploymentsSection(): React.JSX.Element {
  return (
    <NotWired
      title="Deployments"
      what="Build status, deployment history, logs and rollbacks for this platform."
      why="CloudNivo's own deploys run in GitHub Actions and the hosting provider, neither of which reports into the API. A panel here would either be empty or mirror a system it cannot read, so it is not wired."
    />
  );
}

export function IncidentsSection(): React.JSX.Element {
  return (
    <NotWired
      title="Incidents"
      what="Platform incidents with status, notes and resolution history."
      why="Incidents exist in the API at /api/v1/status/incidents, which powers the public status page. The operator console does not yet manage them; use the status endpoints until it does."
    />
  );
}

export function AiSection(): React.JSX.Element {
  return (
    <NotWired
      title="AI control center"
      what="Model usage, token consumption, cost and AI security events."
      why="AI usage is metered per project (ai_requests, ai_tokens) and readable from a project's own AI page. There is no cross-tenant AI aggregate endpoint yet, and inventing one from sampled data would be a guess presented as a figure."
    />
  );
}
