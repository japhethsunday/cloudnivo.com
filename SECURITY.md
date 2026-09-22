# Security policy

CloudNivo provisions and operates real infrastructure for real tenants. Security
reports are welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/japhethsunday/cloudnivo.com/security/advisories/new).

Helpful reports include:

- the affected component (`apps/api`, `apps/dashboard`, a package under `packages/`)
- the version or commit you tested
- reproduction steps, ideally a minimal request or script
- the impact you believe it has — cross-tenant read, privilege escalation,
  credential disclosure, denial of service

Please do not include live credentials in a report. Describe where a secret is
rather than pasting its value; anything pasted is considered compromised and must
be rotated.

## Scope

In scope: cross-tenant access, authentication and session handling, API key and
agent token handling, SQL injection, SSRF, function sandbox escape, credential
storage, and the production boot guards.

Out of scope: findings that require an already-compromised host, dependency
advisories with no reachable path from the deployed API or dashboard, and the
risks already documented and accepted in
[`SECURITY-AUDIT.md`](SECURITY-AUDIT.md#remaining-risks).

## What already exists

- A severity-classified audit with 0 open critical and 0 open high findings:
  [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md)
- The threat model and enforced boundaries: [`docs/security.md`](docs/security.md)
- The production hardening checklist:
  [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md#production-security-checklist)
- The DDoS and abuse incident procedure: [`docs/ddos-response.md`](docs/ddos-response.md)

## Running the security suite

```bash
npx vitest run apps/api/src/security.test.ts apps/api/src/client-ip.test.ts \
  apps/api/src/ssrf.test.ts packages/functions/src/sandbox-escape.test.ts \
  packages/api-core/src/unique-violation.test.ts \
  packages/auth/src/password-baseline.test.ts
```
