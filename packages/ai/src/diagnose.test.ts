import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose.js';

describe('diagnose', () => {
  it('reports healthy when there is no evidence', () => {
    const d = diagnose({ jobs: [], functionErrors: [], planFailures: [] });
    expect(d.healthy).toBe(true);
    expect(d.confidence).toBe('high');
    expect(d.evidence).toEqual([]);
  });

  it('matches provisioning failures to the database service', () => {
    const d = diagnose({
      jobs: [{ id: 'j1', kind: 'provision', status: 'failed', lastError: 'docker: connection refused', updatedAt: '2026-01-01T00:00:00Z' }],
      functionErrors: [],
      planFailures: [],
    });
    expect(d.healthy).toBe(false);
    expect(d.affectedService).toBe('database');
    expect(d.confidence).toBe('high');
    expect(d.evidence).toHaveLength(1);
  });

  it('matches build failures and admits unknown signatures honestly', () => {
    const build = diagnose({
      jobs: [],
      functionErrors: [{ function: 'api', message: 'BUILD_FAILED: entrypoint export not found', at: '2026-01-01T00:00:00Z' }],
      planFailures: [],
    });
    expect(build.affectedService).toBe('functions');
    const unknown = diagnose({
      jobs: [{ id: 'j2', kind: 'mystery', status: 'failed', lastError: 'quux violated the wobble', updatedAt: '2026-01-01T00:00:00Z' }],
      functionErrors: [],
      planFailures: [],
    });
    expect(unknown.confidence).toBe('low');
    expect(unknown.probableCause).toMatch(/unrecognized/i);
  });
});
