# Agent Access Tokens

Dedicated `cn_agent_…` credentials that let approved AI/developer agents
(Claude Code, OpenCode, compatible tools) manage your CloudNivo resources
through the API — without sharing your password, session, or project keys.

## Concepts

- **Separate credential type.** Agent tokens are not user API keys: they are
  organization- (or account-) scoped, carry granular scopes, expire, revoke
  instantly, and optionally gate destructive operations behind approval.
- **Raw value shown once.** Only a sha256 hash is stored. The raw token
  appears once at creation; it is never logged, never returned again, and
  never appears in audit records (only token ids do).
- **Server-side enforcement.** Every request re-verifies revocation/expiry,
  then checks scope + organization/project isolation. Frontend selections are
  convenience only.

## Creating a token

Dashboard → Agents (or Account → Agent access) → New agent token:

1. **Name** it (`Claude Code`).
2. **Permissions**: tick scopes. Read scopes are pre-selected; anything
   marked *dangerous* (`projects.delete`, `database.migrate`,
   `database.destructive`, `functions.deploy`, `functions.delete`,
   `storage.delete`) needs a deliberate tick.
3. **Projects**: empty means the whole organization; otherwise pick projects.
4. **Approval mode** (optional): destructive calls answer `428` instead of
   executing until you approve them in the inbox.
5. **Expiration**: 7/30/90/365 days or never.

Copy the raw value immediately — it cannot be recovered.

## Authenticating

```
Authorization: Bearer cn_agent_xxxxxxxxxxxxxxxxxxxxxxxxx
```

All planes accept it (projects, data, storage, functions, realtime WS via
`?token=`, AI builder, billing reads). Unknown, revoked, or expired tokens
get `401`/`403` with machine-readable codes (`INVALID_TOKEN`,
`TOKEN_REVOKED`, `TOKEN_EXPIRED`, `FORBIDDEN_SCOPE`, `TENANT_FORBIDDEN`).

## Scopes

| Service | Scopes |
|---|---|
| Projects | `projects.read`, `projects.create`, `projects.update` (lifecycle actions), `projects.delete` ⚠️ |
| Database | `database.read`, `database.write`, `database.sql`, `database.migrate` ⚠️, `database.destructive` ⚠️ |
| Functions | `functions.read`, `functions.deploy` ⚠️ (also invoke), `functions.update`, `functions.delete` ⚠️ |
| Storage | `storage.read`, `storage.write`, `storage.delete` ⚠️ |
| Realtime | `realtime.read` (connect/subscribe), `realtime.manage` (broadcast) |
| Logs | `logs.read` (jobs + function logs) |
| Environment | `environment.read`, `environment.write` (function env vars, auth config) |
| Metering | `usage.read`, `billing.read` (reads only — agents can never change plans, generate invoices, or open portals) |

⚠️ = dangerous: never pre-selected. Agents can never manage API keys,
reveal database credentials, invite members, or touch customer-auth flows.

## Approval mode

With approval mode on, a destructive call (project/function/bucket delete,
function deploy, destructive SQL or AI apply) returns `428
APPROVAL_REQUIRED` with an approval id — nothing executes. Approve in the
dashboard inbox (or `POST
/organizations/{id}/approvals/{approvalId}/approve`), then the agent repeats
the **identical** request with `X-Approval-Id`. Approvals bind to the exact
method + path + body, expire after 24h, and burn on first use (no replays).

## Activity

Account → Agent access → Activity (or
`GET /organizations/{id}/agent-activity`) records token lifecycle, denials
with reasons, approvals, and successful mutations. Raw tokens never appear.

## CLI

```bash
cloudnivo agent login --token <cn_agent_…>   # verified, then saved 0600
cloudnivo agent whoami                        # name, scopes, expiry
cloudnivo agent projects                      # visible projects
cloudnivo agent deploy --project <id> --function <slug> --source ./handler.js
```

Credentials live in `~/.cloudnivo/credentials.json` (0600); `CLOUDNIVO_AGENT_TOKEN`
/ `CLOUDNIVO_TOKEN` env vars always win (CI-friendly). Tokens are never printed.

## SDK

```ts
import { CloudNivoClient } from '@cloudnivo/sdk';

// Session JWT or agent token — same header.
const cn = new CloudNivoClient({ baseUrl, token: process.env.CLOUDNIVO_AGENT_TOKEN });
const who = await cn.agentWhoami();
const { token, raw } = await cn.createAgentToken(orgId, {
  name: 'ci',
  scopes: ['projects.read'],
  expiresIn: '30d',
});
await cn.deleteProject(projectId, approvalId); // approval id when required
```

## Security best practices

- One token per agent per purpose; narrow projects, short expiry.
- Prefer approval mode for anything that can delete.
- Revoke immediately when an agent is decommissioned (instant effect).
- Treat the raw value like a password: env vars or secret stores only.
- Watch the activity feed for `denied`/`blocked` entries.
- Per-token rate limits apply on top of IP budgets (`AGENT_RATE_MAX`).
