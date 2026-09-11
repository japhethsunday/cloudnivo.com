'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';
import { Badge, statusTone } from './ui';

interface PlanSummary {
  id: string;
  summary: string;
  status: string;
  validation: { ok: boolean; errors: string[]; warnings: string[]; destructive: string[] };
  changes: { op: string; section: string; text: string }[];
  estimate: Record<string, number>;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanDetail extends PlanSummary {
  plan: {
    summary: string;
    database: { tables: { name: string }[] };
    auth: { roles: { name: string }[] };
    storage: { buckets: { name: string }[] };
    realtime: { channels: { topic: string }[] };
    functions: { name: string }[];
  };
  migrationSql: string[];
  steps: { step: string; ok: boolean; detail: string }[];
}

type Stage = 'prompt' | 'plan' | 'result';

export function AIBuilderPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/ai`;
  const [stage, setStage] = useState<Stage>('prompt');
  const [prompt, setPrompt] = useState('');
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    const r = await apiFetch<{ plans: PlanSummary[] }>(`${base}/plans`);
    if (r.ok && r.data) setPlans(r.data.plans);
  }, [base]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  async function loadDetail(id: string): Promise<void> {
    const r = await apiFetch<{ plan: PlanDetail }>(`${base}/plans/${id}`);
    if (r.ok && r.data) {
      setDetail(r.data.plan);
      setActiveId(id);
      setStage('plan');
    } else setError(r.error);
  }

  async function generate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await apiFetch<{ plan: PlanSummary }>(`${base}/plan`, {
      method: 'POST',
      body: { prompt },
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error);
      return;
    }
    setPrompt('');
    void loadPlans();
    await loadDetail(r.data.plan.id);
  }

  async function approve(): Promise<void> {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    const confirmations = confirmText
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.startsWith('DROP') || s.startsWith('DELETE') || s.startsWith('REMOVE'));
    const r = await apiFetch(`${base}/plans/${activeId}/approve`, {
      method: 'POST',
      body: { confirmations },
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    await loadDetail(activeId);
    void loadPlans();
  }

  async function apply(): Promise<void> {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    const r = await apiFetch<{ ok: boolean; rolledBack: boolean; error: string | null }>(
      `${base}/plans/${activeId}/apply`,
      { method: 'POST', body: {} },
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error);
      return;
    }
    if (!r.data.ok) {
      setError(r.data.error ?? 'Apply failed');
    } else {
      setNotice(r.data.rolledBack ? 'Rolled back safely after a failed step.' : 'Plan applied.');
    }
    setStage('result');
    await loadDetail(activeId);
    void loadPlans();
  }

  async function reject(): Promise<void> {
    if (!activeId) return;
    const r = await apiFetch(`${base}/plans/${activeId}/reject`, { method: 'POST', body: {} });
    if (!r.ok) setError(r.error);
    else {
      setStage('prompt');
      setDetail(null);
      setActiveId(null);
      void loadPlans();
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <ol className="stepper" aria-label="AI builder pipeline">
        <Step n="1" t="Describe" state={stage === 'prompt' && !detail ? 'active' : 'done'} />
        <Step
          n="2"
          t="Plan"
          state={!detail ? (busy && stage === 'prompt' ? 'active' : 'todo') : stage === 'prompt' ? 'done' : 'done'}
        />
        <Step
          n="3"
          t="Review"
          state={
            !detail ? 'todo' : detail.status === 'pending' ? 'active' : 'done'
          }
        />
        <Step
          n="4"
          t="Approve"
          state={
            !detail || detail.status === 'pending'
              ? 'todo'
              : detail.status === 'approved' && stage !== 'result'
                ? 'active'
                : 'done'
          }
        />
        <Step
          n="5"
          t="Apply"
          state={
            stage === 'result' || (detail != null && detail.steps.length > 0)
              ? 'done'
              : detail?.status === 'approved'
                ? 'active'
                : 'todo'
          }
        />
      </ol>

      {error ? <ErrorState message={error} /> : null}
      {notice ? (
        <div className="banner ok" role="status">
          <span aria-hidden>✓</span>
          <div className="grow">{notice}</div>
        </div>
      ) : null}

      {stage === 'prompt' ? (
        <>
          <div className="card">
            <div className="section-head">
              <p className="eyebrow">Step 1 · Describe</p>
              <h2>Describe the backend you need</h2>
              <p>Tables, roles, storage, realtime, functions — one paragraph is enough to start.</p>
            </div>
            <form onSubmit={e => void generate(e)}>
              <div className="field">
                <label htmlFor="ai-prompt">Natural-language request</label>
                <textarea
                  id="ai-prompt"
                  rows={5}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Build an ecommerce backend with products, customers, orders and order items. Send an email when a new order is created."
                />
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || prompt.trim().length < 10}
              >
                {busy ? 'Generating plan…' : 'Generate plan'}
              </button>
            </form>
          </div>
          <div className="card">
            <div className="section-head split">
              <div>
                <p className="eyebrow">History</p>
                <h2>Previous plans</h2>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>
                {plans === null ? '' : `${plans.length} total`}
              </span>
            </div>
            {plans === null ? (
              <LoadingSkeleton label="Loading plans" />
            ) : plans.length === 0 ? (
              <EmptyState
                icon="✦"
                title="No plans yet"
                hint="Describe a backend above — the plan appears here for review before anything is built."
              />
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Summary</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="mono">Updated</span>
                      </th>
                      <th aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map(p => (
                      <tr key={p.id}>
                        <td>{p.summary.slice(0, 100)}</td>
                        <td>
                          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                        </td>
                        <td className="muted">{new Date(p.updatedAt).toLocaleString()}</td>
                        <td>
                          <button className="btn btn-sm" type="button" onClick={() => void loadDetail(p.id)}>
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {stage !== 'prompt' && detail ? (
        <>
          <div className="card">
            <div className="section-head split">
              <div>
                <p className="eyebrow">Step 2 · Plan</p>
                <h2>Generated architecture</h2>
                <p>{detail.summary}</p>
              </div>
              <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              Provider: {detail.provider} · Model: {detail.model} · Estimate:{' '}
              {Object.entries(detail.estimate)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ') || '—'}
            </p>
            <ul className="health-list">
              <ArchRow label="Tables" value={detail.plan.database.tables.map(t => t.name)} />
              <ArchRow label="Roles" value={detail.plan.auth.roles.map(r => r.name)} />
              <ArchRow label="Buckets" value={detail.plan.storage.buckets.map(b => b.name)} />
              <ArchRow label="Channels" value={detail.plan.realtime.channels.map(c => c.topic)} />
              <ArchRow label="Functions" value={detail.plan.functions.map(f => f.name)} />
            </ul>
          </div>

          <div className="card">
            <div className="section-head">
              <p className="eyebrow">Step 3 · Review</p>
              <h2>Changes &amp; validation</h2>
              <p>Every change the plan wants to make, with structural validation up front.</p>
            </div>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Op</th>
                    <th scope="col">Section</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.changes.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <Badge tone={/drop|delete|remove/i.test(c.op) ? 'bad' : 'info'}>{c.op}</Badge>
                      </td>
                      <td>{c.section}</td>
                      <td style={{ fontSize: 13 }}>{c.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.validation.ok ? (
              <div className="banner ok" role="status" style={{ marginTop: 12, marginBottom: 0 }}>
                <span aria-hidden>✓</span>
                <div className="grow">Plan is structurally valid.</div>
              </div>
            ) : (
              <div className="banner bad" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
                <span aria-hidden>!</span>
                <div className="grow">
                  <strong>Blocked:</strong>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {detail.validation.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {detail.validation.warnings.map((w, i) => (
              <div className="banner warn" key={i} role="note" style={{ marginTop: 8, marginBottom: 0 }}>
                <span aria-hidden>ⓘ</span>
                <div className="grow">{w}</div>
              </div>
            ))}
            {detail.validation.destructive.length > 0 ? (
              <div className="banner bad" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
                <span aria-hidden>⚠</span>
                <div className="grow">
                  <strong>Destructive operations: {detail.validation.destructive.join(', ')}</strong>
                  <p>
                    Approval alone is not enough — type each operation name (comma-separated) into the
                    confirmation box to proceed.
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="section-head">
              <p className="eyebrow">Diff</p>
              <h2>Migration preview</h2>
            </div>
            {detail.migrationSql.length > 0 ? (
              <pre className="codeblock" style={{ maxHeight: 360 }}>
                {detail.migrationSql.join('\n').slice(0, 6000)}
              </pre>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No database statements in this plan.
              </p>
            )}
          </div>

          {detail.status === 'pending' ? (
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Step 4 · Approve</p>
                <h2>Approval</h2>
                <p>Nothing executes until you approve. Rejection discards the plan.</p>
              </div>
              <div className="field">
                <label htmlFor="ai-confirm">Destructive confirmations (if any)</label>
                <input
                  id="ai-confirm"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder="e.g. DROP TABLE"
                  autoComplete="off"
                />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy}
                >
                  {busy ? 'Approving…' : 'Approve plan'}
                </button>
                <button className="btn" type="button" onClick={() => void reject()} disabled={busy}>
                  Reject
                </button>
              </div>
            </div>
          ) : null}

          {detail.status === 'approved' ? (
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Step 5 · Apply</p>
                <h2>Deployment</h2>
                <p>The approved plan applies against live services, step by step.</p>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void apply()}
                disabled={busy}
              >
                {busy ? 'Applying…' : 'Apply plan'}
              </button>
            </div>
          ) : null}

          {detail.steps.length > 0 ? (
            <div className="card">
              <div className="section-head">
                <p className="eyebrow">Result</p>
                <h2>Execution result</h2>
              </div>
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Step</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.steps.map((s, i) => (
                      <tr key={i}>
                        <td>{s.step}</td>
                        <td>
                          <Badge tone={s.ok ? 'ok' : 'bad'}>{s.ok ? 'ok' : 'failed'}</Badge>
                        </td>
                        <td style={{ fontSize: 13 }}>{s.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setStage('prompt');
                setDetail(null);
                setActiveId(null);
                setConfirmText('');
              }}
            >
              ← Back to builder
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
}

function Step({ n, t, state }: { n: string; t: string; state: 'todo' | 'active' | 'done' }): React.JSX.Element {
  return (
    <li className={state === 'todo' ? undefined : state} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="n">Step {n}</span>
      <span className="t">
        {state === 'done' ? '✓ ' : ''}
        {t}
      </span>
    </li>
  );
}

function ArchRow({ label, value }: { label: string; value: string[] }): React.JSX.Element {
  return (
    <li className="health-row">
      <span className="grow">
        <span className="name">{label}</span>
        <div className="detail">{value.length > 0 ? value.join(', ') : '—'}</div>
      </span>
    </li>
  );
}
