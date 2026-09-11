import { describe, expect, it } from 'vitest';
import { canBroadcast, canSubscribe } from './authz.js';

const PID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const base = { userId: 'agent-u', projectId: PID, organizationId: 'o1' };

describe('agent realtime roles', () => {
  it('lets full agents subscribe and broadcast in their project', () => {
    const ctx = { ...base, role: 'agent' };
    expect(canSubscribe(ctx, `project:${PID}:table:tasks`)).toBe(true);
    expect(canBroadcast(ctx, `project:${PID}:table:tasks`)).toBe(true);
    expect(canSubscribe(ctx, `project:${OTHER}:table:tasks`)).toBe(false);
  });

  it('restricts read-only agents to listening', () => {
    const ctx = { ...base, role: 'agent:readonly' };
    expect(canSubscribe(ctx, `project:${PID}:table:tasks`)).toBe(true);
    expect(canBroadcast(ctx, `project:${PID}:table:tasks`)).toBe(false);
  });
});
