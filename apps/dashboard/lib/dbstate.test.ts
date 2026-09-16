import { describe, expect, it } from 'vitest';
import { databaseState } from './dbstate.js';

describe('databaseState', () => {
  it('reports the database status when a database exists', () => {
    const s = databaseState({ status: 'running', health: 'healthy' }, null);
    expect(s).toEqual({ label: 'running', pending: false, error: null, actionable: false });
  });

  it('says provisioning only while the provision job is still running', () => {
    for (const status of ['pending', 'running', 'retrying']) {
      const s = databaseState(null, { status });
      expect(s.label).toBe('provisioning');
      expect(s.pending).toBe(true);
      expect(s.actionable).toBe(false);
    }
  });

  it('surfaces a failed provision instead of claiming work is in flight', () => {
    // The bug this replaces: no database record fell back to the literal
    // string "provisioning", so a dead project claimed to be busy forever.
    const s = databaseState(null, {
      status: 'failed',
      lastError: 'Managed Postgres is unreachable',
    });
    expect(s.label).toBe('provisioning failed');
    expect(s.pending).toBe(false);
    expect(s.error).toBe('Managed Postgres is unreachable');
    expect(s.actionable).toBe(true);
  });

  it('is honest when there is no database and no job to explain it', () => {
    const s = databaseState(null, null);
    expect(s.label).toBe('not provisioned');
    expect(s.pending).toBe(false);
    expect(s.actionable).toBe(true);
  });
});
