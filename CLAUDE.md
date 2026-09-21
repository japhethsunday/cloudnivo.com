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

<!-- rtk-instructions v2 -->

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:

```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)

```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)

```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)

```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)

```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)

```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
```

### Files & Search (60-75% savings)

```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)

```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)

```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)

```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands

```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category         | Commands                       | Typical Savings |
| ---------------- | ------------------------------ | --------------- |
| Tests            | vitest, playwright, cargo test | 90-99%          |
| Build            | next, tsc, lint, prettier      | 70-87%          |
| Git              | status, log, diff, add, commit | 59-80%          |
| GitHub           | gh pr, gh run, gh issue        | 26-87%          |
| Package Managers | pnpm, npm, npx                 | 70-90%          |
| Files            | ls, read, grep, find           | 60-75%          |
| Infrastructure   | docker, kubectl                | 85%             |
| Network          | curl, wget                     | 65-70%          |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->

## RTK caveats for THIS repository

The block above is RTK's own generic guidance. Two exceptions apply here and
they override it.

- **Never use `rtk tsc`.** It invokes the _global_ `tsc` (6.0.2), not this
  repository's pinned TypeScript (5.9.3 in `node_modules`). TS 6 deprecates
  `baseUrl`, so `rtk tsc` reports errors that do not exist under the compiler
  CI actually uses — verified: `rtk tsc -p apps/api/tsconfig.build.json`
  reports `TS5101 baseUrl is deprecated`, while `npx tsc` with identical
  arguments exits 0. Use `npm run typecheck`, which is what CI runs.
- **`rtk err <cmd>`** passes the command through `sh -c`, so anything with
  shell metacharacters must be quoted or it fails with a syntax error.

Everything else verified working here: `rtk git status/diff/log`, `rtk lint`,
`rtk vitest`, `rtk log`, `rtk npm`. `rtk gain` shows the running total.

The global hook (`rtk init -g`) is deliberately **not** installed: it would
auto-route commands through RTK's wrappers, including the `tsc` wrapper above,
which is exactly the case where the wrapper is wrong.
