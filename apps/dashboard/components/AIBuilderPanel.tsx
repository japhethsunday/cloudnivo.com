'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

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
    <div>
      {error ? <ErrorState message={error} /> : null}
      {notice ? (
        <p role="status" className="muted">
          {notice}
        </p>
      ) : null}

      {stage === 'prompt' ? (
        <>
          <h2>Describe the backend you need</h2>
          <form onSubmit={e => void generate(e)}>
            <label htmlFor="ai-prompt">
              Natural-language request (tables, roles, storage, realtime, functions)
            </label>
            <textarea
              id="ai-prompt"
              rows={5}
              cols={80}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Build an ecommerce backend with products, customers, orders and order items. Send an email when a new order is created."
            />
            <p>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || prompt.trim().length < 10}
              >
                {busy ? 'Generating…' : 'Generate Backend'}
              </button>
            </p>
          </form>
          <h2>Previous plans</h2>
          {plans === null ? (
            <LoadingSkeleton label="Loading plans" />
          ) : plans.length === 0 ? (
            <EmptyState
              title="No plans yet"
              hint="Describe a backend above — the plan appears here for review before anything is built."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Summary</th>
                  <th scope="col">Status</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {plans.map(p => (
                  <tr key={p.id}>
                    <td>{p.summary.slice(0, 100)}</td>
                    <td>{p.status}</td>
                    <td>
                      <button className="btn" type="button" onClick={() => void loadDetail(p.id)}>
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      {stage !== 'prompt' && detail ? (
        <>
          <h2>Analysis</h2>
          <p>{detail.summary}</p>
          <p className="muted">
            Provider: {detail.provider} · Model: {detail.model} · Status:{' '}
            <strong>{detail.status}</strong>
          </p>

          <h2>Architecture</h2>
          <dl>
            <div>
              <dt>Tables</dt>
              <dd>{detail.plan.database.tables.map(t => t.name).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>{detail.plan.auth.roles.map(r => r.name).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Buckets</dt>
              <dd>{detail.plan.storage.buckets.map(b => b.name).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Channels</dt>
              <dd>{detail.plan.realtime.channels.map(c => c.topic).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Functions</dt>
              <dd>{detail.plan.functions.map(f => f.name).join(', ') || '—'}</dd>
            </div>
          </dl>

          <h2>Changes</h2>
          <table>
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
                  <td>{c.op}</td>
                  <td>{c.section}</td>
                  <td>{c.text}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Validation</h2>
          {detail.validation.ok ? (
            <p role="status">Plan is structurally valid.</p>
          ) : (
            <div role="alert">
              <strong>Blocked:</strong>
              <ul>
                {detail.validation.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {detail.validation.warnings.map((w, i) => (
            <p key={i} className="muted">
              Note: {w}
            </p>
          ))}
          {detail.validation.destructive.length > 0 ? (
            <div role="alert">
              <strong>
                Destructive operations detected: {detail.validation.destructive.join(', ')}
              </strong>
              <p className="muted">
                Approval alone is not enough — type each operation name (comma-separated) into the
                confirmation box to proceed.
              </p>
            </div>
          ) : null}

          <h2>Preview</h2>
          {detail.migrationSql.length > 0 ? (
            <pre>{detail.migrationSql.join('\n').slice(0, 6000)}</pre>
          ) : (
            <p className="muted">No database statements in this plan.</p>
          )}

          {detail.status === 'pending' ? (
            <>
              <h2>Approval</h2>
              <label htmlFor="ai-confirm">Destructive confirmations (if any)</label>
              <input
                id="ai-confirm"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder="e.g. DROP TABLE"
              />
              <p>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy}
                >
                  Approve
                </button>{' '}
                <button className="btn" type="button" onClick={() => void reject()} disabled={busy}>
                  Reject
                </button>
              </p>
            </>
          ) : null}

          {detail.status === 'approved' ? (
            <>
              <h2>Deployment</h2>
              <p>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy}
                >
                  {busy ? 'Applying…' : 'Apply plan'}
                </button>
              </p>
            </>
          ) : null}

          {detail.steps.length > 0 ? (
            <>
              <h2>Result</h2>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">OK</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.steps.map((s, i) => (
                    <tr key={i}>
                      <td>{s.step}</td>
                      <td>{s.ok ? 'yes' : 'no'}</td>
                      <td>{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
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
              Back to builder
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
}
