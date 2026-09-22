'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiBase, apiFetch } from '../lib/api';
import { listEnvironments, resolveActive, type DbEnvironment } from '../lib/environments';
import { CopyButton, CopyField, Modal } from './ui';

/**
 * One place to connect an application to a CloudNivo project.
 *
 * Before this existed, wiring up a client meant visiting Database for the
 * connection string, API for keys, Storage for the bucket and Settings for
 * the project id. This dialog gathers all of it and owns the actions those
 * pages used to own — it does not duplicate them, it is the front door.
 *
 * Two honesty rules shape the whole component:
 *
 * 1. Every value shown is read from this project. Nothing is a sample. Where
 *    a value genuinely cannot be produced, the dialog says so and offers the
 *    action that produces it, rather than printing a plausible-looking
 *    string a developer would paste and wonder about.
 * 2. API keys are stored as sha256 hashes (packages/api-engine/src/keys.ts) —
 *    the raw key exists exactly once, at issue time. So an existing key can
 *    show its prefix and nothing more, and a copyable key is something you
 *    create here and copy now. Pretending otherwise would mean weakening key
 *    storage, which is a decision for the operator, not for a dialog.
 *
 * Secrets (service key, database password) are masked until explicitly
 * revealed, are never written to the DOM before that, and the database
 * reveal goes through the existing audited endpoint.
 */

const DEFAULT_BUCKET = 'business-data';

type TabId = 'connection' | 'keys' | 'database' | 'storage' | 'code' | 'agent';

const TABS: { id: TabId; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'keys', label: 'API keys' },
  { id: 'database', label: 'Database' },
  { id: 'storage', label: 'Storage' },
  { id: 'code', label: 'Code' },
  { id: 'agent', label: 'Coding agent' },
];

/**
 * The agent tab's payload comes from GET /projects/:id/connect — the same
 * endpoint the CLI and SDK read, so what a developer copies here is exactly
 * what `cloudnivo connect` prints. No second source of truth.
 */
interface ConnectBundle {
  agentToken: { issue: string; verify: string; note: string };
  install: { cli: string; sdk: string; login: string; link: string };
  urls: { api: string; discovery: string };
  env: { lines: string[]; variables: { name: string; value: string; secret: boolean; note: string }[] };
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  role: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface BucketRow {
  name: string;
  visibility: 'public' | 'private';
}

interface MaskedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  connectionString: string;
}

interface RevealedConnection extends MaskedConnection {
  password: string;
}

/** A key issued in THIS dialog session: the only time a raw value exists. */
interface IssuedKey {
  role: 'public' | 'service';
  raw: string;
  name: string;
}

