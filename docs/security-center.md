# Security Center

Dashboard → Security. A live posture scan over one organization. Every
finding is read from the API at scan time — nothing is sampled, staged,
or estimated. Rescan any time; the score recomputes from current state.

## Score

Starts at 100 per scan. High −10, medium −4, low −1 (floor 0).
Grades: ≥90 Strong · ≥75 Good · ≥50 Needs attention · else At risk.

## Rules (all enforced against real API state)

| Severity | Rule | Fix lands on |
|---|---|---|
| High | Public storage bucket | Project → Storage |
| High | Agent token never expires + destructive scope | Agent Access |
| High | CORS allows any origin (`*`) | Project → Authentication |
| High | Billing quota exhausted (any meter ≥100%) | Billing |
| High | Subscription past due | Billing |
| Medium | Service API key never expires | Project → API → keys |
| Medium | Destructive agent scopes without approval gate | Agent Access |
| Medium | Agent token never expires | Agent Access |
| Medium | Quota over 80% | Billing |
| Medium | Failed provisioning/deploy job (latest 3/project) | Project → Logs |
| Medium | Verification emails never delivered (dev driver + users exist) | Project → Authentication |
| Medium | Subscription canceled (free limits apply) | Billing |
| Low | Expired key/token still listed (revoke for exact inventory) | API / Agent Access |
| Low | Active users with unverified email | Project → Authentication |

Dangerous scopes: `projects.delete`, `database.migrate`,
`database.destructive`, `functions.deploy`, `functions.delete`,
`storage.delete`.

## Scope and limits

- Scans the selected organization; first 10 projects (noted in the UI).
- Findings link to the screen that fixes them. High-risk fixes that are
  destructive (project delete, deploys) stay behind the existing approval
  gates — the scanner never applies changes itself.
- Raw tokens and secrets are never read, logged, or displayed; only ids,
  names, scopes, and expiries are evaluated.

## E2E

`tests/e2e/security.spec.ts` seeds a public bucket and a never-expiring
service key through the real API and asserts both findings plus the score.
