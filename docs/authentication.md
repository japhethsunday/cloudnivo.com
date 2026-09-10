# CloudNivo authentication & authorization (Phase 4 + Phase 8 platform plane)

Per-project application auth: email/password today, provider-ready
architecture (OAuth, Magic Link, OTP) tomorrow with no core rewrite.

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

| Method | Path                                | Auth        | Notes                                             |
| ------ | ----------------------------------- | ----------- | ------------------------------------------------- |
| POST   | `/api/v1/auth/signup`               | none        | `{email, password, displayName?}` → 201 + session |
| POST   | `/api/v1/auth/login`                | none        | 401 enumeration-safe, strict rate limit           |
| GET    | `/api/v1/me`                        | session     | user + organizations with roles                   |
| POST   | `/api/v1/organizations/:id/invites` | owner/admin | `{email, role}` → invite + one-time token         |
| GET    | `/api/v1/invites/:token`            | none        | public invite preview (404 for bad/expired/used)  |
| POST   | `/api/v1/invites/:token/accept`     | session     | grants membership, marks invite used              |

Sessions are JWTs (`JWT_EXPIRES_IN`) returned as JSON and an httpOnly
`cn_session` cookie (`SameSite=Lax`, `Secure` on https). Invite tokens are
opaque (`inv_…`, 7-day expiry); only sha256 is stored. Only owners can invite
owners. Invite lookup/accept never enumerates membership.

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

| Method           | Path                    | Auth                 | Notes                                            |
| ---------------- | ----------------------- | -------------------- | ------------------------------------------------ |
| POST             | `signup`                | none                 | scrypt hash, verification email queued           |
| POST             | `token`                 | none                 | password or `grant_type: refresh_token` login    |
| POST             | `refresh`               | none                 | rotate refresh, new access pair                  |
| POST             | `logout`                | customer/refresh     | revokes session, always 200                      |
| GET/PATCH        | `user`                  | customer             | safe shape; metadata allowlist only              |
| POST             | `change`                | customer             | current + new password                           |
| POST             | `reset-request`/`reset` | none                 | enumeration-neutral request, single-use complete |
| POST             | `verify`                | none                 | consumes email token                             |
| GET              | `sessions`              | customer             | live sessions, token hashes redacted             |
| DELETE           | `sessions/:id`          | customer             | owner-only revoke                                |
| POST             | `sessions/revoke-all`   | customer             | revoke all own sessions                          |
| GET/PATCH/DELETE | `admin/users`           | platform admin/owner | list/disable/enable/role/delete                  |
| GET/PATCH        | `config`                | member / admin       | project CORS allowlist                           |
| GET              | `email/status`          | platform admin       | driver + queued count (never content)            |

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

## Email

`EmailService` interface; memory driver queues honestly (`delivered: false`,
inspectable outbox, status endpoint counts only). SMTP/transactional drivers
plug in later with no caller changes.

## Configuration

`AUTH_ACCESS_TTL_S` (900), `AUTH_REFRESH_TTL_S` (30d), `AUTH_RESET_TTL_S`
(1h), `AUTH_VERIFY_TTL_S` (24h), `AUTH_RATE_MAX` (10/window, auth endpoints
only), `EMAIL_DRIVER`. Project CORS allowlist editable by project admins;
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
