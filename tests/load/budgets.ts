/**
 * Load-test budgets. Generous for developer hardware — these assert "no
 * collapse", not production SLOs. Results are machine-readable JSON
 * (tests/load/results.json, git-ignored) plus a human summary on stdout.
 */

export interface Budget {
  /** Max acceptable p95 latency in ms. */
  p95Ms: number;
  /** Max acceptable error rate (0-1) for correctness-critical paths. */
  maxErrorRate: number;
  /** Minimum sustained throughput (ops/sec), 0 = not asserted. */
  minOpsPerSec: number;
}

export const BUDGETS: Record<string, Budget> = {
  'api.health': { p95Ms: 500, maxErrorRate: 0, minOpsPerSec: 50 },
  'api.crud': { p95Ms: 2000, maxErrorRate: 0, minOpsPerSec: 5 },
  'auth.session': { p95Ms: 3000, maxErrorRate: 0, minOpsPerSec: 2 },
  'data.read': { p95Ms: 1500, maxErrorRate: 0, minOpsPerSec: 10 },
  'storage.roundtrip': { p95Ms: 3000, maxErrorRate: 0, minOpsPerSec: 2 },
  'realtime.fanout': { p95Ms: 3000, maxErrorRate: 0, minOpsPerSec: 2 },
  'functions.invoke': { p95Ms: 5000, maxErrorRate: 0, minOpsPerSec: 1 },
  'ai.plan': { p95Ms: 5000, maxErrorRate: 0, minOpsPerSec: 1 },
};

export interface ScenarioResult {
  scenario: string;
  concurrency: number;
  total: number;
  ok: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  opsPerSec: number;
  budget: Budget;
  pass: boolean;
  notes: string[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export function summarize(
  scenario: string,
  concurrency: number,
  latencies: number[],
  errors: number,
  elapsedMs: number,
  notes: string[] = [],
): ScenarioResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length + errors;
  const budget = BUDGETS[scenario] ?? { p95Ms: 10_000, maxErrorRate: 0.01, minOpsPerSec: 0 };
  const p95 = percentile(sorted, 95);
  const errorRate = total === 0 ? 0 : errors / total;
  const opsPerSec = elapsedMs === 0 ? 0 : (latencies.length / elapsedMs) * 1000;
  const pass =
    p95 <= budget.p95Ms && errorRate <= budget.maxErrorRate && opsPerSec >= budget.minOpsPerSec;
  return {
    scenario,
    concurrency,
    total,
    ok: latencies.length,
    errors,
    p50Ms: percentile(sorted, 50),
    maxMs: sorted[sorted.length - 1] ?? 0,
    p95Ms: Math.round(p95),
    opsPerSec: Math.round(opsPerSec * 10) / 10,
    budget,
    pass,
    notes,
  };
}

/** Bounded worker pool: runs task() total times with `concurrency` in flight. */
export async function runPool<T>(
  total: number,
  concurrency: number,
  task: (i: number) => Promise<T>,
): Promise<{ latencies: number[]; errors: number; results: T[] }> {
  const latencies: number[] = [];
  const results: T[] = [];
  let errors = 0;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= total) return;
      const start = Date.now();
      try {
        results.push(await task(i));
        latencies.push(Date.now() - start);
      } catch {
        errors += 1;
      }
    }
  });
  await Promise.all(workers);
  return { latencies, errors, results };
}