function Secret({
  value,
  label,
  shown,
  onToggle,
}: {
  value: string;
  label: string;
  shown: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="copy-field">
      <code aria-label={label}>{shown ? value : '•'.repeat(Math.min(44, value.length))}</code>
      <button type="button" className="btn btn-sm" onClick={onToggle} aria-pressed={shown}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <CopyButton text={value} />
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="connect-row">
      <div className="connect-row-head">
        <span className="connect-k">{label}</span>
        {hint ? <span className="connect-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function ConnectDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}): React.JSX.Element {
  const base = apiBase();
  const [tab, setTab] = useState<TabId>('connection');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [buckets, setBuckets] = useState<BucketRow[] | null>(null);
  const [masked, setMasked] = useState<MaskedConnection | null>(null);
  const [dbUnavailable, setDbUnavailable] = useState<string | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null);
  const [env, setEnv] = useState<DbEnvironment | null>(null);

  const [revealed, setRevealed] = useState<RevealedConnection | null>(null);
  const [showDb, setShowDb] = useState(false);
  const [issued, setIssued] = useState<IssuedKey[]>([]);
  const [shownSecret, setShownSecret] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const projectUrl = `${base}/api/v1/projects/${projectId}`;
  const storageUrl = `${projectUrl}/storage`;
  const [bundle, setBundle] = useState<ConnectBundle | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [k, b, c] = await Promise.all([
        apiFetch<{ keys: ApiKeyRow[] }>(`/api/v1/projects/${projectId}/keys`),
        apiFetch<{ buckets: BucketRow[] }>(`/api/v1/projects/${projectId}/storage/buckets`),
        apiFetch<MaskedConnection>(`/api/v1/projects/${projectId}/database/connection`),
      ]);
      if (!k.ok) setError(k.error ?? 'Could not read this project');
      setKeys(k.data?.keys ?? []);
      // Storage and the database can each be unavailable on their own (not
      // provisioned yet, or the caller's role does not admit them). Each
      // section says which, instead of one error hiding the whole dialog.
      setBuckets(b.data?.buckets ?? null);
      setStorageUnavailable(b.ok ? null : (b.error ?? 'Storage is unavailable for this project'));
      setMasked(c.data ?? null);
      setDbUnavailable(c.ok ? null : (c.error ?? 'No database is provisioned for this project yet'));
      // Environments are optional (the route 404s on older backends), so a
      // missing list is a fact about this project, not a failure of the dialog.
      const e = await listEnvironments(projectId);
      setEnv(e.envs ? resolveActive(e.envs, projectId) : null);
      // Agent bundle is optional in the same way: an older backend without
      // the route leaves the tab explaining itself rather than erroring.
      const bundleRes = await apiFetch<ConnectBundle>(`/api/v1/projects/${projectId}/connect`);
      setBundle(bundleRes.ok ? (bundleRes.data ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const publicKeys = (keys ?? []).filter(k => k.role === 'public' && !k.revokedAt);
  const serviceKeys = (keys ?? []).filter(k => k.role === 'service' && !k.revokedAt);
  const issuedPublic = issued.find(i => i.role === 'public') ?? null;
  const issuedService = issued.find(i => i.role === 'service') ?? null;
  const bucket = (buckets ?? []).find(b => b.name === DEFAULT_BUCKET) ?? null;

  async function createKey(role: 'public' | 'service'): Promise<void> {
    setBusy(`key-${role}`);
    setNotice(null);
    const res = await apiFetch<{ key: ApiKeyRow; raw: string }>(
      `/api/v1/projects/${projectId}/keys`,
      { method: 'POST', body: { name: role === 'public' ? 'web client' : 'server', role } },
    );
    setBusy(null);
    if (!res.ok || !res.data) {
      setNotice(res.error ?? 'Could not create the key');
      return;
    }
    setIssued(prev => [...prev.filter(p => p.role !== role), { role, raw: res.data!.raw, name: res.data!.key.name }]);
    setKeys(prev => [res.data!.key, ...(prev ?? [])]);
    setNotice(
      role === 'public'
        ? 'Public key created. Copy it now — it is not stored and cannot be shown again.'
        : 'Service key created. Copy it now and keep it server-side; it cannot be shown again.',
    );
  }

  async function revealDb(): Promise<void> {
    setBusy('db');
    setNotice(null);
    const res = await apiFetch<RevealedConnection>(
      `/api/v1/projects/${projectId}/database/connection?reveal=true`,
    );
    setBusy(null);
    if (!res.ok || !res.data) {
      setNotice(res.error ?? 'Could not reveal the connection string');
      return;
    }
    setRevealed(res.data);
    setShowDb(true);
  }

  async function createBucket(): Promise<void> {
    setBusy('bucket');
    setNotice(null);
    const res = await apiFetch<{ bucket: BucketRow }>(
      `/api/v1/projects/${projectId}/storage/buckets`,
      { method: 'POST', body: { name: DEFAULT_BUCKET, visibility: 'private' } },
    );
    setBusy(null);
    if (!res.ok || !res.data) {
      setNotice(res.error ?? 'Could not create the bucket');
      return;
    }
    setBuckets(prev => [...(prev ?? []), res.data!.bucket]);
    setNotice(`Bucket ${DEFAULT_BUCKET} created (private).`);
  }

  /**
   * Safe values only: the project's addresses and identifiers, plus a public
   * key when one was issued in this session. A service key or database
   * password is never part of a bulk copy — those leave only by a
   * deliberate, individual act.
   */
  const safeBundle = useMemo(() => {
    const lines = [
      `CLOUDNIVO_API_URL=${base}`,
      `CLOUDNIVO_PROJECT_ID=${projectId}`,
      `CLOUDNIVO_PROJECT_URL=${projectUrl}`,
      `CLOUDNIVO_STORAGE_URL=${storageUrl}`,
      `CLOUDNIVO_BUCKET=${DEFAULT_BUCKET}`,
    ];
    if (env) lines.push(`CLOUDNIVO_ENVIRONMENT=${env.slug}`);
    if (issuedPublic) lines.push(`CLOUDNIVO_PUBLIC_KEY=${issuedPublic.raw}`);
    return lines.join('\n');
  }, [base, projectId, projectUrl, storageUrl, env, issuedPublic]);

  const envExample = useMemo(() => {
    const out = [...safeBundle.split('\n')];
    if (!issuedPublic) {
      out.push('# Create a public key on the API keys tab, then paste it here:');
      out.push('CLOUDNIVO_PUBLIC_KEY=');
    }
    out.push('');
    out.push('# ── Server-side only. Never ship these to a browser. ──');
    out.push(
      issuedService
        ? `CLOUDNIVO_SERVICE_KEY=${issuedService.raw}`
        : '# Create a service key on the API keys tab, then paste it here:\nCLOUDNIVO_SERVICE_KEY=',
    );
    out.push(
      revealed
        ? `DATABASE_URL=${revealed.connectionString}`
        : '# Reveal the connection string on the Database tab, then paste it here:\nDATABASE_URL=',
    );
    return out.join('\n');
  }, [safeBundle, issuedPublic, issuedService, revealed]);

  const sdkSnippet = useMemo(
    () =>
      [
        "import { CloudNivoClient } from '@cloudnivo/sdk';",
        '',
        'const cn = new CloudNivoClient({',
        '  baseUrl: process.env.CLOUDNIVO_API_URL!,',
        '  // Browser code uses the public key; server code uses the service key.',
        '  apikey: process.env.CLOUDNIVO_PUBLIC_KEY!,',
        '});',
        '',
        `const projectId = process.env.CLOUDNIVO_PROJECT_ID!;`,
      ].join('\n'),
    [],
  );

  const curlSnippet = useMemo(
    () =>
      [
        `curl -H "apikey: $CLOUDNIVO_PUBLIC_KEY" \\`,
        `  "${projectUrl}/<your-table>?limit=20"`,
      ].join('\n'),
    [projectUrl],
  );

  const [lang, setLang] = useState<'env' | 'ts' | 'curl'>('env');
  const [showSnippetSecrets, setShowSnippetSecrets] = useState(false);
  const snippet = lang === 'env' ? envExample : lang === 'ts' ? sdkSnippet : curlSnippet;

  /**
   * What the snippet LOOKS like is not what it copies. A filled .env is the
   * whole point of this tab, but rendering a service key and a database
   * password at full size means every screen-share and every shoulder leaks
   * them. The display masks the values after `=`; Copy still carries the real
   * ones, because copying is the deliberate act.
   */
  const secretValues = useMemo(
    () =>
      [issuedService?.raw, revealed?.connectionString, revealed?.password].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    [issuedService, revealed],
  );
  const displayedSnippet = useMemo(() => {
    if (showSnippetSecrets || secretValues.length === 0) return snippet;
    return secretValues.reduce(
      (acc, secret) => acc.split(secret).join('•'.repeat(Math.min(32, secret.length))),
      snippet,
    );
  }, [snippet, secretValues, showSnippetSecrets]);

  return (
    <Modal title={`Connect to ${projectName}`} onClose={onClose}>
      <div className="connect">
        <div className="connect-tabs" role="tablist" aria-label="Connect sections">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {notice ? (
          <p className="connect-notice" role="status">
            {notice}
          </p>
        ) : null}

        {loading ? (
          <p className="muted" role="status">
            Reading this project…
          </p>
        ) : error ? (
          <div className="error-box" role="alert">
            <strong>Couldn&apos;t read this project</strong>
            <p className="muted">{error}</p>
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="connect-body">
            {tab === 'connection' ? (
              <>
                <Row label="Project URL" hint="Every project API call starts here.">
                  <CopyField text={projectUrl} label="Project URL" />
                </Row>
                <Row label="API base URL">
                  <CopyField text={base} label="API base URL" />
                </Row>
                <Row label="Project ID">
                  <CopyField text={projectId} label="Project ID" />
                </Row>
                <Row label="Environment" hint={env ? undefined : 'No environments configured.'}>
                  {env ? (
                    <CopyField text={env.slug} label="Environment" />
                  ) : (
                    <p className="muted">
                      This project has no environment rows, so calls run against the main database.
                    </p>
                  )}
                </Row>
                <Row label="Storage endpoint">
                  <CopyField text={storageUrl} label="Storage endpoint" />
                </Row>
                <div className="connect-actions">
                  <CopyButton text={safeBundle} label="Copy all safe values" />
                  <span className="connect-hint">
                    Addresses and identifiers only. Secrets are copied one at a time, deliberately.
                  </span>
                </div>
              </>
            ) : null}

            {tab === 'keys' ? (
              <>
                <p className="connect-hint">
                  CloudNivo stores only a hash of each key, so a key&apos;s value exists once — when
                  you create it. Existing keys show their prefix; create a new one here to get a
                  value you can copy.
                </p>

                <Row
                  label="Public key"
                  hint="Read-only. Safe to ship in a browser or mobile app; still rate-limited."
                >
                  {issuedPublic ? (
                    <Secret
                      value={issuedPublic.raw}
                      label="Public key"
                      shown={shownSecret['public'] ?? true}
                      onToggle={() =>
                        setShownSecret(s => ({ ...s, public: !(s['public'] ?? true) }))
                      }
                    />
                  ) : publicKeys.length > 0 ? (
                    <p className="muted">
                      {publicKeys.length} active public{' '}
                      {publicKeys.length === 1 ? 'key' : 'keys'} (
                      {publicKeys.map(k => k.prefix).join(', ')}…). The value cannot be shown again.
                    </p>
                  ) : (
                    <p className="muted">No public key yet.</p>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy === 'key-public'}
                    onClick={() => void createKey('public')}
                  >
                    {busy === 'key-public'
                      ? 'Creating…'
                      : publicKeys.length > 0
                        ? 'Create another public key'
                        : 'Create public key'}
                  </button>
                </Row>

                <Row
                  label="Service key"
                  hint="Read and write. SERVER-SIDE ONLY — never put this in browser code."
                >
                  <p className="connect-warn" role="note">
                    A service key bypasses row-level security. Anyone holding it can read and write
                    everything in this project.
                  </p>
                  {issuedService ? (
                    <Secret
                      value={issuedService.raw}
                      label="Service key"
                      shown={shownSecret['service'] ?? false}
                      onToggle={() =>
                        setShownSecret(s => ({ ...s, service: !(s['service'] ?? false) }))
                      }
                    />
                  ) : serviceKeys.length > 0 ? (
                    <p className="muted">
                      {serviceKeys.length} active service{' '}
                      {serviceKeys.length === 1 ? 'key' : 'keys'} (
                      {serviceKeys.map(k => k.prefix).join(', ')}…). The value cannot be shown again.
                    </p>
                  ) : (
                    <p className="muted">No service key yet.</p>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy === 'key-service'}
                    onClick={() => void createKey('service')}
                  >
                    {busy === 'key-service'
                      ? 'Creating…'
                      : serviceKeys.length > 0
                        ? 'Create another service key'
                        : 'Create service key'}
                  </button>
                </Row>
              </>
            ) : null}

            {tab === 'database' ? (
              <>
                {dbUnavailable ? (
                  <p className="muted">{dbUnavailable}</p>
                ) : masked ? (
                  <>
                    <p className="connect-warn" role="note">
                      SERVER-SIDE ONLY. The connection string carries the database password —
                      revealing it is recorded in this project&apos;s audit log.
                    </p>
                    <Row label="Connection string">
                      {revealed ? (
                        <Secret
                          value={revealed.connectionString}
                          label="PostgreSQL connection string"
                          shown={showDb}
                          onToggle={() => setShowDb(v => !v)}
                        />
                      ) : (
                        <div className="copy-field">
                          <code aria-label="PostgreSQL connection string, masked">
                            {masked.connectionString}
                          </code>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy === 'db'}
                            onClick={() => void revealDb()}
                          >
                            {busy === 'db' ? 'Revealing…' : 'Reveal'}
                          </button>
                        </div>
                      )}
                    </Row>
                    <Row label="Host">
                      <CopyField text={masked.host} label="Database host" />
                    </Row>
                    <Row label="Port">
                      <CopyField text={String(masked.port)} label="Database port" />
                    </Row>
                    <Row label="Database">
                      <CopyField text={masked.database} label="Database name" />
                    </Row>
                    <Row label="User">
                      <CopyField text={masked.user} label="Database user" />
                    </Row>
                  </>
                ) : (
                  <p className="muted">No database is provisioned for this project yet.</p>
                )}
              </>
            ) : null}

            {tab === 'storage' ? (
              <>
                <Row label="Storage endpoint">
                  <CopyField text={storageUrl} label="Storage endpoint" />
                </Row>
                {storageUnavailable ? (
                  <p className="muted">{storageUnavailable}</p>
                ) : (
                  <Row label="Default bucket">
                    <CopyField text={DEFAULT_BUCKET} label="Bucket name" />
                    {bucket ? (
                      <p className="muted">
                        Exists · {bucket.visibility}
                        {bucket.visibility === 'public'
                          ? ' — anyone with the URL can read its objects.'
                          : ' — reads require a key.'}
                      </p>
                    ) : (
                      <>
                        <p className="muted">
                          This bucket does not exist yet, so uploads to it will fail.
                        </p>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy === 'bucket'}
                          onClick={() => void createBucket()}
                        >
                          {busy === 'bucket' ? 'Creating…' : `Create ${DEFAULT_BUCKET}`}
                        </button>
                      </>
                    )}
                  </Row>
                )}
              </>
            ) : null}

            {tab === 'agent' ? (
              <>
                <p className="connect-hint">
                  Point Claude Code, Cursor, Codex, or any other coding agent at this project. The
                  agent gets a scoped <code>cn_agent_…</code> token — never your session, never the
                  database password, and never a key it can use to widen its own access.
                </p>
                <Row label="1 · Issue a token" hint="Scopes, expiry and approval gate are chosen there">
                  <a className="btn btn-primary btn-sm" href="/agents">
                    Open Agent access
                  </a>
                </Row>
                <Row
                  label="2 · Environment"
                  hint="Copy into the agent's environment or secret manager — never into git"
                >
                  <div className="connect-actions">
                    <div className="connect-actions-right">
                      <CopyButton
                        text={(bundle?.env.lines ?? []).join('\n')}
                        label="Copy environment"
                      />
                    </div>
                  </div>
                  <pre className="connect-snippet" aria-label="Agent environment">
                    {bundle
                      ? bundle.env.lines.join('\n')
                      : `CLOUDNIVO_URL=${base}\nCLOUDNIVO_PROJECT_ID=${projectId}\nCLOUDNIVO_AGENT_TOKEN=cn_agent_…`}
                  </pre>
                  <p className="connect-hint">
                    The token value is shown once, when you create it. Nothing on this page can read
                    it back.
                  </p>
                </Row>
                <Row label="3 · Install and link">
                  <CopyField
                    text={`${bundle?.install.cli ?? 'npm install -g @cloudnivo/cli'}\ncloudnivo login --agent-token cn_agent_…\ncloudnivo link --project ${projectId}\ncloudnivo status`}
                    label="CLI setup"
                  />
                </Row>
                <Row
                  label="4 · Let the agent discover the rest"
                  hint="No credential needed for this one"
                >
                  <CopyField
                    text={bundle?.urls.discovery ?? `${base}/api/v1/discovery`}
                    label="Capability discovery URL"
                  />
                </Row>
                <p className="connect-hint">
                  Production and destructive changes stop for human approval. Every agent action is
                  recorded under Agent access → Activity.
                </p>
              </>
            ) : null}

            {tab === 'code' ? (
              <>
                <Row label="Install">
                  <CopyField text="npm install @cloudnivo/sdk" label="Install command" />
                </Row>
                <div className="connect-actions">
                  <div className="connect-langs" role="tablist" aria-label="Snippet format">
                    {(
                      [
                        ['env', '.env'],
                        ['ts', 'TypeScript'],
                        ['curl', 'curl'],
                      ] as [typeof lang, string][]
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={lang === id}
                        className={lang === id ? 'active' : ''}
                        onClick={() => setLang(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="connect-actions-right">
                    {secretValues.length > 0 ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-pressed={showSnippetSecrets}
                        onClick={() => setShowSnippetSecrets(v => !v)}
                      >
                        {showSnippetSecrets ? 'Hide secrets' : 'Show secrets'}
                      </button>
                    ) : null}
                    <CopyButton text={snippet} label="Copy snippet" />
                  </div>
                </div>
                <pre className="connect-snippet" aria-label="Connection snippet">
                  {displayedSnippet}
                </pre>
                {secretValues.length > 0 && !showSnippetSecrets ? (
                  <p className="connect-hint">
                    Secret values are masked on screen. Copy snippet still copies the real ones.
                  </p>
                ) : null}
                <p className="connect-hint">
                  Secrets appear here only after you have revealed them on their own tab — otherwise
                  the variable is left empty rather than filled with something that looks real.
                </p>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
