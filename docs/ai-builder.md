# CloudNivo AI Backend Builder (Phase 9)

Describe the backend you need in natural language; CloudNivo drafts a
validated, structured plan and applies it only after your approval. Generation
and execution are separate systems — the model proposes, CloudNivo disposes.

## Architecture

```text
Developer ──► Dashboard / CLI / SDK ──► AI API ──► AIBackendBuilder ──► validated plan
                                                              │
                                        approve ──► apply ──► project-bound tools ──► real services
                                                              (migration, buckets, functions, realtime)
```

Package map (`packages/ai/src`):

| Module         | Role                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `plan.ts`      | Strict zod schema — model output parses here or is rejected                                             |
| `validate.ts`  | Cross-field checks: dupes, dangling FKs, missing PKs, cycles, conflicts, destructive scan               |
| `provider.ts`  | `AIProvider` interface; local deterministic planner + OpenAI-compatible HTTP provider; secret scrubbing |
| `planner.ts`   | `AIBackendBuilder`: analyze/generate*/validate/estimate/apply with stop-on-failure + rollback           |
| `migrate.ts`   | Structured schema → ordered, checksummed DDL + inverse rollback statements                              |
| `preview.ts`   | Live-state diff (+/-/~) and honest resource counts                                                      |
| `approvals.ts` | pending→approved                                                                                        | rejected→applying→applied | failed | rolled_back; destructive confirmations; permission levels |
| `tools.ts`     | Tool registry with independent permission + arg checks                                                  |
| `scanner.ts`   | Generated-code/SQL safety scan (deny-list)                                                              |
| `audit.ts`     | AI audit log (redacted prompts) + usage tracker (reported tokens only)                                  |
| `openapi.ts`   | HTTP path fragments                                                                                     |

## Supported capabilities

Natural language → database tables/columns/PKs/FKs/indexes, auth roles +
policies, storage buckets, realtime channels, serverless functions, env
declarations. The local planner recognizes school, ecommerce, chat, blog, task,
notification, and profile domains; anything else yields an honest empty plan
rather than a hallucinated schema. Frontier models plug in via
`AI_PROVIDER=openai-compatible` with `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL`.

## Provider configuration

| Var                     | Default                     | Purpose                                                      |
| ----------------------- | --------------------------- | ------------------------------------------------------------ |
| `AI_PROVIDER`           | `local`                     | `local` offline planner, `openai-compatible` frontier models |
| `AI_MODEL`              | `local-planner-v1`          | Model id (reported in plans/usage)                           |
| `AI_API_KEY`            | ``                          | Provider credential — env only, never logged or returned     |
| `AI_BASE_URL`           | `https://api.openai.com/v1` | Chat-completions endpoint                                    |
| `AI_REQUEST_TIMEOUT_MS` | `60000`                     | Provider call budget                                         |
| `AI_RATE_MAX`           | `20`                        | AI requests/min per user+project                             |
| `AI_MAX_PROMPT_CHARS`   | `8000`                      | Prompt size cap                                              |

## Structured plans

Every plan is `{version:1, summary, database, auth, storage, realtime,
functions, env}` validated by zod, then semantically validated (duplicates,
dangling relations, missing keys, cycles, live-state conflicts). Malformed
model output throws `PlanParseError` — it can never enter the pipeline.

## Approval system

`pending` plans show analysis, architecture, change list, validation, and
migration-SQL preview. Admins approve (members need `APPROVAL_REQUIRED`
escalation); plans carrying destructive ops additionally require explicit
per-operation confirmations (`428` until given). Rejected plans are terminal.
Only `approved` plans apply.

## Migrations

DDL is built from structured objects with allow-listed identifiers — model
text never reaches SQL. Statements run in order through the guarded project-DB
executor; the first failure stops the pipeline. When only the migration ran,
inverse `DROP TABLE` statements execute automatically (`rolled_back`); later
failures stop and report without claiming success.

## Generated functions

Trigger-based specs become scaffolded handlers (or model source when the plan
carries it). Every source passes the safety scanner, then deploys through the
existing Functions pipeline (verified build, isolated runtime). Scanned-out
code blocks the whole apply.

## Rollback

Best-effort inverse migration when the failure happens at the migration step;
otherwise stop-and-report. Status is always one of the terminal states —
never a partial "success".

## Usage tracking

Per-project requests, generated/applied/failed plans, provider-reported token
counts (null-safe — local runs report none, never fabricated), latency. Ready
for billing aggregation.

## Local development

```bash
cp .env.example .env   # AI_* default to the local planner — no keys needed
npm run dev:api
```

Open `/projects/:id/ai`, describe a backend, review the plan, approve, apply.
CLI: `CLOUDNIVO_TOKEN=… npx cloudnivo ai plan --project <id> --prompt "…"`.

## Railway deployment

AI runs in-process on the API service (local planner is CPU-trivial). Long
provider calls are timeout-bounded and never block other routes; a dedicated
AI worker can reuse the same builder behind Redis later. No AI credentials are
committed — set `AI_API_KEY` in Railway env when using frontier models.
