'use client';

import { useState } from 'react';
import { apiBase, apiFetch, getToken } from '../lib/api';
import { ErrorState } from './States';

/* ── Storage: real move / copy between paths ── */
export function StorageOps({ projectId }: { projectId: string }): React.JSX.Element {
  const [bucket, setBucket] = useState('');
  const [src, setSrc] = useState('');
  const [dest, setDest] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(op: 'move' | 'copy'): Promise<void> {
    if (!bucket || !src.trim() || !dest.trim()) return;
    setBusy(op);
    setError(null);
    setMsg(null);
    const r = await apiFetch(
      `/api/v1/projects/${projectId}/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(src.trim())}/${op}`,
      { method: 'POST', body: { dest: dest.trim() } },
    );
    setBusy(null);
    if (!r.ok) setError(r.error ?? `${op} failed`);
    else setMsg(`${op === 'move' ? 'Moved' : 'Copied'} ${src.trim()} → ${dest.trim()}`);
  }

  return (
    <div className="card" id="storage-ops">
      <div className="section-head">
        <h2 style={{ fontSize: 15 }}>Move and copy{bucket ? ` in ${bucket}` : ''}</h2>
        <p>Server-side operations — bytes never round-trip through the browser.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={bucket} onChange={e => setBucket(e.target.value)} placeholder="bucket" aria-label="Bucket" style={{ flex: '1 1 120px' }} />
        <input value={src} onChange={e => setSrc(e.target.value)} placeholder="source path" aria-label="Source path" style={{ flex: '2 1 160px' }} />
        <input value={dest} onChange={e => setDest(e.target.value)} placeholder="destination path" aria-label="Destination path" style={{ flex: '2 1 160px' }} />
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('move')}>Move</button>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('copy')}>Copy</button>
      </div>
      {msg ? <p role="status" style={{ fontSize: 13 }}>{msg}</p> : null}
      {error ? <ErrorState message={error} /> : null}
    </div>
  );
}

/* ── Realtime: real broadcast composer over the project WebSocket ── */
export function RealtimeComposer({ projectId }: { projectId: string }): React.JSX.Element {
  const [channel, setChannel] = useState('general');
  const [message, setMessage] = useState('{"hello":"world"}');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function push(line: string): void {
    setLog(prev => [...prev.slice(-19), `${new Date().toLocaleTimeString()} ${line}`]);
  }

  async function publish(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let payload: unknown = message;
    try {
      payload = JSON.parse(message);
    } catch {
      // send raw string when not JSON
    }
    try {
      const token = getToken();
      if (!token) throw new Error('Sign in first — the socket needs your session token.');
      const base = apiBase().replace(/^http/, 'ws');
      const topic = channel.trim() || 'general';
      const url = `${base}/api/v1/projects/${projectId}/realtime/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('socket error')); };
      });
      const full = `project:${projectId}:${topic}`;
      ws.send(JSON.stringify({ type: 'subscribe', channel: full }));
      push(`subscribed ${full}`);
      await new Promise(r => setTimeout(r, 400));
      ws.send(JSON.stringify({ type: 'publish', channel: full, event: 'message', data: payload }));
      push(`published to ${full}`);
      await new Promise<void>(resolve => {
        const t = setTimeout(() => resolve(), 2500);
        ws.onmessage = ev => {
          try {
            push(`recv ${String(ev.data).slice(0, 200)}`);
          } catch { /* noop */ }
        };
        ws.onclose = () => { clearTimeout(t); resolve(); };
      });
      try { ws.close(); } catch { /* noop */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" id="broadcast">
      <div className="section-head">
        <h2 style={{ fontSize: 15 }}>Publish to a channel</h2>
        <p>Real bytes over <code>project:{'{id}'}:{'{topic}'}</code> — subscribe, publish, receive.</p>
      </div>
      <form onSubmit={e => void publish(e)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={channel} onChange={e => setChannel(e.target.value)} placeholder="topic" aria-label="Channel topic" style={{ flex: '1 1 140px' }} />
        <input value={message} onChange={e => setMessage(e.target.value)} placeholder='{"hello":"world"}' aria-label="Message payload" style={{ flex: '3 1 220px' }} />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</button>
      </form>
      {error ? <ErrorState message={error} /> : null}
      {log.length > 0 ? (
        <pre className="codeblock" style={{ marginTop: 8, maxHeight: 200 }} aria-live="polite">{log.join('\n')}</pre>
      ) : null}
    </div>
  );
}
