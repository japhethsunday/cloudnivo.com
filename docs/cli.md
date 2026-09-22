# CloudNivo CLI

Same backend services as the dashboard — no second engine. The CLI is a thin
client over the public API, so anything it can do, an agent calling HTTP
directly can do, and nothing more.

For the agent-oriented walkthrough see [`agent-access.md`](./agent-access.md).

## Install

```bash
npm install -g @cloudnivo/cli
# or, from this repository:
npm run build --workspace=packages/cli
```

## Environment

| Variable | Purpose |
| --- | --- |
| `CLOUDNIVO_URL` | API origin (`CLOUDNIVO_API_URL` is still honoured) |
| `CLOUDNIVO_PROJECT_ID` | Default project |
| `CLOUDNIVO_AGENT_TOKEN` | `cn_agent_…` credential — preferred for agents |
| `CLOUDNIVO_TOKEN` | Session JWT — humans |
| `CLOUDNIVO_ENVIRONMENT` | `development` / `staging` / `preview` / `production` |

`cloudnivo login` writes the credential to `~/.cloudnivo/credentials.json`
with `0600` permissions, after verifying it against the live API.

Project selection resolves most-explicit-first: `--project`, then
`CLOUDNIVO_PROJECT_ID`, then the `.cloudnivo/project.json` written by
`cloudnivo link`. It never guesses from "your only project".

## Connect and discover

```bash
cloudnivo login --agent-token cn_agent_…   # or --token <jwt>
cloudnivo whoami                           # identity + granted scopes
cloudnivo projects
cloudnivo link --project <id> [--environment development]
cloudnivo connect [--json]                 # env template for this project
cloudnivo status                           # project, database, migration state
cloudnivo discover [--service database] [--json]
```

## Database and migrations

```bash
cloudnivo db schema | advisors | pull [--out file]
cloudnivo db query --sql "select 1"
cloudnivo db diff [--base main] [--compare <branch>] [--include-drops]
cloudnivo db migrations
cloudnivo db push --file migration.sql [--name n] [--dry-run]
cloudnivo db preview --migration <id>
cloudnivo db apply --migration <id> [--approval <approvalId>]
cloudnivo types [--out src/db-types.ts]
```

`db push` creates a migration (validated, checksummed, destructive operations
detected) and then applies it. `--dry-run` stops after creation. Destructive
and production migrations are held for human approval — see
[`agent-access.md`](./agent-access.md#approvals).

## Build

```bash
cloudnivo auth config | set --config '{...}'
cloudnivo storage list | create --name <bucket> [--public]
cloudnivo functions list | deploy --function <slug> --source <file>
cloudnivo functions invoke --function <slug> [--payload '{...}']
cloudnivo functions logs --function <slug>
cloudnivo secrets list | set --name N --from-env VAR | rotate | delete --name N
cloudnivo env list | use --slug <env> | create --name N --slug S [--preview]
```

Secret values are only ever read from an environment variable named by
`--from-env`. They are never accepted as a flag, because flags land in shell
history and in the process table.

## Ship

```bash
cloudnivo deploy [--function <slug> --source <file>]
cloudnivo logs [--function <slug>]
```

`deploy` applies pending migrations before deploying code.

## Exit codes

`0` success · `2` denied (auth/scope/tenant) · `3` approval required ·
`4` rate limited · `1` everything else.

Failures print the error code, the API's own remediation, the approval id
when one applies, and the request id.

## AI commands

```bash
cloudnivo ai plan --project <id> --prompt "..."        # generate (never executes)
cloudnivo ai approve --project <id> --plan <planId> [--confirm "DROP TABLE"]
cloudnivo ai apply --project <id> --plan <planId>      # approved only
cloudnivo ai status --project <id> --plan <planId>     # preview + steps
cloudnivo ai usage --project <id>                      # counters
```

Approval and destructive-confirmation rules match the dashboard exactly —
the CLI is a thin client over the same routes.

## Automation, metrics, debugger (Phase 14)

```bash
cloudnivo ai diagnose --project <id> [--ref <job|function>] [--note "..."]
cloudnivo queues create|list|publish|consume|ack|purge --project <id> ...
cloudnivo schedules create|list|trigger|pause|resume|delete --project <id> ...
cloudnivo webhooks create|list|deliveries|test|replay|rotate|delete --project <id> ...
cloudnivo metrics --org <org> --project <id> [--window 1h|6h|24h|7d]
```
