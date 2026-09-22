# CloudNivo authentication & authorization (Phase 4 + Phase 8 platform plane + Phase 15 hardening)

Per-project application auth: email/password, email OTP, magic link, phone
OTP, TOTP MFA, and bot-protection gates — with OIDC single sign-on on the
platform plane.

## Two user planes (never mixed)

| Plane    | Who                                      | Credential                                                   | Scope                         |
| -------- | ---------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| Platform | project owners (dashboard/API operators) | session JWT (`tokenType` absent)                             | organizations via memberships |
| Customer | application end-users                    | customer JWT (`tokenType: customer_access`, `aud` = project) | exactly one project           |

A platform session is meaningless on customer routes and vice versa: customer
tokens carry an audience binding verified on every request, and platform
membership checks reject customer identities (they hold no memberships).

## Platform accounts (Phase 8)

Developer signup/login against the control `users` table (scrypt, per-user
salt; unknown-email logins do equalizing dummy work):

| Method   | Path                                    | Auth                 | Notes                                             |
| -------- | --------------------------------------- | -------------------- | ------------------------------------------------- |
| POST     | `/api/v1/auth/signup`                   | none                 | `{email, password, displayName?}` → 201 + session |
| POST     | `/api/v1/auth/login`                    | none                 | 401 enumeration-safe, strict rate limit           |
| POST     | `/api/v1/auth/mfa-verify`               | none                 | `{challengeId, code}` TOTP/backup-code step-up    |
| POST     | `/api/v1/auth/logout`                   | session              | revoke session                                    |
| POST     | `/api/v1/auth/password`                 | session              | change password (policy-checked)                  |
| GET      | `/api/v1/me`                            | session              | user + organizations with roles                   |
| PATCH    | `/api/v1/me`                            | session              | display name                                      |
| POST     | `/api/v1/me/mfa/enroll`                 | session              | TOTP secret + provisioning URI (once)             |
| POST     | `/api/v1/me/mfa/confirm`                | session              | verify TOTP code → enabled + backup codes (once)  |
| POST     | `/api/v1/me/mfa/disable`                | session              | disable after code verification                   |
| GET      | `/api/v1/me/sessions`                   | session              | live sessions                                     |
| POST     | `/api/v1/me/sessions/revoke-all`        | session              | revoke all own sessions                           |
| POST     | `/api/v1/me/email/request`              | session              | verified email-change request                     |
| POST     | `/api/v1/me/email/confirm`              | session              | confirm email change                              |
| GET      | `/api/v1/auth/sso/:orgSlug/start`       | none                 | OIDC authorize redirect (PKCE + state)            |
| GET      | `/api/v1/auth/sso/callback`             | none                 | code exchange → session (or MFA step-up)          |
| GET/PUT  | `/api/v1/organizations/:id/policy`      | member / owner+admin | read / set security policy                        |
| GET/POST | `/api/v1/organizations/:id/sso`         | owner/admin          | list / register OIDC connection                   |
| DELETE   | `/api/v1/organizations/:id/sso/:connId` | owner/admin          | remove connection                                 |
| POST     | `/api/v1/organizations/:id/invites`     | owner/admin          | `{email, role}` → invite + one-time token         |
| GET      | `/api/v1/invites/:token`                | none                 | public invite preview (404 for bad/expired/used)  |
| POST     | `/api/v1/invites/:token/accept`         | session              | grants membership, marks invite used              |

Sessions are JWTs (`JWT_EXPIRES_IN`) returned as JSON and an httpOnly
`cn_session` cookie (`SameSite=Lax`, `Secure` on https). Invite tokens are
opaque (`inv_…`, 7-day expiry); only sha256 is stored. Only owners can invite
owners. Invite lookup/accept never enumerates membership.

## Platform MFA + org policy + SSO (Phase 15)

- **TOTP MFA**: enroll returns the secret + provisioning URI exactly once;
  confirm activates it and issues single-use backup codes (sha256-hashed at
  rest, shown once). Logins for MFA-enabled users return a short-lived
  challenge instead of a session; `mfa-verify` completes it. Backup codes
  are single-use and revocable via disable/re-enroll.
- **Organization policy** (`organization_policies`, one row per org, open
  defaults): allowed email domains (enforced at signup, invite, email change,
  and SSO login), `requireMfa` (logins without enrolled TOTP are refused),
  per-org password floor (`passwordMinLength`/`passwordMinClasses`), and log
  retention window (`logRetentionDays`, 7–365, default 90 — see
  `docs/operations.md`). Strictest member-org policy wins at signup/password
  change.
- **OIDC SSO**: per-org connections (`sso_connections`) hold issuer,
  client id, and an AES-256-GCM-encrypted client secret (derived key, never
  returned by any read path). Login uses PKCE + single-use state; new users
  are provisioned from the verified profile (domain policy still applies);
  orgs with `requireMfa` send SSO users through the TOTP step-up.

### Identity-provider presets (Logto, Auth0, Okta, Entra, Google)

