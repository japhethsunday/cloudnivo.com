# Agent & developer access

How a coding agent — Claude Code, Cursor, Codex, OpenCode, or your own — gets
a CloudNivo project and builds a real backend in it.

The loop is: **connect → discover → build → migrate → deploy → verify.**

---

## 1. Connect

A human issues the credential; the agent never creates its own.

1. Open the project → **Connect** → **Coding agent**.
2. **Open Agent access** → create a token. Pick the scopes the task needs,
   an expiry, and leave **approval required** on.
3. Copy the `cn_agent_…` value. It is shown once and is never readable again —
   not by you, not by support, not by the API.

Hand the agent three variables:

```
CLOUDNIVO_URL=https://api.cloudnivo.com
CLOUDNIVO_PROJECT_ID=<project uuid>
CLOUDNIVO_AGENT_TOKEN=cn_agent_…
CLOUDNIVO_ENVIRONMENT=development
```

Put them in the environment or a secret manager. Never in source, never in a
commit, never in a frontend bundle.

Then:

```bash
npm install -g @cloudnivo/cli
cloudnivo login --agent-token "$CLOUDNIVO_AGENT_TOKEN"
cloudnivo link --project "$CLOUDNIVO_PROJECT_ID"
cloudnivo status
```

`cloudnivo link` writes `.cloudnivo/project.json` — a non-secret pointer, safe
to commit.

## 2. Discover

An agent should never guess an endpoint.

```bash
cloudnivo discover                 # every service and operation
cloudnivo discover --service database
cloudnivo whoami                   # what THIS token may do
```

Over HTTP, unauthenticated:

```
GET /api/v1/discovery           capability manifest
GET /api/v1/discovery/scopes    scope catalog
GET /.well-known/cloudnivo.json pointer from a bare origin
```

The manifest lists, per operation, the scopes it requires, whether it is
destructive, and whether it can be unblocked by approval. It also carries the
error-code catalog and the environment-variable template.

Project-specific facts come from one call:

```
GET /api/v1/projects/:id/connect
```

## 3. Build

```bash
cloudnivo db schema
cloudnivo db advisors
cloudnivo auth config
cloudnivo storage create --name uploads
cloudnivo functions deploy --function hello --source ./hello.js
cloudnivo secrets set --name STRIPE_KEY --from-env STRIPE_KEY
```

Secret values are never accepted as command-line flags — shell history and the
process table are readable by other local users. `--from-env` names the
variable holding the value.

## 4. Migrate

The workflow is deliberately three steps, and nothing is applied implicitly.

```bash
# create — validated, destructive operations detected, checksum pinned.
# NOTHING runs yet.
cloudnivo db push --file migrations/add_posts.sql --dry-run

# preview — what it would do against the live schema
cloudnivo db preview --migration <id>

# apply — one transaction; rolls back entirely on failure
cloudnivo db apply --migration <id>
```

`cloudnivo db push` without `--dry-run` does create-then-apply in one go.

What the platform guarantees:

- **Nothing is half-applied.** One transaction; a failure rolls back and is
  recorded as `failed`, not left ambiguous.
- **Order is enforced.** A migration cannot skip an earlier pending one.
- **The reviewed SQL is the SQL that runs.** A checksum is pinned at creation
  and re-verified at apply.
- **Destructive work stops.** `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`,
  unbounded `DELETE`, type changes and constraint drops are detected and
  reported with a code you can branch on.
- **Production always stops**, destructive or not, even for a token holding
  `database.destructive`. An over-granted token is exactly the failure this
  gate exists to survive.

### Approvals

A held operation returns **HTTP 428**:

```json
{
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "Destructive operation held for approval (database.migration.apply:production).",
    "remediation": "Ask an organization owner to approve this request, then repeat the identical request with the X-Approval-Id header set to data.approval.id.",
    "requestId": "…"
  },
  "data": { "approval": { "id": "apr_…", "status": "pending", "expiresAt": "…" } }
}
```

An owner approves in **Agent access → Approvals**. The agent then repeats the
*identical* request with `X-Approval-Id: apr_…`, or:

```bash
cloudnivo db apply --migration <id> --approval apr_…
```

The approval is bound to the exact method, path and body, and is consumed
once.

## 5. Deploy and verify

```bash
cloudnivo deploy --function api --source ./api.js   # migrations first, then code
cloudnivo types --out src/db-types.ts
cloudnivo db migrations
cloudnivo logs
```

`deploy` applies pending migrations before deploying code, so a handler that
needs a column never reaches production before the column does.

---

## Error contract

Every failure is the same shape:

```json
{
  "error": {
    "code": "FORBIDDEN_SCOPE",
    "message": "Agent token lacks required scope: database.migrate",
    "remediation": "Grant the named scope to the token (rotate or re-issue it) — scopes cannot be widened at request time.",
    "requestId": "…"
  }
}
```

Branch on `code`, never on `message`. `remediation` says what to do.
`requestId` is echoed in the `X-Request-Id` header.

CLI exit codes: `0` success · `2` denied (auth/scope/tenant) · `3` approval
required · `4` rate limited · `1` everything else.

## Security model

Agent tokens are not service accounts with the keys to the building.

| Control | Behaviour |
| --- | --- |
| Scopes | Enforced per operation. `cloudnivo discover` states which scope each needs. |
| Organization isolation | A token is bound to one organization (or the user's memberships). |
| Project isolation | `projectIds` confines a token to named projects. |
| Environments | `development` / `staging` / `preview` / `production`. Production always needs approval. |
| Expiry | 7d / 30d / 90d / 365d / never. |
| Revocation | Immediate — the next request fails. |
| Rotation | Issues a new secret and kills the old one in the same call. |
| IP allowlist | Optional CIDR/exact list, up to 20 entries. |
| Rate limits | Per token and per IP. |
| Audit | Every action, allowed or denied, in **Agent access → Activity**. |

Things an agent **cannot** do, whatever scopes it holds:

- Read a database password (`?reveal=true` is refused and recorded).
- Reveal a vault secret.
- Create, list, or revoke project API keys.
- Issue or widen an agent token.
- Apply a production migration without a human approval.
- Reach another organization's or project's resources.

## SDK

```ts
import { CloudNivoClient, SdkError } from '@cloudnivo/sdk';

const cn = new CloudNivoClient({
  baseUrl: process.env.CLOUDNIVO_URL!,
  token: process.env.CLOUDNIVO_AGENT_TOKEN!,
});

const manifest = await cn.discover();
const bundle = await cn.connect(process.env.CLOUDNIVO_PROJECT_ID!);

const { migration } = await cn.createMigration(bundle.project.id, {
  name: 'add_posts',
  sql: 'create table posts (id uuid primary key, title text not null default \'\');',
  environment: 'development',
});

try {
  await cn.applyMigration(bundle.project.id, migration.id);
} catch (err) {
  if (err instanceof SdkError && err.needsApproval) {
    // Hand err.approvalId to a human, then retry with { approvalId }.
  }
}
```

`SdkError` carries `code`, `remediation`, `requestId` and, on a 428,
`approvalId`.

## Related

- [`agent-tokens.md`](./agent-tokens.md) — token model and scope catalog
- [`cli.md`](./cli.md) — full CLI reference
- [`sdk.md`](./sdk.md) — SDK reference
- [`database.md`](./database.md) — database plane
- [`security.md`](./security.md) — platform security model
