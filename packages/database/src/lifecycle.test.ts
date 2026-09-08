import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isSteady, isTerminal } from './lifecycle.js';
import {
  assertSafeSql,
  checkProjectDbHealth,
  maskConnectionInfo,
  SqlRejectedError,
  toConnectionString,
} from './project-db.js';

describe('database lifecycle', () => {
  it('follows creating → ready → running ⇄ stopped', () => {
    expect(canTransition('creating', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'stopped')).toBe(true);
    expect(canTransition('stopped', 'running')).toBe(true);
    expect(canTransition('restarting', 'ready')).toBe(true);
  });

  it('forbids illegal jumps (creating → running, deleted → anything)', () => {
    expect(canTransition('creating', 'running')).toBe(false);
    expect(canTransition('deleted', 'ready')).toBe(false);
    expect(() => assertTransition('creating', 'running')).toThrow(/Illegal/);
  });

  it('marks failed/deleted terminal, ready/running/stopped steady', () => {
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('deleted')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isSteady('ready')).toBe(true);
    expect(isSteady('creating')).toBe(false);
  });
});

describe('project-db connector', () => {
  const info = { host: '127.0.0.1', port: 1, database: 'app', user: 'u', password: 's3cret-pw' };

  it('builds connection strings and masks credentials', () => {
    expect(toConnectionString(info)).toContain('127.0.0.1:1/app');
    const masked = maskConnectionInfo(info);
    expect(masked.password).toBe('••••••••');
    expect(JSON.stringify(masked)).not.toContain('s3cret-pw');
  });

  it('rejects multi-statement and oversized SQL (injection surface)', () => {
    expect(() => assertSafeSql('select 1; drop table users', 1000)).toThrow(SqlRejectedError);
    expect(() => assertSafeSql('   ', 1000)).toThrow(SqlRejectedError);
    expect(() => assertSafeSql('x'.repeat(1001), 1000)).toThrow(SqlRejectedError);
    expect(assertSafeSql('select 1;', 1000)).toBe('select 1');
  });

  it('health check reports unavailable (not throw) when unreachable', async () => {
    const res = await checkProjectDbHealth(info, 2000);
    expect(res.health).toBe('unavailable');
    expect(typeof res.latencyMs).toBe('number');
  });
});
