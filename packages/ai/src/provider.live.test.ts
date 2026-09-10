import { describe, expect, it } from 'vitest';
import { HttpAIProvider } from './provider.js';
import { validatePlan } from './validate.js';

// Live frontier-model check. Runs only with AI_LIVE_TESTS=1 and AI_API_KEY
// set (CI with a provider key). Skipped otherwise — the stub-server suite in
// provider.http.test.ts covers the transport contract offline.
const runLive = process.env.AI_LIVE_TESTS === '1';
const apiKey = process.env.AI_API_KEY ?? '';

describe.skipIf(!runLive || !apiKey)('HttpAIProvider against a live provider', () => {
  it('returns a schema-valid plan for a small request', async () => {
    const provider = new HttpAIProvider({
      provider: 'openai-compatible',
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      apiKey,
      baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs: 120_000,
    });
    const { plan, usage } = await provider.generate('I need tasks with priorities and due dates.', {});
    expect(plan.database.tables.map(t => t.name)).toContain('tasks');
    const validation = validatePlan(plan);
    expect(validation.errors).toEqual([]);
    expect(usage.latencyMs).toBeGreaterThan(0);
  }, 150_000);
});
