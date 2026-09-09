'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiFetchRaw } from '../lib/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

interface Bucket {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  fileSizeLimit: number | null;
  allowedMimeTypes: string[];
  ownerIsolation: boolean;
  createdAt: string;
}

interface ListedObject {
  id: string;
  bucket: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  etag: string;
  createdAt: string;
}

interface Usage {
  files: number;
  bytes: number;
  uploads: number;
  downloads: number;
  quotaBytes: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function StoragePanel({ projectId }: { projectId: string }): React.JSX.Element {
  const base = `/api/v1/projects/${projectId}/storage`;
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [active, setActive] = useState('');
  const [prefix, setPrefix] = useState('');
  const [objects, setObjects] = useState<ListedObject[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [preview, setPreview] = useState<{ url: string; mime: string; name: string } | null>(null);
  const [meta, setMeta] = useState<ListedObject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadBuckets = useCallback(async () => {
    const r = await apiFetch<{ buckets: Bucket[] }>(`${base}/buckets`);
    if (!r.ok) setError(r.error);
    else {
      setBuckets(r.data?.buckets ?? []);
      setError(null);
    }
  }, [base]);

  const loadObjects = useCallback(async () => {
    if (!active) {
      setObjects([]);
      setTotal(0);
      return;
    }
    const r = await apiFetch<{ objects: ListedObject[]; total: number }>(
      `${base}/buckets/${encodeURIComponent(active)}/objects?prefix=${encodeURIComponent(prefix)}&limit=100`,
    );
    if (!r.ok) setError(r.error);
    else {
      setObjects(r.data?.objects ?? []);
      setTotal(r.data?.total ?? 0);
    }
  }, [base, active, prefix]);

  const loadUsage = useCallback(async () => {
    const r = await apiFetch<Usage>(`${base}/usage`);
    if (r.ok && r.data) setUsage(r.data);
  }, [base]);

  useEffect(() => {
    void loadBuckets();
    void loadUsage();
  }, [loadBuckets, loadUsage]);

  useEffect(() => {
    void loadObjects();
  }, [loadObjects]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  async function createBucket(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const r = await apiFetch(`${base}/buckets`, { method: 'POST', body: { name, visibility } });
    if (!r.ok) setError(r.error);
    else {
      setName('');
      setNotice(`Bucket "${name}" created.`);
      void loadBuckets();
    }
  }

  async function deleteBucket(bucket: string): Promise<void> {
    if (!window.confirm(`Delete bucket "${bucket}"? It must be empty.`)) return;
    const r = await apiFetch(`${base}/buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' });
    if (!r.ok) setError(r.error);
    else {
      if (active === bucket) {
        setActive('');
        setPrefix('');
      }
      void loadBuckets();
    }
  }

  async function saveSettings(bucket: Bucket, patch: Partial<Bucket>): Promise<void> {
    setError(null);
    const r = await apiFetch(`${base}/buckets/${encodeURIComponent(bucket.name)}`, {
      method: 'PATCH',
      body: patch,
    });
    if (!r.ok) setError(r.error);
    else {
      setNotice('Bucket settings saved.');
      void loadBuckets();
    }
  }

  async function upload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || !active) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        const res = await apiFetchRaw(
          `${base}/buckets/${encodeURIComponent(active)}/objects/${path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          { method: 'PUT', body: f, contentType: f.type || 'application/octet-stream' },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(j?.error?.message ?? `Upload failed (${res.status})`);
        }
      }
      setNotice(`${files.length} file(s) uploaded.`);
      void loadObjects();
      void loadUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function remove(path: string): Promise<void> {
    if (!window.confirm(`Delete "${path}"?`)) return;
    const r = await apiFetch(
      `${base}/buckets/${encodeURIComponent(active)}/objects/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE' },
    );
    if (!r.ok) setError(r.error);
    else {
      void loadObjects();
      void loadUsage();
    }
  }

  async function inspect(path: string): Promise<void> {
    const r = await apiFetch<{ object: ListedObject }>(
      `${base}/buckets/${encodeURIComponent(active)}/objects/${path.split('/').map(encodeURIComponent).join('/')}/metadata`,
    );
    if (!r.ok) setError(r.error);
    else if (r.data) setMeta(r.data.object);
  }

  async function showPreview(o: ListedObject): Promise<void> {
    setError(null);
    try {
      const res = await apiFetchRaw(
        `${base}/buckets/${encodeURIComponent(active)}/objects/${o.path.split('/').map(encodeURIComponent).join('/')}`,
      );
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const blob = await res.blob();
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(blob), mime: o.mimeType, name: o.filename });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    }
  }

  async function downloadLink(path: string): Promise<void> {
    const r = await apiFetch<{ url: string }>(
      `${base}/buckets/${encodeURIComponent(active)}/sign`,
      {
        method: 'POST',
        body: { path, expiresIn: 300 },
      },
    );
    if (!r.ok || !r.data) setError(r.error ?? 'Sign failed');
    else window.open(r.data.url, '_blank', 'noopener');
  }

  const activeBucket = buckets?.find(b => b.name === active) ?? null;
  const crumbs = prefix ? prefix.split('/') : [];
  const pct =
    usage && usage.quotaBytes > 0 ? Math.min(100, (usage.bytes / usage.quotaBytes) * 100) : 0;
  const previewable = (m: string): boolean =>
    m.startsWith('image/') ||
    m === 'application/pdf' ||
    m.startsWith('text/') ||
    m === 'application/json';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Usage</h2>
        {!usage ? (
          <LoadingSkeleton label="Loading usage" />
        ) : (
          <>
            <p>
              <strong>{formatBytes(usage.bytes)}</strong> of {formatBytes(usage.quotaBytes)} used ·{' '}
              {usage.files} files · {usage.uploads} uploads · {usage.downloads} downloads
            </p>
            <div
              role="progressbar"
              aria-valuenow={Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{ background: 'var(--bg-muted)', borderRadius: 6, height: 10 }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  borderRadius: 6,
                  background: 'var(--accent)',
                }}
              />
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Buckets</h2>
        {!buckets ? (
          <LoadingSkeleton label="Loading buckets" />
        ) : buckets.length === 0 ? (
          <EmptyState title="No buckets" hint="Create one for avatars, documents, backups…" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Visibility</th>
                <th>Owner isolation</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {buckets.map(b => (
                <tr key={b.id}>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setActive(b.name);
                        setPrefix('');
                      }}
                    >
                      {b.name}
                    </button>
                  </td>
                  <td>{b.visibility}</td>
                  <td>{b.ownerIsolation ? 'on' : 'off'}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => void deleteBucket(b.name)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          onSubmit={e => void createBucket(e)}
          style={{ display: 'flex', gap: 8, marginTop: 8 }}
        >
          <input
            aria-label="Bucket name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            minLength={3}
            placeholder="avatars"
          />
          <select
            aria-label="Visibility"
            value={visibility}
            onChange={e => setVisibility(e.target.value as 'private' | 'public')}
          >
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <button type="submit" className="btn btn-primary">
            Create bucket
          </button>
        </form>
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <ErrorState message={error} /> : null}
      </div>

      {activeBucket ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Files — {activeBucket.name}{' '}
            <span className="muted">
              /{prefix} ({total})
            </span>
          </h2>
          <p>
            {crumbs.length > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => setPrefix(crumbs.slice(0, -1).join('/'))}
              >
                ↑ Up
              </button>
            ) : null}{' '}
            <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
              {uploading ? 'Uploading…' : 'Upload files'}
              <input
                type="file"
                multiple
                hidden
                disabled={uploading}
                onChange={e => void upload(e.target.files)}
              />
            </label>
          </p>
          {objects.length === 0 ? (
            <EmptyState title="Empty folder" hint="Upload files or navigate with prefixes." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {objects.map(o => (
                  <tr key={o.id}>
                    <td>
                      <code>{o.path}</code>
                    </td>
                    <td>
                      <code>{o.mimeType}</code>
                    </td>
                    <td>{formatBytes(o.size)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {previewable(o.mimeType) ? (
                          <button type="button" className="btn" onClick={() => void showPreview(o)}>
                            Preview
                          </button>
                        ) : null}
                        <button type="button" className="btn" onClick={() => void inspect(o.path)}>
                          Metadata
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void downloadLink(o.path)}
                        >
                          Signed link
                        </button>
                        <button type="button" className="btn" onClick={() => void remove(o.path)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview ? (
            <div style={{ marginTop: 8 }}>
              <h3>Preview — {preview.name}</h3>
              {preview.mime.startsWith('image/') ? (
                <img
                  src={preview.url}
                  alt={preview.name}
                  style={{ maxWidth: '100%', maxHeight: 420 }}
                />
              ) : preview.mime === 'application/pdf' ? (
                <iframe
                  src={preview.url}
                  title={preview.name}
                  style={{ width: '100%', height: 480 }}
                />
              ) : (
                <iframe
                  src={preview.url}
                  title={preview.name}
                  sandbox=""
                  style={{ width: '100%', height: 320, background: '#fff' }}
                />
              )}
              <p>
                <button type="button" className="btn" onClick={() => setPreview(null)}>
                  Close preview
                </button>
              </p>
            </div>
          ) : null}
          {meta ? (
            <pre style={{ overflow: 'auto', background: 'var(--bg-muted)', padding: 8 }}>
              {JSON.stringify(meta, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {activeBucket ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Bucket settings & policies</h2>
          <p className="muted">
            Visibility controls anonymous downloads. Owner isolation restricts customer users to
            their <code>{'<userId>/'}</code> folder (admins and service keys bypass). Platform
            members always pass; viewers are read-only.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void saveSettings(activeBucket, {
                  visibility: activeBucket.visibility === 'public' ? 'private' : 'public',
                })
              }
            >
              Make {activeBucket.visibility === 'public' ? 'private' : 'public'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void saveSettings(activeBucket, { ownerIsolation: !activeBucket.ownerIsolation })
              }
            >
              Owner isolation: {activeBucket.ownerIsolation ? 'on' : 'off'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
