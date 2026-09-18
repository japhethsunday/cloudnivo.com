'use client';

import { useCallback, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { EmptyState, ErrorState, LoadingTable } from '../States';
import { Badge, statusTone, useToast } from '../ui';
import { Toolbar, useAdminResource } from './AdminShell';
import type { EmailRow, EmailStatus, EmailTemplate, EmailsView } from './types';

/**
 * Email Center: Compose · Templates · Sent · Delivery logs.
 *
 * The composer sends through a staff-gated server endpoint. The Resend key
 * is never in this bundle — the browser posts a subject and a body, and the
 * server renders the branded letterhead and talks to the provider.
 *
 * The statuses shown here are the provider's own verdict, relayed. `sent`
 * means the provider accepted the message; it does not mean delivered, and
 * this UI never upgrades it to that on its own.
 */

const TABS = [
  { id: 'compose', label: 'Compose' },
  { id: 'templates', label: 'Templates' },
  { id: 'sent', label: 'Sent' },
  { id: 'logs', label: 'Delivery logs' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function statusToneOf(status: EmailStatus): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'sent') return 'ok';
  if (status === 'failed' || status === 'bounced' || status === 'complained') return 'bad';
  if (status === 'queued') return 'warn';
  return 'muted';
}

export function EmailCenter(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('compose');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | EmailStatus>('');
  const listPath = useMemo(() => {
    const p = new URLSearchParams({ limit: '100' });
    if (statusFilter) p.set('status', statusFilter);
    if (query.trim()) p.set('q', query.trim());
    return `/api/v1/admin/emails?${p.toString()}`;
  }, [statusFilter, query]);

  const list = useAdminResource<EmailsView>(listPath);
  const templates = useAdminResource<{ templates: EmailTemplate[] }>(
    '/api/v1/admin/emails/templates',
  );

  return (
    <div>
      <div
        className="subtabs"
        role="tablist"
        aria-label="Email Center sections"
        style={{ marginBottom: 16 }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'sent' && list.data ? (
              <span className="count-chip">{list.data.counts['sent'] ?? 0}</span>
            ) : null}
            {t.id === 'logs' && list.data && (list.data.counts['failed'] ?? 0) > 0 ? (
              <span className="count-chip count-bad">{list.data.counts['failed']}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'compose' ? (
        <Composer
          templates={templates.data?.templates ?? []}
          sender={list.data?.sender ?? null}
          onSent={() => {
            list.reload();
            setTab('sent');
          }}
        />
      ) : null}

      {tab === 'templates' ? <Templates templates={templates.data?.templates ?? []} /> : null}

      {tab === 'sent' || tab === 'logs' ? (
        <>
          <Toolbar value={query} onChange={setQuery} placeholder="Search subject, recipient, sender…">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as '' | EmailStatus)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="sent">Sent</option>
              <option value="queued">Queued</option>
              <option value="failed">Failed</option>
              <option value="bounced">Bounced</option>
              <option value="complained">Complained</option>
            </select>
            <button type="button" className="btn btn-sm btn-quiet" onClick={list.reload}>
              Refresh
            </button>
          </Toolbar>
          <EmailTable
            view={list}
            showErrors={tab === 'logs'}
            emptyHint={
              tab === 'logs'
                ? 'No delivery attempts recorded yet. Every send — including failures — lands here.'
                : 'No email has been sent from this console yet.'
            }
          />
        </>
      ) : null}
    </div>
  );
}

function EmailTable({
  view,
  showErrors,
  emptyHint,
}: {
  view: ReturnType<typeof useAdminResource<EmailsView>>;
  showErrors: boolean;
  emptyHint: string;
}): React.JSX.Element {
  if (view.loading) return <LoadingTable label="Loading email history" rows={5} />;
  if (view.error)
    return <ErrorState title="Couldn't load email history" message={view.error} retry={view.reload} />;
  const rows = view.data?.emails ?? [];
  if (rows.length === 0) return <EmptyState title="Nothing here yet" hint={emptyHint} />;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Subject</th>
            <th scope="col" className="hide-sm">Recipients</th>
            <th scope="col" className="hide-sm">Sent by</th>
            <th scope="col">Status</th>
            <th scope="col" className="hide-sm">When</th>
            {showErrors ? <th scope="col">Provider</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className={`state-row state-${statusToneOf(r.status)}`}>
              <td>
                {r.subject}
                {r.isTest ? <span className="tag-inline">test</span> : null}
                {showErrors && r.error ? <div className="row-error">{r.error}</div> : null}
              </td>
              <td className="reading hide-sm">
                {r.recipients.slice(0, 2).join(', ')}
                {r.recipients.length > 2 ? ` +${r.recipients.length - 2}` : ''}
                {r.cc.length + r.bcc.length > 0 ? (
                  <span className="muted"> · {r.cc.length + r.bcc.length} copied</span>
                ) : null}
              </td>
              <td className="reading hide-sm">{r.actorEmail}</td>
              <td>
                <span className={`state-word state-${statusToneOf(r.status)}`}>{r.status}</span>
              </td>
              <td className="reading hide-sm">{timeAgo(r.sentAt ?? r.createdAt)}</td>
              {showErrors ? (
                <td className="reading">
                  {r.provider ?? '—'}
                  {r.providerId ? <div className="muted">{r.providerId}</div> : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Templates({ templates }: { templates: EmailTemplate[] }): React.JSX.Element {
  if (templates.length === 0) return <LoadingTable label="Loading templates" rows={3} />;
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Why verification and password-reset are not here</h3>
        <p className="muted">
          Those emails carry tokens only the server can mint, and they are sent by the flows that
          own them — signup, and the reset form. A button here that appeared to send one would
          either do nothing or mint a credential from a text box, so the Email Center does not
          offer it. Use the account&apos;s own reset flow instead.
        </p>
      </div>
      <div className="grid-cards">
        {templates.map(t => (
          <div key={t.id} className="card">
            <h3>{t.name}</h3>
            <p className="muted">{t.description}</p>
            {t.subject ? (
              <p className="reading" style={{ marginTop: 8 }}>
                Subject: {t.subject}
              </p>
            ) : null}
            {t.bullets.length > 0 ? (
              <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {t.bullets.map(b => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Composer({
  templates,
  sender,
  onSent,
}: {
  templates: EmailTemplate[];
  sender: EmailsView['sender'] | null;
  onSent: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const [templateId, setTemplateId] = useState('custom');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [intro, setIntro] = useState('');
  const [bullets, setBullets] = useState('');
  const [closing, setClosing] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaPath, setCtaPath] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'test' | 'send'>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id);
      const t = templates.find(x => x.id === id);
      if (!t) return;
      setSubject(t.subject);
      setIntro(t.intro);
      setBullets(t.bullets.join('\n'));
      setClosing(t.closing);
      setCtaLabel(t.cta?.label ?? '');
      setCtaPath(t.cta?.path ?? '');
      setPreview(null);
    },
    [templates],
  );

  const recipientCount = useMemo(() => {
    const split = (v: string): string[] =>
      v
        .split(/[,\s]+/)
        .map(x => x.trim())
        .filter(Boolean);
    return split(to).length + split(cc).length + split(bcc).length;
  }, [to, cc, bcc]);

  const body = useMemo(
    () => ({
      to,
      cc,
      bcc,
      subject: subject.trim(),
      intro,
      bullets: bullets.split('\n').map(b => b.trim()).filter(Boolean),
      closing,
      ctaLabel,
      ctaPath,
      template: templateId,
    }),
    [to, cc, bcc, subject, intro, bullets, closing, ctaLabel, ctaPath, templateId],
  );

  const ready = subject.trim().length > 1 && (intro.trim() !== '' || bullets.trim() !== '');

  async function post(path: string, kind: 'preview' | 'test' | 'send'): Promise<void> {
    setBusy(kind);
    setError(null);
    const res = await apiFetch<{ preview?: { html: string }; email?: EmailRow; error?: string }>(
      path,
      { method: 'POST', body },
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? 'The send failed.');
      return;
    }
    if (kind === 'preview') {
      setPreview(res.data?.preview?.html ?? null);
      return;
    }
    // A 502 comes back ok:false above; reaching here means the provider
    // accepted it. Say "accepted", not "delivered".
    toast(kind === 'test' ? 'Test email accepted by the provider' : 'Email accepted by the provider');
    if (kind === 'send') onSent();
  }

  return (
    <div className="grid-2">
      <div className="card">

        {sender && !sender.ready ? (
          <div className="banner warn" role="status" style={{ marginBottom: 12 }}>
            <div className="grow">
              <strong>No email sender is configured.</strong>
              <p>
                EMAIL_DRIVER is <code>{sender.driver}</code>. Sending will be refused and recorded
                as failed rather than silently dropped.
              </p>
            </div>
          </div>
        ) : null}
        {sender?.ready ? (
          <p className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>
            Sending as <span className="reading">{sender.from}</span> via {sender.driver}.
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="mail-template">Template</label>
          <select
            id="mail-template"
            value={templateId}
            onChange={e => applyTemplate(e.target.value)}
          >
            {templates.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="mail-to">To</label>
          <input
            id="mail-to"
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="one@example.com, two@example.com"
          />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="mail-cc">Cc</label>
            <input id="mail-cc" value={cc} onChange={e => setCc(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mail-bcc">Bcc</label>
            <input id="mail-bcc" value={bcc} onChange={e => setBcc(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="mail-subject">Subject</label>
          <input id="mail-subject" value={subject} onChange={e => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="mail-intro">Body</label>
          <textarea
            id="mail-intro"
            rows={5}
            value={intro}
            onChange={e => setIntro(e.target.value)}
            placeholder="One paragraph per blank line."
          />
        </div>
        <div className="field">
          <label htmlFor="mail-bullets">Bullet points (one per line)</label>
          <textarea
            id="mail-bullets"
            rows={3}
            value={bullets}
            onChange={e => setBullets(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="mail-closing">Closing</label>
          <textarea
            id="mail-closing"
            rows={2}
            value={closing}
            onChange={e => setClosing(e.target.value)}
          />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="mail-cta-label">Button label</label>
            <input
              id="mail-cta-label"
              value={ctaLabel}
              onChange={e => setCtaLabel(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="mail-cta-path">Button path</label>
            <input
              id="mail-cta-path"
              value={ctaPath}
              onChange={e => setCtaPath(e.target.value)}
              placeholder="/dashboard"
            />
            <p className="field-hint muted">
              A path on CloudNivo only — an arbitrary link on this letterhead would be a phishing
              tool, so the server builds the URL.
            </p>
          </div>
        </div>

        {error ? <ErrorState title="Send failed" message={error} /> : null}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!ready || busy !== null}
            onClick={() => void post('/api/v1/admin/emails/preview', 'preview')}
          >
            {busy === 'preview' ? 'Rendering…' : 'Preview'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!ready || busy !== null}
            onClick={() => void post('/api/v1/admin/emails/test', 'test')}
          >
            {busy === 'test' ? 'Sending…' : 'Send test to me'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!ready || recipientCount === 0 || busy !== null}
            onClick={() => setConfirming(true)}
          >
            {busy === 'send' ? 'Sending…' : `Send to ${recipientCount || 0}`}
          </button>
        </div>

        {confirming ? (
          <div className="card alarm" style={{ marginTop: 12 }}>
            <h3>Send to {recipientCount} recipients?</h3>
            <p>
              This sends immediately. There is no recall — CloudNivo cannot unsend a message a
              provider has accepted.
            </p>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setConfirming(false);
                  void post('/api/v1/admin/emails', 'send');
                }}
              >
                Send now
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Preview</h3>
        {preview ? (
          <iframe
            title="Email preview"
            className="mail-preview"
            /* Sandboxed with no allow-* flags: the preview renders exactly
               what the recipient gets, with nothing able to run. */
            sandbox=""
            srcDoc={preview}
          />
        ) : (
          <EmptyState
            title="Nothing rendered yet"
            hint="Preview builds the real message on the CloudNivo letterhead — the same HTML the recipient receives. Nothing is sent or stored."
          />
        )}
      </div>
    </div>
  );
}

export function EmailStatusBadge({ status }: { status: EmailStatus }): React.JSX.Element {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}
