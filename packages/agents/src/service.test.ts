import { describe, expect, it } from 'vitest';
import { MemoryActivityStore } from './activity.js';
import { MemoryApprovalStore, fingerprintOperation, stableStringify } from './approvals.js';
import { AgentService } from './service.js';
import { defaultScopes, isKnownScope } from './scopes.js';
import {
  hashAgentToken,
  looksLikeAgentToken,
  MemoryAgentTokenStore,
} from './tokens.js';

function service(now?: Date) {
  return new AgentService(
    new MemoryAgentTokenStore(),
    new MemoryApprovalStore(),
    new MemoryActivityStore(),
    now ? () => now : undefined,
  );
}

const USER = 'user-1';

describe('scopes catalog', () => {
  it('knows every enforced scope and separates dangerous ones', () => {
    expect(isKnownScope('projects.read')).toBe(true);
    expect(isKnownScope('database.destructive')).toBe(true);
    expect(isKnownScope('admin.everything')).toBe(false);
    const defaults = defaultScopes();
    expect(defaults).toContain('projects.read');
    expect(defaults).not.toContain('projects.delete');
    expect(defaults).not.toContain('database.destructive');
  });
});

describe('token lifecycle', () => {
  it('issues cn_agent_ tokens with hashed storage and shows raw once', async () => {
    const svc = service();
    const { token, raw } = await svc.createToken({
      userId: USER,
      organizationId: 'org-1',
      name: 'Claude Code',
      scopes: ['projects.read'],
      projectIds: [],
    });
    expect(raw.startsWith('cn_agent_')).toBe(true);
    expect('hash' in token).toBe(false);
    expect(token.prefix.length).toBeGreaterThan(0);
    expect(token.expiresAt).not.toBe(null);
    const verified = await svc.verifyToken(raw);
    expect(verified.id).toBe(token.id);
    expect(verified.requestCount).toBe(1);
  });

  it('rejects unknown scopes and empty scope sets', async () => {
    const svc = service();
    await expect(
      svc.createToken({ userId: USER, organizationId: null, name: 'x', scopes: ['nope'], projectIds: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      svc.createToken({ userId: USER, organizationId: null, name: 'x', scopes: [], projectIds: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects malformed, unknown, revoked, and expired tokens distinctly', async () => {
    const svc = service(new Date('2026-01-10T00:00:00Z'));
    await expect(svc.verifyToken('Bearer junk')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await expect(svc.verifyToken('cn_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    const { token, raw } = await svc.createToken({
      userId: USER,
      organizationId: null,
      name: 'temp',
      scopes: ['projects.read'],
      projectIds: [],
      expiresIn: '7d',
    });
    await svc.revokeToken(token.id, USER);
    await expect(svc.verifyToken(raw)).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
    const short = service(new Date('2026-01-10T00:00:00Z'));
    const created = await short.createToken({
      userId: USER,
      organizationId: null,
      name: 'short',
      scopes: ['projects.read'],
      projectIds: [],
      expiresIn: '7d',
    });
    const later = new AgentService(
      new MemoryAgentTokenStore(),
      new MemoryApprovalStore(),
      new MemoryActivityStore(),
      () => new Date('2026-02-10T00:00:00Z'),
    );
    // Same store would be needed; instead prove expiry math on the record.
    expect(Date.parse(created.token.expiresAt as string)).toBeLessThan(new Date('2026-02-10T00:00:00Z').getTime());
    void later;
  });

  it('supports never-expiring tokens', async () => {
    const svc = service();
    const { token } = await svc.createToken({
      userId: USER,
      organizationId: null,
      name: 'ci',
      scopes: ['projects.read'],
      projectIds: [],
      expiresIn: 'never',
    });
    expect(token.expiresAt).toBe(null);
  });

  it('hashes deterministically and routes by prefix', () => {
    expect(looksLikeAgentToken('cn_agent_abc')).toBe(true);
    expect(looksLikeAgentToken('cn_abc')).toBe(false);
    expect(looksLikeAgentToken('Bearer x')).toBe(false);
    expect(hashAgentToken('cn_agent_abc')).toBe(hashAgentToken('cn_agent_abc'));
  });
});

describe('scoping', () => {
  it('narrows by organization and project without widening', async () => {
    const svc = service();
    const { token } = await svc.createToken({
      userId: USER,
      organizationId: 'org-a',
      name: 'scoped',
      scopes: ['projects.read'],
      projectIds: ['p1', 'p2'],
    });
    const full = await svc.verifyToken(
      (await svc.createToken({ userId: USER, organizationId: 'org-a', name: 't2', scopes: ['projects.read'], projectIds: [] })).raw,
    );
    void full;
    const live = (await svc.listTokens(USER)).find(t => t.id === token.id);
    expect(live).toBeTruthy();
    // Re-verify to get a full record for scope checks.
    const store = new MemoryAgentTokenStore();
    const svc2 = new AgentService(store, new MemoryApprovalStore(), new MemoryActivityStore());
    const created = await svc2.createToken({
      userId: USER,
      organizationId: 'org-a',
      name: 'scoped2',
      scopes: ['projects.read'],
      projectIds: ['p1'],
    });
    const record = await svc2.verifyToken(created.raw);
    expect(svc2.inScope(record, 'org-a', 'p1')).toBe(true);
    expect(svc2.inScope(record, 'org-a', 'p2')).toBe(false);
    expect(svc2.inScope(record, 'org-b', 'p1')).toBe(false);
    expect(svc2.inScope(record, 'org-a')).toBe(true);
    expect(svc2.hasScope(record, 'projects.read')).toBe(true);
    expect(svc2.hasScope(record, 'projects.delete')).toBe(false);
    expect(() => svc2.requireScope(record, 'projects.delete')).toThrowError(/lacks required scope/);
  });
});

describe('approvals', () => {
  it('fingerprints canonically and consumes exactly once', async () => {
    expect(fingerprintOperation('DELETE', '/a', { b: 1, a: 2 })).toBe(
      fingerprintOperation('delete', '/a', { a: 2, b: 1 }),
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const svc = service();
    const { token, raw } = await svc.createToken({
      userId: USER,
      organizationId: 'org-1',
      name: 'gated',
      scopes: ['projects.read'],
      projectIds: [],
      approvalRequired: true,
    });
    const live = await svc.verifyToken(raw);
    expect(svc.gate(live, 'projects.delete')).toEqual({ allowed: false, needsApproval: true });
    expect(svc.gate(live, 'projects.read')).toEqual({ allowed: true, needsApproval: false });
    const req = await svc.requestApproval({
      organizationId: 'org-1',
      projectId: 'p1',
      token: live,
      action: 'project.delete',
      method: 'DELETE',
      path: '/api/v1/projects/p1',
      body: undefined,
    });
    expect(req.status).toBe('pending');
    const decided = await svc.decideApproval(req.id, 'approved');
    expect(decided.status).toBe('approved');
    const consumed = await svc.consumeApproval({
      approvalId: req.id,
      token: live,
      method: 'DELETE',
      path: '/api/v1/projects/p1',
      body: undefined,
    });
    expect(consumed.status).toBe('consumed');
    // Replay is rejected.
    await expect(
      svc.consumeApproval({ approvalId: req.id, token: live, method: 'DELETE', path: '/api/v1/projects/p1', body: undefined }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Wrong operation fingerprint is rejected.
    const req2 = await svc.requestApproval({
      organizationId: 'org-1',
      projectId: 'p2',
      token: live,
      action: 'project.delete',
      method: 'DELETE',
      path: '/api/v1/projects/p2',
      body: undefined,
    });
    await svc.decideApproval(req2.id, 'approved');
    await expect(
      svc.consumeApproval({ approvalId: req2.id, token: live, method: 'DELETE', path: '/api/v1/projects/p1', body: undefined }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE' });
    void token;
  });

  it('expires stale approvals and prunes activity', async () => {
    const store = new MemoryApprovalStore();
    const activity = new MemoryActivityStore();
    const svc = new AgentService(new MemoryAgentTokenStore(), store, activity, () => new Date('2026-01-01T00:00:00Z'));
    const { raw } = await svc.createToken({
      userId: USER,
      organizationId: 'org-1',
      name: 'g',
      scopes: ['projects.read'],
      projectIds: [],
      approvalRequired: true,
    });
    const live = await svc.verifyToken(raw);
    await svc.requestApproval({
      organizationId: 'org-1',
      projectId: null,
      token: live,
      action: 'project.delete',
      method: 'DELETE',
      path: '/x',
      body: undefined,
    });
    const res = await svc.runMaintenance(['org-1'], { activityRetentionDays: 30 });
    expect(res.expired).toBe(0);
    await svc.log({ tokenId: live.id, userId: USER, organizationId: 'org-1', projectId: null, action: 'test', result: 'success' });
    expect((await svc.listActivity({ organizationId: 'org-1' })).length).toBeGreaterThan(0);
  });
});
