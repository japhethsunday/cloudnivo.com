# CloudNivo CLI (Phase 9)

Same backend services as the dashboard — no second engine. Auth via
`CLOUDNIVO_TOKEN` (session JWT); API via `CLOUDNIVO_API_URL`.

## Install / run

```bash
npm run build --workspace=packages/cli
npx cloudnivo ai plan --project <id> --prompt "I need tasks."
```

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
