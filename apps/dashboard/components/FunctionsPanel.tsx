'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

interface FnRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  runtime: string;
  entrypoint: string;
  status: string;
  activeVersion: number;
  lastError: string | null;
  deployedAt: string | null;
}

interface DeployJob {
  id: string;
  version: number;
  status: string;
  lastError: string | null;
  logs: string[];
  updatedAt: string;
}

interface LogEntry {
  id: string;
  version: number;
  timestamp: string;
  level: string;
  message: string;
  executionTimeMs: number | null;
  status: string;
}

interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
}

interface VersionRow {
  version: number;
  sourceHash: string;
  active: boolean;
  createdAt: string;
}

const STARTER = `module.exports.handler = async (req) => {
  return {
    status: 200,
    body: { hello: req.auth.userId ?? 'world', echo: req.body ?? null },
  };
};
`;

export function FunctionsPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/functions`;
  const [functions, setFunctions] = useState<FnRecord[] | null>(null);
  const [active, setActive] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [source, setSource] = useState(STARTER);
  const [entrypoint, setEntrypoint] = useState('handler');
  const [job, setJob] = useState<DeployJob | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [env, setEnv] = useState<EnvVar[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const [envSecret, setEnvSecret] = useState(true);
  const [invokeBody, setInvokeBody] = useState('{}');
  const [invokeResult, setInvokeResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFunctions = useCallback(async () => {
    const r = await apiFetch<{ functions: FnRecord[] }>(base);
    if (!r.ok) setError(r.error);
    else {
      setFunctions(r.data?.functions ?? []);
      setError(null);
    }
  }, [base]);

  const loadDetail = useCallback(async () => {
    if (!active) {
      setJob(null);
      setLogs([]);
      setEnv([]);
      setVersions([]);
      return;
    }
    const [d, l, e, v] = await Promise.all([
      apiFetch<{ deployments: DeployJob[] }>(`${base}/${active}/deployments`),
      apiFetch<{ logs: LogEntry[] }>(`${base}/${active}/logs?limit=100`),
      apiFetch<{ env: EnvVar[] }>(`${base}/${active}/env`),
      apiFetch<{ versions: VersionRow[] }>(`${base}/${active}/versions`),
    ]);
    if (d.ok && d.data) setJob(d.data.deployments[0] ?? null);
    if (l.ok && l.data) setLogs(l.data.logs);
    if (e.ok && e.data) setEnv(e.data.env);
    if (v.ok && v.data) setVersions(v.data.versions);
  }, [base, active]);

  useEffect(() => {
    void loadFunctions();
  }, [loadFunctions]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Poll while a deployment is in flight — shows actual state, never faked.
  useEffect(() => {
    if (
      !job ||
      (job.status !== 'pending' && job.status !== 'building' && job.status !== 'deploying')
    )
      return;
    const t = setInterval(() => void loadDetail(), 1500);
    return () => clearInterval(t);
  }, [job, loadDetail]);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const r = await apiFetch<{ function: FnRecord }>(base, {
      method: 'POST',
      body: { name, slug },
    });
    if (!r.ok) setError(r.error);
    else if (r.data) {
      setName('');
      setSlug('');
      setActive(r.data.function.slug);
      setNotice(`Function "${r.data.function.slug}" created. Deploy source to activate it.`);
      void loadFunctions();
    }
  }

  async function deploy(): Promise<void> {
    if (!active) return;
    setBusy(true);
    setError(null);
    const r = await apiFetch<{ job: DeployJob }>(`${base}/${active}/deploy`, {
      method: 'POST',
      body: { source, entrypoint },
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (r.data) {
      setJob(r.data.job);
      setNotice(`Deployment ${r.data.job.id} started — polling actual state.`);
    }
  }

  async function invoke(): Promise<void> {
    if (!active) return;
    setError(null);
    let body: unknown = null;
    try {
      body = invokeBody.trim() ? (JSON.parse(invokeBody) as unknown) : null;
    } catch {
      setError('Invoke body is not valid JSON');
      return;
    }
    const r = await apiFetch(`${base}/${active}/invoke`, { method: 'POST', body });
    if (!r.ok) setInvokeResult(`Error: ${r.error}`);
    else setInvokeResult(JSON.stringify(r.data, null, 2));
    void loadDetail();
  }

  async function saveEnv(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const r = await apiFetch(`${base}/${active}/env`, {
      method: 'PUT',
      body: { key: envKey, value: envValue, secret: envSecret },
    });
    if (!r.ok) setError(r.error);
    else {
      setEnvKey('');
      setEnvValue('');
      void loadDetail();
    }
  }

  async function activate(version: number): Promise<void> {
    const r = await apiFetch(`${base}/${active}/versions/${version}/activate`, {
      method: 'POST',
      body: {},
    });
    if (!r.ok) setError(r.error);
    else {
      setNotice(`Rolled back to v${version}.`);
      void loadFunctions();
      void loadDetail();
    }
  }

  async function remove(): Promise<void> {
    if (!active || !window.confirm(`Delete function "${active}" and all its versions?`)) return;
    const r = await apiFetch(`${base}/${active}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error);
    else {
      setActive('');
      setNotice('Function deleted.');
      void loadFunctions();
    }
  }

  if (functions === null) return <LoadingSkeleton label="Loading functions" />;

  return (
    <div>
      {error ? <ErrorState message={error} /> : null}
      {notice ? (
        <p role="status" className="muted">
          {notice}
        </p>
      ) : null}

      <h2>Overview</h2>
      {functions.length === 0 ? (
        <EmptyState
          title="No functions yet"
          hint="Create your first function below — then deploy source to invoke it."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Function</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Deployed</th>
            </tr>
          </thead>
          <tbody>
            {functions.map(f => (
              <tr key={f.id}>
                <td>
                  <button className="btn" type="button" onClick={() => setActive(f.slug)}>
                    <code>{f.slug}</code>
                  </button>
                </td>
                <td>
                  {f.status}
                  {f.lastError ? ` (${f.lastError.slice(0, 80)})` : ''}
                </td>
                <td>{f.activeVersion > 0 ? `v${f.activeVersion}` : '—'}</td>
                <td>{f.deployedAt ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>All Functions — create</h2>
      <form onSubmit={e => void create(e)}>
        <label>
          Name <input value={name} onChange={e => setName(e.target.value)} placeholder="Greeter" />
        </label>{' '}
        <label>
          Slug <input value={slug} onChange={e => setSlug(e.target.value)} placeholder="greeter" />
        </label>{' '}
        <button className="btn btn-primary" type="submit">
          Create
        </button>
      </form>

      {active ? (
        <>
          <h2>Deployments — {active}</h2>
          <p role="status" className="muted">
            {job ? (
              <>
                {job.id}: <strong>{job.status}</strong>
                {job.status === 'failed' && job.lastError ? ` — ${job.lastError}` : ''}
              </>
            ) : (
              'No deployments yet.'
            )}
          </p>
          <label>
            Entrypoint{' '}
            <input
              value={entrypoint}
              onChange={e => setEntrypoint(e.target.value)}
              placeholder="handler"
            />
          </label>
          <div>
            <label htmlFor="fn-source">Source (CommonJS, export an async handler)</label>
            <textarea
              id="fn-source"
              rows={12}
              cols={80}
              value={source}
              onChange={e => setSource(e.target.value)}
              spellCheck={false}
            />
          </div>
          <p>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void deploy()}
              disabled={busy}
            >
              {busy ? 'Deploying…' : 'Deploy'}
            </button>{' '}
            <button className="btn" type="button" onClick={() => void invoke()}>
              Invoke
            </button>{' '}
            <button className="btn" type="button" onClick={() => void remove()}>
              Delete
            </button>
          </p>
          <div>
            <label htmlFor="fn-invoke">Invoke body (JSON)</label>
            <textarea
              id="fn-invoke"
              rows={3}
              cols={80}
              value={invokeBody}
              onChange={e => setInvokeBody(e.target.value)}
              spellCheck={false}
            />
          </div>
          {invokeResult ? <pre>{invokeResult.slice(0, 8000)}</pre> : null}

          <h2>Logs</h2>
          {logs.length === 0 ? (
            <EmptyState title="No logs" hint="Invoke the function to generate entries." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Level</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 50).map(l => (
                  <tr key={l.id}>
                    <td>{l.timestamp}</td>
                    <td>{l.level}</td>
                    <td>{l.message.slice(0, 300)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Environment Variables</h2>
          {env.length === 0 ? (
            <EmptyState
              title="No variables"
              hint="Secrets are masked everywhere outside the runtime."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {env.map(v => (
                  <tr key={v.key}>
                    <td>
                      <code>{v.key}</code>
                    </td>
                    <td>
                      <code>{v.value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form onSubmit={e => void saveEnv(e)}>
            <label>
              Key{' '}
              <input
                value={envKey}
                onChange={e => setEnvKey(e.target.value)}
                placeholder="API_TOKEN"
              />
            </label>{' '}
            <label>
              Value{' '}
              <input value={envValue} onChange={e => setEnvValue(e.target.value)} placeholder="…" />
            </label>{' '}
            <label>
              <input
                type="checkbox"
                checked={envSecret}
                onChange={e => setEnvSecret(e.target.checked)}
              />{' '}
              secret
            </label>{' '}
            <button className="btn" type="submit">
              Save
            </button>
          </form>

          <h2>Versions</h2>
          {versions.length === 0 ? (
            <EmptyState title="No versions" hint="Each deploy creates an immutable version." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Hash</th>
                  <th scope="col">Active</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {versions.map(v => (
                  <tr key={v.version}>
                    <td>v{v.version}</td>
                    <td>
                      <code>{v.sourceHash.slice(0, 12)}</code>
                    </td>
                    <td>{v.active ? 'yes' : 'no'}</td>
                    <td>
                      {!v.active ? (
                        <button
                          className="btn"
                          type="button"
                          onClick={() => void activate(v.version)}
                        >
                          Roll back
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Settings</h2>
          <p className="muted">
            Runtime <code>node22</code> — handler signature <code>handler(request)</code> with{' '}
            <code>{'{ method, path, headers, query, body, auth }'}</code> and a frozen{' '}
            <code>cloudnivo</code> SDK (<code>auth, project, env</code>). Limits are server-enforced
            via environment (<code>FUNCTION_EXECUTION_TIMEOUT_MS</code>,{' '}
            <code>FUNCTION_MEMORY_MB</code>, <code>FUNCTION_MAX_BODY_BYTES</code>,{' '}
            <code>FUNCTION_MAX_CONCURRENCY</code>). See <code>docs/functions.md</code>.
          </p>
        </>
      ) : null}
    </div>
  );
}
