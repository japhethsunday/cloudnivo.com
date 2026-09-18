# DDoS response plan

Written before an attack, because during one nobody reads a plan they are also
writing. If you are reading this because something is on fire, go straight to
[Right now](#right-now).

This plan is specific to how CloudNivo is actually deployed: the dashboard on
Vercel, the API, worker and realtime services on Railway, Postgres and Redis
managed by Railway, `api.cloudnivo.org` and `www.cloudnivo.org` as the public
names. It names real commands against real controls. A plan full of
"consider scaling horizontally" is a plan nobody can execute at 03:00.

---

## Right now

Do these in order. Do not skip to step 4 because it sounds more decisive.

1. **Confirm it is an attack, not a launch.** `GET /api/v1/admin/observability`
   (staff) or the Railway metrics tab. An attack shows a request rate far above
   normal with an error rate climbing and **no** matching growth in signups or
   projects. A successful marketing push looks the same on request rate and
   nothing else.
2. **Read who is doing it.** `GET /api/v1/admin/security` returns the edge
   block: WAF mode, rules loaded, `wafBlocked24h`, `bans24h`, and the live
   policy. Grep the API logs for `waf.block` and `threat.banned_request` — both
   carry the IP, the rule and the offence count.
3. **Let the automatic defences work for sixty seconds.** The WAF and the
   adaptive tracker already refuse hostile shapes and ban escalating IPs
   without anyone being woken up. Most events end here. Changing five settings
   at once destroys the evidence of which one helped.
4. **If it is still degrading, escalate through the levels below.**

**Do not**, in the first ten minutes: disable the WAF "to reduce latency",
restart the API to "clear it" (a restart drops the in-memory metrics you are
diagnosing from and resets nothing that matters — bans live in Redis), or
raise `RATE_LIMIT_MAX_REQUESTS` to stop the 429s. The 429s are the system
working.

---

## Severity levels

| Level | What it looks like | Who | Target |
|---|---|---|---|
| **L1 — Noise** | Scanners, probe traffic, a few banned IPs. Error rate normal. | Nobody. Automatic. | — |
| **L2 — Degradation** | p95 latency up, 429s rising, customers have not complained yet. | On-call engineer | 15 min |
| **L3 — Outage** | Health checks failing or customers reporting errors. | On-call + one more | 5 min |
| **L4 — Sustained** | L3 continuing past 30 minutes, or returning after mitigation. | Everyone + provider support | Continuous |

---

## L1 — Noise (no human action)

The edge handles this. It is worth knowing what it is doing so you recognise
it in the logs rather than paging on it.

- The **WAF** (`apps/api/src/waf.ts`) refuses malicious request shapes before
  routing — traversal, SQL injection syntax, XSS, command injection, scanner
  probes for software this stack does not run, and self-identified attack
  tools. It runs on path, query and headers for every request. It does **not**
  inspect bodies on tenant data planes, because that is where customers'
  own SQL and JSON legitimately live.
- The **adaptive tracker** (`apps/api/src/threat.ts`) scores behaviour per IP
  and escalates `normal → throttled → banned`. It weights *what* a request
  tried to do, not how many there were: failed logins against many different
  accounts score far higher than the same account retried, and 404s across
  many paths score far higher than one stale link.
- Bans live in Redis, so every API instance honours a ban placed by any one of
  them, and they **expire on their own**. An automated ban is never permanent.

Expect a steady trickle of `waf.block` lines. That is the internet.

---

## L2 — Degradation

### Tighten the adaptive policy

Env vars on the API service — no code change, no deploy of new code:

```bash
railway variables --set THREAT_THROTTLE_AT=30 \
                  --set THREAT_BAN_AT=60 \
                  --set THREAT_BAN_S=3600 \
                  --service cloudnivo-api --environment production
```

Lower thresholds ban faster; a longer `THREAT_BAN_S` keeps a proven attacker
out for an hour instead of fifteen minutes. Restore the defaults (50 / 120 /
900) once the event is over — permanently aggressive thresholds eventually ban
a customer behind a busy NAT.

### Tighten the fixed limiter

```bash
railway variables --set RATE_LIMIT_MAX_REQUESTS=40 \
                  --service cloudnivo-api --environment production
```

This one is blunt and hits everyone. Use it when the traffic is distributed
enough that per-IP reputation is not converging.

### Check you are seeing real client IPs

If every request appears to come from one address, `TRUSTED_PROXY_HOPS` is
wrong and **every IP-based defence is pointed at your own proxy**. It must
equal the number of proxies actually in front of the API. Verify before
tuning anything else — the rest of this page assumes the IPs are real.

---

## L3 — Outage

### Put a network-layer filter in front

The WAF is application-layer: it runs inside the API process, so it protects
the application but the packets still arrive. A volumetric flood must be
absorbed before it reaches Railway.

If the domains are not already proxied through a CDN with DDoS protection,
this is the moment, and it is a DNS change:

1. Add `cloudnivo.org` to Cloudflare (or the provider of record).
2. Point `api.cloudnivo.org` and `www.cloudnivo.org` at it **proxied**
   (orange cloud), not DNS-only.
3. Enable "Under Attack" mode for the duration.
4. Set `TRUSTED_PROXY_HOPS` to match the new chain — one more hop than before.
   Get this wrong and every request looks like it comes from Cloudflare, and
   the adaptive tracker bans the whole internet or nobody.

> Doing this during an incident costs a DNS propagation delay. Doing it now,
> before one, costs an afternoon. This is the single highest-value item on this
> page.

### Shed load deliberately

Better to serve some customers than none:

```bash
railway variables --set WAF_MODE=block \
                  --set RATE_LIMIT_MAX_REQUESTS=20 \
                  --set THREAT_BAN_AT=40 \
                  --service cloudnivo-api --environment production
```

### Scale the API horizontally

More instances share the same Redis, so bans and limits stay coherent across
them. Scale in the Railway dashboard (service → Settings → Replicas). This
buys time; it does not fix anything, and past a point it just moves the
bottleneck to Postgres.

### Protect the database

Postgres is the floor. If connections are exhausted, everything fails even
after the flood stops:

- `PROVISION_MAX_CONNECTIONS` caps per-project pools.
- Check Railway's Postgres metrics for connection count and CPU.
- If provisioning jobs are piling up, pause the worker rather than letting it
  compete with live traffic for connections.

---

## L4 — Sustained

- **Open a provider ticket.** Railway and Cloudflare both act on volumetric
  attacks, and both ask for the same evidence: timestamps in UTC, target
  hostnames, sample source IPs, request rate, and what you have already done.
  Have it ready before you open the ticket.
- **Consider an allowlist-only posture** for the API if the platform is
  otherwise unusable: `THREAT_ALLOWLIST_IPS` for known-good egress, everything
  else throttled hard. This is a decision to be down for most people in order
  to be up for some. Say so explicitly when you make it.
- **Keep the status page current.** `/status` is served by the dashboard and
  does not depend on the API being healthy. Customers forgive an outage; they
  do not forgive silence.

---

## Communication

- **Internal:** one channel, one incident, timestamps in UTC. Every mitigation
  applied gets a line: what, when, by whom. This is what the post-incident
  review reads, and memory is not a log.
- **Customers:** post at L3 within 15 minutes, then every 30 minutes even when
  the update is "no change". Say what is affected and what you are doing. Never
  publish which rule or threshold stopped the attack — that is a tuning guide
  for the next attacker.
- **Never** post source IPs, WAF rule ids, or thresholds publicly.

---

## After it ends

Within 48 hours, while it is still fresh:

1. **Restore the defaults.** Tightened thresholds left in place become the
   thing that bans a legitimate customer next month. Diff the API service's
   variables against `.env.production.example`.
2. **Check for false positives.** Grep `waf.block` for rules that fired on
   what turned out to be real traffic. A rule that catches customers is worse
   than no rule, because it is the reason someone eventually sets
   `WAF_MODE=off`.
3. **Write the timeline.** First signal, first human action, what each
   mitigation changed, when it ended. Attach the numbers.
4. **Fix one thing.** Every incident should leave one durable improvement — a
   new rule, a corrected threshold, a control moved to the edge, or a
   correction to this page. If nothing changed, the next one goes the same way.

---

## Pre-attack checklist

The work that makes the plan above executable. Do it on a quiet afternoon.

- [ ] Domains proxied through a CDN with network-layer DDoS protection
- [ ] `TRUSTED_PROXY_HOPS` verified against the real proxy chain
- [ ] `REDIS_URL` set in production, so bans are shared and survive a restart
      (with the memory cache each instance defends alone and forgets on deploy)
- [ ] `WAF_MODE=block` in production, confirmed via `/api/v1/admin/security`
- [ ] `THREAT_ALLOWLIST_IPS` contains health checkers and office egress
- [ ] Someone other than the author has run through this page end to end
- [ ] Railway and CDN support contacts written down somewhere reachable when
      the platform is down

---

## Where the controls live

| Control | File / setting |
|---|---|
| WAF rules and scope | `apps/api/src/waf.ts` |
| Adaptive scoring and bans | `apps/api/src/threat.ts` |
| Pipeline order | `handleRequest` in `apps/api/src/v1.ts` |
| Body size cap | `MAX_BODY_BYTES`, enforced in `readBoundedBody` (`packages/api-core`) |
| Operator view | `/admin#security` → Edge defence |
| Tests | `apps/api/src/waf.test.ts`, `apps/api/src/waf-live.test.ts` |
