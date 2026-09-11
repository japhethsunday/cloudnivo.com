/** Display helpers: every value shown comes from the backend — these only format. */

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
}

const BYTE_METRICS = new Set(['api_bandwidth_bytes', 'db_storage_bytes', 'storage_bytes', 'function_gb_seconds']);

export function formatMetric(metric: string, total: number): string {
  if (BYTE_METRICS.has(metric)) {
    if (metric === 'function_gb_seconds') return `${formatCount(total)} GB·s`;
    return formatBytes(total);
  }
  return formatCount(total);
}

export function prettifyKey(key: string): string {
  return key
    .split(/[_-]+/)
    .map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