There is one SSO implementation — the generic OIDC client above. Presets do not
add a second authentication system; they fill in what administrators get wrong.

- `GET /api/v1/auth/sso/providers` (public) returns the preset list plus the
  exact redirect URI to register with the provider. The dashboard's SSO panel
  (organization settings) drives it.
- `POST /api/v1/organizations/:id/sso` accepts either a raw `issuer` or
  `provider` + `tenant`; the issuer is built from the preset template.
  A tenant that already carries a host (`https://acme.logto.app`) replaces the
  template host rather than being substituted into it.
- **Token endpoint authentication is negotiated from discovery.** CloudNivo
  reads `token_endpoint_auth_methods_supported` and uses HTTP Basic when the
  provider advertises `client_secret_basic` (the OIDC Discovery default), a
  posted secret when only `client_secret_post` is offered, and retries once
  with the other method on a 401/`invalid_client`. This is what makes **Logto**
  work: Logto registers traditional web apps as `client_secret_basic` and
  rejects a body-posted secret outright.

**Logto setup** (hosted or self-hosted, current stable release):

1. Create a **Traditional web** application (native/SPA apps are public clients
   with no secret and cannot complete this flow).
2. Redirect URI: the `callbackUrl` returned by `/api/v1/auth/sso/providers`.
3. In CloudNivo, pick the Logto preset and enter the tenant ID or the full
   endpoint. The issuer resolves to `https://<tenant>.logto.app/oidc` — Logto
   serves discovery at `<endpoint>/oidc/.well-known/openid-configuration`.
4. Paste the app ID and app secret. The secret is encrypted server-side on
   write and is never returned by any read path.

## Token model

- **Access JWT** (default 15 min, `AUTH_ACCESS_TTL_S`): `{ sub, email,
projectId (aud), sessionId, role }`. Short-lived; validated cryptographically
  AND against live session state (revoked/expired sessions kill the token).
- **Refresh token**: opaque 32-byte secret, sha256-stored, single rotating
  slot per session. Each use retires the presented token and activates the
  next. Presenting a retired token ⇒ reuse detected ⇒ whole session revoked.
- **Verify/reset tokens**: opaque, hashed, single-use, expiring (defaults 24h /
  1h). Reset responses are enumeration-neutral (always 200).

## Endpoints (`/api/v1/projects/:id/auth/*`)

The `/auth/v1` namespace mounted per project (isolation by construction):

| Method           | Path                                       | Auth                 | Notes                                            |
| ---------------- | ------------------------------------------ | -------------------- | ------------------------------------------------ |
| POST             | `signup`                                   | none                 | scrypt hash, verification email queued           |
| POST             | `token`                                    | none                 | password or `grant_type: refresh_token` login    |
| POST             | `refresh`                                  | none                 | rotate refresh, new access pair                  |
| POST             | `logout`                                   | customer/refresh     | revokes session, always 200                      |
| GET/PATCH        | `user`                                     | customer             | safe shape; metadata allowlist only              |
| POST             | `change`                                   | customer             | current + new password                           |
| POST             | `reset-request`/`reset`                    | none                 | enumeration-neutral request, single-use complete |
| POST             | `verify`                                   | none                 | consumes email token                             |
| POST             | `anonymous`                                | none                 | anonymous user (convertible later)               |
| POST             | `convert`                                  | customer             | anonymous → email/password user                  |
| POST             | `otp-request`/`otp-verify`                 | none                 | email OTP code flow (rate-limited)               |
| POST             | `magic-request`/`magic-consume`            | none                 | passwordless magic-link flow                     |
| POST             | `mfa-enroll`/`mfa-confirm`/`mfa-disable`   | customer             | customer TOTP lifecycle                          |
| POST             | `mfa-verify`                               | none                 | customer TOTP step-up                            |
| POST             | `phone`                                    | customer             | attach a phone number                            |
| POST             | `phone-otp-request`/`phone-otp-verify`     | customer             | verify the attached phone                        |
| POST             | `phone-login-request`/`phone-login-verify` | none                 | phone OTP login                                  |
| GET              | `sessions`                                 | customer             | live sessions, token hashes redacted             |
| DELETE           | `sessions/:id`                             | customer             | owner-only revoke                                |
| POST             | `sessions/revoke-all`                      | customer             | revoke all own sessions                          |
| GET/PATCH/DELETE | `admin/users`                              | platform admin/owner | list/disable/enable/role/delete                  |
| GET/PATCH        | `config`                                   | member / admin       | project CORS allowlist                           |
| GET              | `email/status`                             | platform admin       | driver + queued count (never content)            |

## Authorization

- Data plane: platform `viewer` read-only; members+ write; project keys by
  role (`public` read, `service`/`admin` write); customers read+write their own
  rows via owner scoping, `admin` customers bypass.
