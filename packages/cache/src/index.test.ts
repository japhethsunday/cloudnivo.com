import { describe, expect, it } from 'vitest';
import { MemoryCache } from './index.js';

describe('cache', () => {
  it('get/set/incr with TTL semantics (memory driver)', async () => {
    const cache = new MemoryCache();
    expect(await cache.ping()).toBe(true);
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    expect(await cache.incr('rl:1', 60)).toBe(1);
    expect(await cache.incr('rl:1', 60)).toBe(2);
    await cache.del('k');
    expect(await cache.get('k')).toBe(null);
  });
});
