import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody, toPublicError } from '@cloudnivo/api-core';
import { loadConfig } from '@cloudnivo/config';

/**
 * API + config integration: validation errors and missing config both surface
 * as safe, structured failures — never leaks, never throws raw.
 */
describe('phase 1 api/config (integration)', () => {
  it('validation failures map to 400 envelopes with requestId', () => {
    const schema = z.object({ slug: z.string().min(2) });
    try {
      parseBody(schema, { slug: 'x' });
      expect.unreachable();
    } catch (err) {
      const { status, body } = toPublicError(err, 'req-1');
      expect(status).toBe(400);
      expect(body.error.requestId).toBe('req-1');
    }
  });

  it('missing secrets fail fast with actionable message', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_SECRET/);
  });
});
