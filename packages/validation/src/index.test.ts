import { describe, expect, it } from 'vitest';
import { formatZodIssues, projectSchema, slugSchema } from './index.js';

describe('validation', () => {
  it('rejects invalid slugs', () => {
    expect(slugSchema.safeParse('OK').success).toBe(false);
    expect(slugSchema.safeParse('my-project-1').success).toBe(true);
  });

  it('never trusts client-supplied org IDs', () => {
    const bad = projectSchema.safeParse({
      name: 'valid-name',
      slug: 'ok-proj',
      organizationId: 'not-a-uuid',
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const fields = formatZodIssues(bad.error).map(i => i.field);
      expect(fields).toContain('organizationId');
    }
  });
});
