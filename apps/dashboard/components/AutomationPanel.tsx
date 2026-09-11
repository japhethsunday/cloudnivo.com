'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { timeAgo } from '../lib/format';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { Badge, CopyField, statusTone, useToast } from './ui';

interface Queue {
  id: string;
  name: string;
  maxDeliveries: number;
  depth?: { queued: number; leased: number; dead: number };
}

interface QueueMessage {
  id: string;
  body: Record<string, unknown>;
  status: string;
  deliveries: number;
  createdAt: string;
}

interface Schedule {
  id: string;
  name: string;
  functionSlug: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

interface Webhook {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  secretPrefix: string;
  enabled: boolean;
  maxAttempts: number;
}

interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attempts: { at: string; status: number | null; ok: boolean; error: string | null; latencyMs: number }[];
  createdAt: string;
}

interface FnRecord {
  id: string;
  name: string;
  slug: string;
}

const EVENTS = ['job.completed', 'job.failed', 'function.deployed', 'function.invoked', 'ai.plan.applied', 'project.deleted'];

export function AutomationPanel({ projectId }: { projectId: string }): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <QueuesSection projectId={projectId} />
      <SchedulesSection projectId={projectId} />
      <WebhooksSection projectId={projectId} />
    </div>
  );
}

function useRefresh(): [number, () => void] {
  const [n, setN] = useState(0);
  return [n, () => setN(x => x + 1)];
}

// ── Queues ──

