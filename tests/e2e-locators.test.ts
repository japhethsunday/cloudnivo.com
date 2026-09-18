import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard against the locator mistake that has broken CI three times.
 *
 * Every one of those failures was the same shape: a page-wide locator that
 * matched exactly one element by luck rather than by design, then matched two
 * the moment the UI grew a second one — or, worse, matched two only sometimes,
 * because the second element's visibility depended on timing. That last kind
 * passes locally and fails in CI, which is the most expensive kind to find.
 *
 * Playwright's strict mode already catches the ambiguity; what it cannot do is
 * catch it BEFORE the browser runs. These rules run in the unit suite, in
 * seconds, with no server and no browser, so the feedback arrives while the
 * change is still in hand.
 *
 * Each rule below names a real element the app renders, not a hypothetical.
 */

const E2E_DIR = path.join(process.cwd(), 'tests', 'e2e');

interface Rule {
  /** Matches the offending locator. */
  pattern: RegExp;
  /** What it collides with, and what to write instead. */
  why: string;
}

const RULES: Rule[] = [
  {
    // Next.js renders <div id="__next-route-announcer__" role="alert"> on every
    // client navigation, so a page-wide alert locator is never unambiguous.
    pattern: /\bpage\s*\.\s*getByRole\(\s*['"]alert['"]/,
    why:
      "Next.js's route announcer also has role=\"alert\", so this matches two " +
      'elements whenever the announcer is visible. Scope it: ' +
      "page.getByTestId('auth-card').getByRole('alert') — or whichever region owns the message.",
  },
  {
    // The shell renders a banner landmark AND project pages render their own.
    pattern: /\bpage\s*\.\s*getByRole\(\s*['"]banner['"]\s*\)/,
    why:
      'The workspace shell and project pages both render banner landmarks. ' +
      'Give it an accessible name, or scope it to a region.',
  },
  {
    // Connect is offered in the breadcrumb AND the project strip, by design.
    pattern: /\bpage\s*\.\s*getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*\/\^connect\$\/i/,
    why:
      'Connect is deliberately offered twice — breadcrumb and project strip. ' +
      "Scope it: page.locator('#main').getByRole('button', { name: /^connect$/i }).",
  },
  {
    // Adding a reveal toggle gave sign-in a second /password/i accessible name.
    pattern: /getByLabel\(\s*\/password\/i\s*\)/,
    why:
      'The reveal toggle is also named "Show password", so /password/i matches two ' +
      "elements. Use getByLabel('Password', { exact: true }).",
  },
];

function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter(f => f.endsWith('.spec.ts'))
    .map(f => path.join(E2E_DIR, f));
}

describe('e2e locators cannot be ambiguous by luck', () => {
  const files = specFiles();

  it('finds the e2e specs', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const rule of RULES) {
    it(`rejects: ${rule.why.slice(0, 60)}…`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          // A commented-out example (like the ones in this file's sibling
          // comments) is documentation, not a locator.
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (rule.pattern.test(line)) {
            offenders.push(`${path.basename(file)}:${i + 1}  ${line.trim()}`);
          }
        });
      }
      expect(offenders, `\n${rule.why}\n\nFound:\n${offenders.join('\n')}\n`).toEqual([]);
    });
  }
});
