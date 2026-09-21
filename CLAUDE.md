# CloudNivo — agent instructions

CloudNivo is a live, deployed backend-as-a-service: Next.js dashboard on Vercel,
framework-free Node API + worker + realtime on Railway, Postgres and Redis
managed. Real users, real tenants, real data. Treat every change as a change to
production.

## Workflow

INSPECT → PLAN → IMPLEMENT → TEST → FIX → TEST AGAIN → VERIFY

Do not stop at analysis when implementation is required. Do not declare
something done that has not been run.

## Before changing anything

- Read the existing code first. This repository is large and most things
  already exist.
- Check whether the feature already exists before implementing it. Search
  before you write.
- Never rebuild a working system from scratch.
- Never create a duplicate feature, component, helper, or endpoint. If two
  things would do the same job, extend the one that is already there.
- Reuse the existing architecture: `packages/*` for shared logic, `apps/api`
  for HTTP, `apps/dashboard` for UI.
- If something is already implemented correctly, leave it alone.
- Prefer the smallest safe change that solves the actual problem.
- Do not modify files unrelated to the task.

## Must not break

The backend, APIs, authentication, database schema, and deployment pipeline are
load-bearing. Preserve them. Schema changes go through
`packages/database/drizzle` migrations, never by hand-editing a table.

## Secrets

Never print, commit, echo, or paste a secret — API keys, tokens, passwords,
connection strings, signing keys. Not into chat, not into a file, not into a
log, not into a commit message. When a credential must be set, write it to the
platform that holds it (Railway, Vercel) and say where it is, not what it is.

A secret that appears in conversation is compromised and must be rotated.

## Honesty

- Never claim something works without having run it.
- Never fake functionality, stub a result, or present an intention as a fact.
- If a test fails, say so and show the output.
- If part of the task is blocked, finish everything else and say plainly what
  was left and why.
- Fix errors immediately. Do not continue past a known failure.

## Testing

Test important changes before calling them complete.

- `npm run verify` runs the full CI gate locally, in CI's order, against CI's
  environment: lint, typecheck, unit, build, Playwright, production smoke.
  **Run this before pushing.**
- `npm run verify:fast` is the static subset — no servers, no browser.
- Frontend work: inspect the actual running UI and verify the rendered result,
  not just that the code compiles.
- Security-sensitive changes: run regression and security tests, and verify the
  defence actually triggers rather than assuming the code path runs.

## Communication style

Be extremely concise. Optimise for the reader's time.

- Strip filler, pleasantries, preamble, and repetition.
- Keep every technical detail intact: errors, commands, filenames, paths, line
  numbers, status codes, test counts. Brevity never costs correctness.
- Do not explain obvious actions or narrate what you are about to do.
- Do not narrate internal reasoning.
- Short progress messages while working; a concise report at the end.
- Do not dump raw terminal output into the conversation. Quote the lines that
  matter.

Final response contains only:

1. What was completed
2. Tests performed
3. Remaining blockers, if any

## Tooling

- `rtk` (Rust Token Killer), when installed and on PATH, wraps noisy commands
  (`git`, `npm`, tests, builds, logs, installs, status/diff) to cut terminal
  output. Use it where it reduces noise without hiding information you need.
  Verify with `rtk gain`. If `rtk` is absent, run the commands directly.
- The `impeccable` design skill and its hooks are already wired in
  `.claude/settings.json`. Leave that configuration alone.

## Repository facts worth knowing

- npm workspaces monorepo; packages must be built before `tsx` can import new
  exports (`npm run build:packages`).
- `NEXT_PUBLIC_*` is inlined at **build** time — changing it needs a rebuild,
  not a variable edit. A dashboard built against the wrong origin fails every
  browser test with a CSP error that looks nothing like the cause.
- CSP treats `https://` and `wss://` as different schemes.
- `toPublicError` replaces every 5xx message with "Internal server error", so
  operator-facing reasons must use a 4xx status.
- CSS grid: bare `1fr` is `minmax(auto, 1fr)`; use `minmax(0, 1fr)` or content
  min-width blows out the page.
- e2e locators must be unambiguous by design, not by luck.
  `tests/e2e-locators.test.ts` enforces the patterns that have broken CI.
- Edge defence lives in `apps/api/src/waf.ts` and `apps/api/src/threat.ts`;
  incident procedure is `docs/ddos-response.md`.
