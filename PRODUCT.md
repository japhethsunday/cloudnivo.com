# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: solo developers and small teams who provision and run their own backend
— database, auth, storage, functions, realtime — self-serve, without an ops team.

Secondary: platform and infrastructure engineers operating backends on behalf of
other teams (provisioning, RBAC, quotas, security review). Their capabilities
exist in the product but the self-serve developer is the design center.

Both work in the dashboard as an operator console: create a project, provision a
database, inspect live status, run SQL, wire auth, deploy functions, watch
realtime channels, read logs and usage.

## Product Purpose

CloudNivo is a developer-focused Backend-as-a-Service control plane. It gives a
developer the backend primitives of Supabase/Firebase — Postgres, auth, storage,
functions, realtime, AI, automations — while the infrastructure is provisioned
through a provider abstraction rather than a single vendor's cloud.

Success is a developer going from signup to a live, real backend without leaving
the console, and trusting what the console tells them about it.

## Positioning

Two claims together, neither of which a neighboring BaaS can truthfully copy:

1. **Agent-native.** The AI backend builder, agent tokens, and agent approvals
   are first-class parts of the control plane, not an add-on. Agents can operate
   the backend under explicit, auditable authority.
2. **Own-your-infrastructure.** The same developer experience provisions onto
   infrastructure the customer controls, through swappable provisioning drivers
   (Docker, managed Postgres, VPS/cloud later) instead of one hosted vendor.

## Operating Context

- The dashboard is a long-lived operator surface: users keep project pages open
  while infrastructure changes state underneath them.
- Work spans ~33 pages: projects and 18 per-project resource sections (database,
  SQL, auth, storage, functions, realtime, automations, AI, security, logs,
  metrics, usage, deployments, environments, integrations, API, settings), plus
  organizations, agents, billing, security, developer, account and marketing.
- The frontend is a Next.js 15 app on Vercel; it calls a standalone Node API on
  Railway across origins with a Bearer token. Every meaningful read is a live
  network read, never a cached or optimistic one.

## Capabilities and Constraints

- Confirmed live functionality backs the console: auth/session/MFA, project and
  organization CRUD, database provisioning and health, SQL, storage, realtime,
  functions, AI builder, automations, agents, billing/usage, metrics, logs.
- Strict CSP and security headers in `apps/dashboard/middleware.ts` bound the UI:
  no inline scripts, `connect-src` limited to self plus the API origin.
- Design tokens already exist in `apps/dashboard/app/globals.css` (`--accent:
  #2e6fe8` and a full neutral/semantic scale). Class names there are stable and
  referenced directly by components.
- The dashboard must degrade honestly when the API is unreachable or the session
  has expired — it must not show invented state.

## Brand Commitments

Binding, confirmed by the user:

- CloudNivo's existing logo and N-mark stay as they are.
- The existing blue brand identity stays — no rebrand, no palette replacement.
- Core product messaging stays.

## Evidence on Hand

- Real product surface in `apps/dashboard/app` and `apps/dashboard/components`.
- Existing token system and class contract in `apps/dashboard/app/globals.css`.
- Real API contract in `apps/api/src` and `docs/` (17 reference documents).
- No testimonials, customers, benchmarks, press, pricing claims or case studies
  exist. Future work must not fabricate any of them.

## Product Principles

1. **Honest state only.** Health, provisioning status and database status reflect
   real backend reads. Never fake, optimistic, placeholder or demo data where
   real functionality exists.
2. **Operator density over marketing polish.** This is a console for people doing
   work, not a landing page: information-dense, scannable, consistent.
3. **Preserve the brand, raise the craft.** The blue identity, logo and messaging
   are fixed; typography, spacing, hierarchy, navigation, cards, tables, forms,
   states, responsiveness and interaction quality are where the work happens.
4. **No generic AI-shaped UI.** Weak default patterns, debug-looking surfaces,
   clutter, dead space and per-page inconsistency are defects to remove.
5. **Every page belongs to one system.** A user moving between project sections
   should not feel they changed products.

## Accessibility & Inclusion

Accessibility is in scope as explicit product work: keyboard paths, focus
visibility, contrast against the fixed blue identity, and states that are legible
without relying on color alone. No external standard has been declared binding
yet — treat WCAG 2.2 AA as the working target until the user sets otherwise.
