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
