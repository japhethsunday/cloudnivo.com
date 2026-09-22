import { describe, expect, it } from 'vitest';
import { environmentAllowed } from './tokens.js';

/**
 * Environment confinement for agent tokens.
 *
 * The asymmetry is the whole point. An empty allowlist has to keep meaning
 * "every ordinary environment", or every token issued before this existed
 * would stop working. It must never mean production, because then a token
 * over-granted `database.destructive` would reach production by default —
 * which is exactly the failure the production gate exists to survive.
 */
describe('environmentAllowed', () => {
  const tok = (environments: string[]) => ({ environments });

  it('lets an unrestricted token into ordinary environments', () => {
    expect(environmentAllowed(tok([]), 'development', false)).toBe(true);
    expect(environmentAllowed(tok([]), 'staging', false)).toBe(true);
    expect(environmentAllowed(tok([]), 'preview', false)).toBe(true);
  });

  it('never lets an unrestricted token into production', () => {
    expect(environmentAllowed(tok([]), 'production', true)).toBe(false);
  });

  it('requires production to be named, not merely implied by a broad list', () => {
    expect(environmentAllowed(tok(['development', 'staging']), 'production', true)).toBe(false);
    expect(environmentAllowed(tok(['production']), 'production', true)).toBe(true);
  });

  it('confines a scoped token to the environments it names', () => {
    const staging = tok(['staging']);
    expect(environmentAllowed(staging, 'staging', false)).toBe(true);
    expect(environmentAllowed(staging, 'development', false)).toBe(false);
  });

  it('decides on the resolved flag, not the name — a production row called anything is production', () => {
    // isProduction comes from the stored row. A token allowed on "staging"
    // does not get in when that row is flagged production, which is what
    // stops the relabelling bypass.
    expect(environmentAllowed(tok(['staging']), 'staging', true)).toBe(true);
    expect(environmentAllowed(tok(['development']), 'staging', true)).toBe(false);
  });

  it('ignores case and surrounding whitespace on both sides', () => {
    expect(environmentAllowed(tok(['  Production ']), 'PRODUCTION', true)).toBe(true);
    expect(environmentAllowed(tok(['Staging']), ' staging ', false)).toBe(true);
  });
});
