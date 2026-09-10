import { describe, expect, it } from 'vitest';
import { MemoryEventBus, RedisEventBus, type BusMessage } from './bus.js';
import { RedisPresenceManager } from './presence.js';

// Cross-instance fan-out against a real Redis. Runs only with
// LIVE_REDIS_URL=redis://... set. Skipped otherwise — the RedisEventBus
// degrade-to-local path and the memory bus are covered by unit tests.
const LIVE_REDIS_URL = process.env.LIVE_REDIS_URL ?? '';
describe.skipIf(!LIVE_REDIS_URL)('realtime event bus on live redis', () => {
  it('an event published on instance A reaches subscribers on instance B (no echo)', async () => {
    const topic = `cn:test:${Date.now() % 1000000}`;
    const onError = (err: unknown): void => console.warn('bus error', String(err).slice(0, 120));
    const busA = new RedisEventBus({ url: LIVE_REDIS_URL, channel: topic, onError });
    const busB = new RedisEventBus({ url: LIVE_REDIS_URL, channel: topic, onError });
    const seenA: BusMessage[] = [];
    const seenB: BusMessage[] = [];
    try {
      busA.subscribe(m => seenA.push(m));
      busB.subscribe(m => seenB.push(m));
      // Allow both SUBSCRIBEs to land before publishing.
      await new Promise(r => setTimeout(r, 1500));
      await busA.publish({ channel: 'project:x:chat', kind: 'broadcast', event: { event: 'msg', data: { n: 1 } } });
      const deadline = Date.now() + 15_000;
      while (seenB.length < 1 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(seenB).toHaveLength(1);
      expect(seenB[0]).toMatchObject({ channel: 'project:x:chat', kind: 'broadcast' });
      // A sees exactly its local delivery (remote echo suppressed by origin id).
      expect(seenA).toHaveLength(1);
      expect(new MemoryEventBus().driver).toBe('memory');
    } finally {
      await busA.close();
      await busB.close();
    }
  }, 60_000);

  it('presence unions across instances with immediate remove', async () => {
    const mgrA = new RedisPresenceManager(LIVE_REDIS_URL, 30);
    const mgrB = new RedisPresenceManager(LIVE_REDIS_URL, 30);
    const channel = `project:x:live-${Date.now() % 1000000}`;
    await mgrA.track(channel, 'u1', { user_id: 'u1', status: 'online', metadata: {} });
    const state = await mgrB.state(channel);
    expect(state[channel]?.map(e => e.user_id)).toContain('u1');
    await mgrA.remove(channel, 'u1');
    expect(await mgrB.state(channel)).toEqual({});
    await mgrA.clearChannel(channel);
  }, 60_000);
});
