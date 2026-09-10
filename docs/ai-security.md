# CloudNivo AI security model (Phase 9)

All model output is untrusted input. Every layer below assumes the model is
adversarial or compromised and still holds.

## Threat model

Prompt injection (direct + indirect via project content), cross-project
context leakage, secret exfiltration to/through the model, unauthorized
infrastructure changes, destructive AI actions, tool abuse, generated SQL
injection, generated code vulnerabilities, privilege escalation, output
manipulation, resource exhaustion, endpoint abuse.

## Controls

- **Schema-bound output.** Model JSON must parse via the strict plan schema;
  prose, extra operations, and unknown fields are rejected, not interpreted.
- **Context minimization.** The planner receives live project facts (tables,
  buckets, functions, channels, roles) with secret-bearing fields stripped
  (`sanitizeContext`). Passwords, API secrets, DB passwords, JWT keys,
  refresh tokens, and infra credentials never reach a model.
- **Prompt hygiene.** Stored prompts are truncated and secret-assignment
  scrubbed (`redactPrompt`). Raw prompts never persist.
- **Project isolation.** Plans, approvals, tools, audit, and usage are all
  keyed by URL project id; cross-project access reads 404 with no oracle.
  The AI holds no more permission than the initiating caller
  (`levelForRole`); tool calls re-check independently.
- **Destructive gates.** DROP/DELETE/REMOVE intents are detected in prompts
  and plan text; approval alone cannot apply them — explicit per-operation
  confirmations are required (428 otherwise).
- **SQL safety.** DDL is generated from structured objects with allow-listed
  identifiers; generated SQL is scanned (no stacked statements, no dangerous
  keywords, quoted identifiers validated); execution goes through the guarded
  single-statement project-DB executor.
- **Code safety.** Generated handlers are deny-list scanned (child_process,
  eval, fs, network, env theft, hardcoded secrets, privilege ops, vm-escape
  patterns) and then built/deployed through the isolated Functions runtime.
- **Tool boundaries.** Six named tools, each with a minimum permission level
  and argument validation; unknown tools and under-privileged calls fail
  closed. Generation tools (read-only) are separated from execution tools
  (admin-only).
- **Rate limiting.** AI endpoints are budgeted per user+project (`AI_RATE_MAX`)
  on top of the global IP budget — model calls are expensive by design.
- **Audit + honesty.** Every transition is audit-logged with redacted
  prompts; usage counts tokens only as reported; estimates are counts, never
  fabricated costs; partial applies report failure, never success.
- **Credential handling.** `AI_API_KEY` lives in server env; HTTP provider
  errors never echo it; responses never include it.

## What the AI cannot do

Bypass authorization, read another project's state or secrets, delete
production infrastructure without explicit confirmation, execute streamed
partial output (only validated final plans enter the pipeline), or reach
control-plane internals — adapters expose exactly one project's services.