function QueuesSection({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/queues`;
  const toast = useToast();
  const [queues, setQueues] = useState<Queue[] | null>(null);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<QueueMessage[] | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('{"hello":"world"}');
  const [error, setError] = useState<string | null>(null);
  const [tick, bump] = useRefresh();

  const load = useCallback(async () => {
    const r = await apiFetch<{ queues: Queue[] }>(base);
    if (!r.ok) setError(r.error ?? 'Could not load queues');
    else if (r.data) {
      setQueues(r.data.queues);
      setActiveId(cur => cur || r.data?.queues[0]?.id || '');
    }
  }, [base]);

  const loadMessages = useCallback(async () => {
    if (!activeId) {
      setMessages(null);
      return;
    }
    const r = await apiFetch<{ messages: QueueMessage[] }>(`${base}/${activeId}/messages`);
    if (r.ok && r.data) setMessages(r.data.messages);
  }, [base, activeId]);

  useEffect(() => {
    void load();
  }, [load, tick]);
  useEffect(() => {
    void loadMessages();
  }, [loadMessages, tick]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const r = await apiFetch(base, { method: 'POST', body: { name } });
    if (!r.ok) setError(r.error ?? 'Queue creation failed');
    else {
      setName('');
      toast('Queue created', 'ok');
      bump();
    }
  }

  async function publish(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      setError('Body must be valid JSON');
      return;
    }
    const r = await apiFetch(`${base}/${activeId}/messages`, {
      method: 'POST',
      body: { body: parsed },
    });
    if (!r.ok) setError(r.error ?? 'Publish failed');
    else bump();
  }

  async function consume(): Promise<void> {
    setError(null);
    const r = await apiFetch(`${base}/${activeId}/consume`, { method: 'POST', body: { limit: 10 } });
    if (!r.ok) setError(r.error ?? 'Consume failed');
    else bump();
  }

  async function ack(id: string): Promise<void> {
    const r = await apiFetch(`${base}/${activeId}/messages/${id}/ack`, { method: 'POST', body: {} });
    if (!r.ok) setError(r.error ?? 'Ack failed');
    else bump();
  }

  async function purge(): Promise<void> {
    if (!window.confirm('Purge acked and dead messages from this queue?')) return;
    const r = await apiFetch(`${base}/${activeId}/purge`, { method: 'POST', body: { statuses: ['acked', 'dead'] } });
    if (!r.ok) setError(r.error ?? 'Purge failed');
    else bump();
  }

  const active = queues?.find(q => q.id === activeId) ?? null;

  return (
    <div className="card">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Automations</p>
          <h2>Queues</h2>
          <p>Durable per-project message queues with leases, retries, and a dead-letter set.</p>
        </div>
      </div>
      {error ? <ErrorState title="Queue operation failed" message={error} /> : null}
      {!queues ? (
        <LoadingSkeleton label="Loading queues" />
      ) : (
        <>
          <form onSubmit={e => void create(e)} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input aria-label="Queue name" value={name} onChange={e => setName(e.target.value)} placeholder="jobs" required minLength={1} style={{ maxWidth: 240 }} />
            <button type="submit" className="btn btn-primary btn-sm">
              Create queue
            </button>
          </form>
          {queues.length === 0 ? (
            <EmptyState title="No queues yet" hint="Create a queue to buffer work between producers and consumers." />
          ) : (
            <>
              <div className="toolbar">
                <select value={activeId} onChange={e => setActiveId(e.target.value)} aria-label="Active queue">
                  {queues.map(q => (
                    <option key={q.id} value={q.id}>
                      {q.name} ({q.depth?.queued ?? 0} queued)
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => void consume()}>
                  Lease up to 10
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void purge()}>
                  Purge settled
                </button>
              </div>
              {active ? (
                <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
                  <code>{active.name}</code> · {active.depth?.queued ?? 0} queued · {active.depth?.leased ?? 0} leased ·{' '}
                  {active.depth?.dead ?? 0} dead · max {active.maxDeliveries} deliveries
                </p>
              ) : null}
              <form onSubmit={e => void publish(e)} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input aria-label="Message body (JSON)" value={body} onChange={e => setBody(e.target.value)} placeholder='{"hello":"world"}' style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} />
                <button type="submit" className="btn btn-sm">
                  Publish
                </button>
              </form>
              {!messages ? (
                <LoadingSkeleton label="Loading messages" rows={2} />
              ) : messages.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Queue is empty.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Body</th>
                        <th scope="col">Status</th>
                        <th scope="col">Deliveries</th>
                        <th aria-label="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {messages.map(m => (
                        <tr key={m.id}>
                          <td>
                            <code>{JSON.stringify(m.body).slice(0, 120)}</code>
                          </td>
                          <td>
                            <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                          </td>
                          <td>{m.deliveries}</td>
                          <td>
                            {m.status === 'leased' ? (
                              <button type="button" className="btn btn-sm" onClick={() => void ack(m.id)}>
                                Ack
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Schedules ──

function SchedulesSection({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/schedules`;
  const toast = useToast();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [functions, setFunctions] = useState<FnRecord[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [cron, setCron] = useState('0 * * * *');
  const [error, setError] = useState<string | null>(null);
  const [tick, bump] = useRefresh();

  const load = useCallback(async () => {
    const [s, f] = await Promise.all([
      apiFetch<{ schedules: Schedule[] }>(base),
      apiFetch<{ functions: FnRecord[] }>(`/api/v1/projects/${projectId}/functions`),
    ]);
    if (!s.ok) setError(s.error ?? 'Could not load schedules');
    else if (s.data) setSchedules(s.data.schedules);
    if (f.ok && f.data) {
      setFunctions(f.data.functions);
      setSlug(cur => cur || f.data?.functions[0]?.slug || '');
    }
  }, [base, projectId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const r = await apiFetch(base, { method: 'POST', body: { name, functionSlug: slug, cron } });
    if (!r.ok) setError(r.error ?? 'Schedule creation failed — check the cron expression');
    else {
      setName('');
      toast('Schedule created', 'ok');
      bump();
    }
  }

  async function toggle(s: Schedule): Promise<void> {
    const r = await apiFetch(`${base}/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
    if (!r.ok) setError(r.error ?? 'Update failed');
    else bump();
  }

  async function trigger(s: Schedule): Promise<void> {
    const r = await apiFetch<{ ok: boolean; error: string | null }>(`${base}/${s.id}/trigger`, { method: 'POST', body: {} });
    if (!r.ok) setError(r.error ?? 'Trigger failed');
    else if (r.data && !r.data.ok) setError(r.data.error ?? 'Function invocation failed');
    else {
      toast('Schedule fired', 'ok');
      bump();
    }
  }

  async function remove(s: Schedule): Promise<void> {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
    const r = await apiFetch(`${base}/${s.id}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error ?? 'Delete failed');
    else bump();
  }

  return (
    <div className="card">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Automations</p>
          <h2>Schedules</h2>
          <p>Cron expressions (UTC) that invoke a project function. The worker fires due runs.</p>
        </div>
      </div>
      {error ? <ErrorState title="Schedule operation failed" message={error} /> : null}
      {!schedules ? (
        <LoadingSkeleton label="Loading schedules" />
      ) : (
        <>
          <form onSubmit={e => void create(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input aria-label="Schedule name" value={name} onChange={e => setName(e.target.value)} placeholder="nightly-report" required style={{ maxWidth: 200 }} />
            <select value={slug} onChange={e => setSlug(e.target.value)} aria-label="Function" style={{ maxWidth: 200 }}>
              {functions.map(f => (
                <option key={f.id} value={f.slug}>
                  {f.slug}
                </option>
              ))}
            </select>
            <input aria-label="Cron expression (UTC)" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 * * * *" required style={{ maxWidth: 160, fontFamily: 'var(--font-mono)' }} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={functions.length === 0}>
              Create schedule
            </button>
          </form>
          {functions.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>
              Deploy a function first — schedules invoke deployed functions.
            </p>
          ) : null}
          {schedules.length === 0 ? (
            <EmptyState title="No schedules yet" hint="Schedules run functions on a cron timetable, UTC." />
          ) : (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Schedule</th>
                    <th scope="col">Cron (UTC)</th>
                    <th scope="col">Next run</th>
                    <th scope="col">Last</th>
                    <th scope="col">Enabled</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {schedules.map(s => (
                    <tr key={s.id}>
                      <td>
                        {s.name}
                        <div className="muted" style={{ fontSize: 12 }}>
                          → <code>{s.functionSlug}</code>
                        </div>
                      </td>
                      <td>
                        <code>{s.cron}</code>
                      </td>
                      <td className="muted">{s.nextRunAt ? timeAgo(s.nextRunAt) : '—'}</td>
                      <td>
                        {s.lastStatus ? <Badge tone={statusTone(s.lastStatus)}>{s.lastStatus}</Badge> : <span className="muted">—</span>}
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => void toggle(s)} aria-pressed={s.enabled}>
                          {s.enabled ? 'On' : 'Off'}
                        </button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm" onClick={() => void trigger(s)}>
                          Run now
                        </button>{' '}
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(s)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Webhooks ──

function WebhooksSection({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/webhooks`;
  const toast = useToast();
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [activeId, setActiveId] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<string[]>(['job.failed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, bump] = useRefresh();

  const load = useCallback(async () => {
    const r = await apiFetch<{ webhooks: Webhook[] }>(base);
    if (!r.ok) setError(r.error ?? 'Could not load webhooks');
    else if (r.data) {
      setWebhooks(r.data.webhooks);
      setActiveId(cur => cur || r.data?.webhooks[0]?.id || '');
    }
  }, [base]);

  const loadDeliveries = useCallback(async () => {
    if (!activeId) {
      setDeliveries(null);
      return;
    }
    const r = await apiFetch<{ deliveries: Delivery[] }>(`${base}/${activeId}/deliveries`);
    if (r.ok && r.data) setDeliveries(r.data.deliveries);
  }, [base, activeId]);

  useEffect(() => {
    void load();
  }, [load, tick]);
  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries, tick]);

  function toggleEvent(e: string): void {
    setEvents(cur => (cur.includes(e) ? cur.filter(x => x !== e) : [...cur, e]));
  }

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSecret(null);
    const r = await apiFetch<{ webhook: Webhook; secret: string }>(base, {
      method: 'POST',
      body: { name, url, eventTypes: events },
    });
    if (!r.ok || !r.data) setError(r.error ?? 'Webhook creation failed');
    else {
      setSecret(r.data.secret);
      setName('');
      toast('Webhook created — copy the secret now', 'ok');
      bump();
    }
  }

  async function act(path: string, method: string, body?: unknown, confirmMsg?: string): Promise<void> {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setError(null);
    const r = await apiFetch<{ webhook?: Webhook; secret?: string }>(`${base}/${activeId}${path}`, { method, body });
    if (!r.ok || !r.data) setError(r.error ?? 'Operation failed');
    else {
      if (r.data.secret) setSecret(r.data.secret);
      bump();
    }
  }

  async function replay(id: string): Promise<void> {
    setError(null);
    const r = await apiFetch(`${base}/${activeId}/deliveries/${id}/replay`, { method: 'POST', body: {} });
    if (!r.ok) setError(r.error ?? 'Replay failed');
    else bump();
  }

  const active = webhooks?.find(w => w.id === activeId) ?? null;

  return (
    <div className="card">
      <div className="section-head split">
        <div>
          <p className="eyebrow">Automations</p>
          <h2>Webhooks</h2>
          <p>Signed outbound HTTP on project events, with retries, history, and replay.</p>
        </div>
      </div>
      {error ? <ErrorState title="Webhook operation failed" message={error} /> : null}
      {secret ? (
        <div className="banner warn" role="alert">
          <div className="grow">
            <strong>Copy this secret now — it is never shown again.</strong>
            <div style={{ marginTop: 8 }}>
              <CopyField text={secret} label="Webhook signing secret" />
            </div>
            <p>Receivers verify <code>X-CloudNivo-Signature</code> as HMAC-SHA256 over the exact body, keyed by the sha256 of this secret.</p>
          </div>
        </div>
      ) : null}
      {!webhooks ? (
        <LoadingSkeleton label="Loading webhooks" />
      ) : (
        <>
          <form onSubmit={e => void create(e)} style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input aria-label="Webhook name" value={name} onChange={e => setName(e.target.value)} placeholder="ops-alerts" required style={{ maxWidth: 200 }} />
              <input aria-label="Target URL" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" required style={{ flex: '1 1 260px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
              <button type="submit" className="btn btn-primary btn-sm" disabled={events.length === 0}>
                Create webhook
              </button>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} role="group" aria-label="Event types">
              {EVENTS.map(e => (
                <label key={e} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                  <input type="checkbox" checked={events.includes(e)} onChange={() => toggleEvent(e)} />
                  <code>{e}</code>
                </label>
              ))}
            </div>
          </form>
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks yet" hint="Subscribe a URL to job, function, AI, or project events." />
          ) : (
            <>
              <div className="toolbar">
                <select value={activeId} onChange={e => setActiveId(e.target.value)} aria-label="Active webhook">
                  {webhooks.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name} {!w.enabled ? '(disabled)' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => void act('/test', 'POST', {})}>
                  Send test
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void act('', 'PATCH', { enabled: !active?.enabled })}>
                  {active?.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void act('/rotate', 'POST', {}, 'Rotate this webhook secret? The old secret stops working immediately.')}>
                  Rotate secret
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void act('', 'DELETE', undefined, `Delete webhook "${active?.name}"? Deliveries are removed too.`)}>
                  Delete
                </button>
              </div>
              {active ? (
                <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
                  <code>{active.url}</code> · {active.eventTypes.join(', ')} · prefix <code>{active.secretPrefix}…</code>
                </p>
              ) : null}
              {!deliveries ? (
                <LoadingSkeleton label="Loading deliveries" rows={2} />
              ) : deliveries.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No deliveries yet — matching events and test sends appear here.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Status</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Latency</th>
                        <th scope="col">When</th>
                        <th aria-label="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map(d => (
                        <tr key={d.id}>
                          <td>
                            <code>{d.eventType}</code>
                          </td>
                          <td>
                            <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                          </td>
                          <td>
                            {d.attempts.length}
                            {d.attempts.length > 0 && !d.attempts[d.attempts.length - 1]?.ok ? (
                              <div className="muted" style={{ fontSize: 12 }}>
                                {(d.attempts[d.attempts.length - 1]?.error ?? '').slice(0, 80)}
                              </div>
                            ) : null}
                          </td>
                          <td className="muted">
                            {d.attempts.length > 0 ? `${d.attempts[d.attempts.length - 1]?.latencyMs ?? 0} ms` : '—'}
                          </td>
                          <td className="muted">{timeAgo(d.createdAt)}</td>
                          <td>
                            <button type="button" className="btn btn-sm" onClick={() => void replay(d.id)}>
                              Replay
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
