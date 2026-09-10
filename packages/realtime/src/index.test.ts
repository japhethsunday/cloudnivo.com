import { describe, expect, it } from 'vitest';
import { InMemoryRealtimeService, canSubscribe } from './legacy.js';

describe('realtime', () => {
  it('publishes within an org channel and enforces channel auth', async () => {
    const svc = new InMemoryRealtimeService();
    const received: unknown[] = [];
    const unsub = svc.subscribe('org-a:proj-1:db', m => received.push(m));
    await svc.publish('org-a:proj-1:db', 'insert', { id: 1 });
    expect(received).toHaveLength(1);
    unsub();

    expect(canSubscribe('org-a:proj-1:db', ['org-a'])).toBe(true);
    expect(canSubscribe('org-a:proj-1:db', ['org-b'])).toBe(false);
  });

  it('rejects malformed channels', async () => {
    const svc = new InMemoryRealtimeService();
    await expect(svc.publish('nope', 'e', {})).rejects.toThrow(/channel/);
  });
});
