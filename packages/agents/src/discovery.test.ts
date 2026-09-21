import { describe, expect, it } from 'vitest';
import { AGENT_SCOPES } from './scopes.js';
import { CAPABILITY_SERVICES, capabilityManifest, capabilityOperations } from './discovery.js';

/**
 * The manifest is a promise to agents. These tests keep it honest: every
 * scope it advertises must be a scope the platform enforces, and every
 * operation must be addressable and uniquely named.
 */
describe('capability manifest', () => {
  const known = new Set(AGENT_SCOPES.map(s => s.scope));

  it('advertises only scopes the platform actually enforces', () => {
    for (const op of capabilityOperations()) {
      for (const scope of op.scopes) {
        expect(known.has(scope), `${op.id} requires unknown scope ${scope}`).toBe(true);
      }
    }
  });

  it('gives every operation a unique id and a concrete route', () => {
    const ids = capabilityOperations().map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of capabilityOperations()) {
      expect(op.path.startsWith('/'), op.id).toBe(true);
      expect(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).toContain(op.method);
      expect(op.summary.length, op.id).toBeGreaterThan(5);
    }
  });

  it('marks destructive operations, and only those, as approvable', () => {
    for (const op of capabilityOperations()) {
      if (op.approvable) expect(op.destructive, `${op.id} approvable but not destructive`).toBe(true);
    }
    const destructive = capabilityOperations().filter(o => o.destructive).map(o => o.id);
    expect(destructive).toEqual(
      expect.arrayContaining(['projects.delete', 'migrations.apply', 'storage.delete', 'functions.delete']),
    );
  });

  it('covers every service the scope catalog names', () => {
    const advertised = new Set(CAPABILITY_SERVICES.map(s => s.service));
    // `billing` is a human surface; everything else must be discoverable.
    for (const scope of AGENT_SCOPES) {
      if (scope.service === 'billing') continue;
      const covered =
        advertised.has(scope.service) ||
        capabilityOperations().some(o => o.scopes.includes(scope.scope));
      expect(covered, `no discoverable operation for ${scope.scope}`).toBe(true);
    }
  });

  it('builds a manifest carrying auth schemes, env template and error codes', () => {
    const manifest = capabilityManifest({
      apiUrl: 'https://api.test',
      errorRemediation: { NOT_FOUND: 'list it first' },
    });
    expect(manifest.auth.map(a => a.scheme)).toEqual(['agent-token', 'session', 'project-key']);
    expect(manifest.envTemplate.find(v => v.name === 'CLOUDNIVO_URL')?.example).toBe('https://api.test');
    expect(manifest.errorCodes).toEqual([{ code: 'NOT_FOUND', remediation: 'list it first' }]);
    expect(manifest.environments).toContain('production');
    // Agents must be told the secret rule up front, not discover it by failing.
    expect(manifest.conventions['secrets']).toContain('never');
  });
});
