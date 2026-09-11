/**
 * In-process request metrics (bounded ring buffer).
 *
 * Records per-request service, route template, status, and latency. Memory
 * only and explicitly labeled "since boot" by consumers — durable
 * time-series is a later phase; this gives real requests/errors/latency
 * without inventing data. Drops oldest entries past capacity (10k).
 */

export type MetricService =
  | 'projects'
  | 'data'
  | 'auth'
  | 'storage'
  | 'realtime'
  | 'functions'
  | 'ai'
  | 'billing'
  | 'agents'
  | 'automation'
  | 'metrics'
  | 'platform'
  | 'other';

export interface RequestSample {
  at: number;
  service: MetricService;
  route: string;
  method: string;
  status: number;
  latencyMs: number;
  /** Project from the URL when present — the tenant filter. Null for platform routes. */
  projectId: string | null;
}

export interface ServiceSummary {
  service: MetricService;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

export interface MetricsSummary {
  /** Unix ms when recording started (process boot). */
  since: number;
  windowMs: number;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  byService: ServiceSummary[];
  /** Top routes by volume: [method, route, count, errors]. */
  topRoutes: { method: string; route: string; requests: number; errors: number }[];
  /** Requests per 5-minute bucket (unix ms bucket start, count). */
  timeline: { at: number; requests: number; errors: number }[];
}

/** Classify a v1 pathname into a service bucket for aggregation. */
export function classifyService(pathname: string): MetricService {
  if (pathname === '/api/v1/metrics' || pathname.startsWith('/api/v1/metrics/')) return 'metrics';
  if (pathname.startsWith('/api/v1/billing/')) return 'billing';
  if (pathname.startsWith('/api/v1/auth/')) return 'platform';
  if (!pathname.startsWith('/api/v1/projects/')) return 'platform';
  const rest = pathname.replace('/api/v1/projects/', '').split('/').filter(Boolean);
  const seg = rest[1] ?? '';
  if (seg === 'auth') return 'auth';
  if (seg === 'storage') return 'storage';
  if (seg === 'realtime') return 'realtime';
  if (seg === 'functions') return 'functions';
  if (seg === 'ai') return 'ai';
  if (seg === 'keys' || seg === 'openapi.json') return 'data';
  if (seg === 'queues' || seg === 'schedules' || seg === 'webhooks') return 'automation';
  if (seg === 'jobs' || seg === 'database' || seg === '') return 'projects';
  return 'data';
}

/** Collapse ids to `:id` so cardinality stays bounded. */
export function routeTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map(seg =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export class RequestMetrics {
  private readonly samples: RequestSample[] = [];
  private readonly startedAt = Date.now();
  constructor(private readonly capacity = 10_000) {}

  record(sample: Omit<RequestSample, 'at'> & { at?: number }): void {
    this.samples.push({ ...sample, at: sample.at ?? Date.now() });
    while (this.samples.length > this.capacity) this.samples.shift();
  }

  summarize(windowMs: number, now = Date.now(), projectIds: Set<string> | null = null): MetricsSummary {
    const cutoff = now - windowMs;
    const inWindow = this.samples.filter(
      s => s.at >= cutoff && (projectIds === null || (s.projectId !== null && projectIds.has(s.projectId))),
    );
    const lat = inWindow.map(s => s.latencyMs).sort((a, b) => a - b);
    const errors = inWindow.filter(s => s.status >= 500).length;
    const byService = new Map<MetricService, RequestSample[]>();
    for (const s of inWindow) {
      const arr = byService.get(s.service) ?? [];
      arr.push(s);
      byService.set(s.service, arr);
    }
    const byServiceOut: ServiceSummary[] = [...byService.entries()]
      .map(([service, arr]) => {
        const l = arr.map(s => s.latencyMs).sort((a, b) => a - b);
        const e = arr.filter(s => s.status >= 500).length;
        return {
          service,
          requests: arr.length,
          errors: e,
          errorRate: arr.length === 0 ? 0 : e / arr.length,
          p50Ms: quantile(l, 0.5),
          p95Ms: quantile(l, 0.95),
        };
      })
      .sort((a, b) => b.requests - a.requests);
    const routes = new Map<string, { method: string; route: string; requests: number; errors: number }>();
    for (const s of inWindow) {
      const key = `${s.method} ${s.route}`;
      const r = routes.get(key) ?? { method: s.method, route: s.route, requests: 0, errors: 0 };
      r.requests += 1;
      if (s.status >= 500) r.errors += 1;
      routes.set(key, r);
    }
    const buckets = new Map<number, { at: number; requests: number; errors: number }>();
    for (const s of inWindow) {
      const at = Math.floor(s.at / 300_000) * 300_000;
      const b = buckets.get(at) ?? { at, requests: 0, errors: 0 };
      b.requests += 1;
      if (s.status >= 500) b.errors += 1;
      buckets.set(at, b);
    }
    return {
      since: this.startedAt,
      windowMs,
      requests: inWindow.length,
      errors,
      errorRate: inWindow.length === 0 ? 0 : errors / inWindow.length,
      p50Ms: quantile(lat, 0.5),
      p95Ms: quantile(lat, 0.95),
      byService: byServiceOut,
      topRoutes: [...routes.values()].sort((a, b) => b.requests - a.requests).slice(0, 15),
      timeline: [...buckets.values()].sort((a, b) => a.at - b.at),
    };
  }
}