- Owner scoping: tables with a `user_id` column are filtered/forced to the
  caller id (list filter, fetch-then-check with 404-no-oracle, forced insert,
  reassignment blocked). Tables without it are project-open to authorized
  callers. Service-role keys bypass.
- RLS SQL (`ownerPolicies`/`policiesToSql` in `@cloudnivo/auth`) is generated
  for defense-in-depth on real Postgres; dashboard policy management lands later.

## Storage

Per-project isolated `auth` schema (`users`, `sessions`, `one_time_tokens`,
idempotent DDL, `citext` emails) inside the CUSTOMER database — never the
control plane. Memory namespaces back dev/test with identical semantics.
Passwords are scrypt hashes; tokens sha256; sessions list never exposes hashes.

## Email + SMS

`EmailService` interface with three drivers: `memory` (dev outbox — honestly
queued, `delivered: false`, inspectable, status endpoint counts only), `resend`
(`RESEND_API_KEY` + `RESEND_FROM`), and `smtp` (`SMTP_HOST/PORT/USERNAME/
PASSWORD/FROM/SECURE`). Phone OTP goes through `SmsService`: `memory` outbox
or a generic `http` gateway (`SMS_HTTP_ENDPOINT` + `SMS_HTTP_API_KEY`).
Secrets live in env only and are never logged or returned.

## Bot protection + password policy

`CAPTCHA_PROVIDER=disabled` leaves signup/login open; `turnstile`/`hcaptcha`
with `CAPTCHA_SECRET_KEY` enforce server-side verification on anonymous auth
endpoints. Password rules are configurable: `AUTH_PASSWORD_MIN_LENGTH`
(8–64) and `AUTH_PASSWORD_MIN_CLASSES` (0–4: lower/upper/digit/symbol),
defaulting to the legacy 8/0 floor; org policies can raise the floor per
organization.

## Configuration

`AUTH_ACCESS_TTL_S` (900), `AUTH_REFRESH_TTL_S` (30d), `AUTH_RESET_TTL_S`
(1h), `AUTH_VERIFY_TTL_S` (24h), `AUTH_RATE_MAX` (10/window, auth endpoints
only), `EMAIL_DRIVER` (`memory`/`resend`/`smtp`), `SMS_DRIVER`
(`memory`/`http`), `CAPTCHA_PROVIDER` (`disabled`/`turnstile`/`hcaptcha`),
`AUTH_PASSWORD_MIN_LENGTH`/`AUTH_PASSWORD_MIN_CLASSES`. Project CORS allowlist editable by project admins;
wildcards rejected; credentials never pair with `*`.

## Client sketch

```bash
# sign up + verify + login
curl -X POST $API/api/v1/projects/$PID/auth/signup \
  -d '{"email":"u@app.com","password":"correct-horse-1"}'
curl -X POST $API/api/v1/projects/$PID/auth/token \
  -d '{"email":"u@app.com","password":"correct-horse-1"}'
# → { user, tokens: { accessToken, refreshToken }, sessionId }

# use the API as this user (owner-scoped automatically)
curl -H "Authorization: Bearer $ACCESS" $API/api/v1/projects/$PID/posts

# refresh + logout
curl -X POST $API/api/v1/projects/$PID/auth/refresh -d '{"refresh_token":"'$REF'"}'
curl -X POST $API/api/v1/projects/$PID/auth/logout -d '{"refresh_token":"'$REF2'"}'
```

## AI-generated auth (Phase 9)

The AI Builder drafts roles and owner-scoped policies as structured plan data; enforcement stays in the existing engine/RLS layer — never in model output. See docs/ai-builder.md.

## Environment authorization (production vs staging)

`USER → ORGANIZATION → PROJECT → ENVIRONMENT → RESOURCE`. The environment level
is enforced, not advisory.

**Production-ness is server-side.** `project_environments.is_production` decides
it. The `environment` field on a migration request is the caller's word and is
never what the gate reads — declaring `development` on the same destructive SQL,
against the same database, used to skip the production approval gate entirely.

`resolveEnvironment()` (`apps/api/src/migrations.ts`) resolves it:

- The declared slug must name an environment the project has. Unknown is
  refused, not silently treated as development.
- `isProduction` comes from the stored row.
- **A non-production environment sharing a database with a production one is
  treated as production.** Same data, whatever it is called. This is the
  relabelling bypass, closed.
- Projects with no environments configured keep the previous behaviour: the
  declared name is the only signal, and there is no stored truth to contradict.

**Humans** need `envs:production` — admin and owner only. Deliberately separate
from `envs:manage`: creating a staging environment and rewriting production
schema are not the same risk, so a member who may do the first cannot thereby do
the second.

**Agent tokens** carry an `environments` allowlist. Empty means every ordinary
environment — so tokens issued before this keep working — but it never means
production. Production must be named explicitly, so a token over-granted
`database.destructive` still cannot reach it. The grant gets a token to the
approval gate; it does not get it past one.

Enforcement is at **apply**, not create: create validates and executes nothing,
so a production migration can still be written for a human to review.
