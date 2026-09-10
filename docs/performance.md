# CloudNivo performance (Phase 10)

Measured on developer hardware (fake provider, memory cache, local planner).
Budgets in `tests/load/budgets.ts` assert "no collapse", not production SLOs.
Run: `npm run test:load [-- --scenario=...]`. Results: `tests/load/results.json`.

## Load results (reference run)

| Scenario                   | Concurrency | p50    | p95        | Throughput  | Errors       |
| -------------------------- | ----------- | ------ | ---------- | ----------- | ------------ |
| api.health                 | 50→100      | ~50ms  | ~110→170ms | ~800→1400/s | 0            |
| api.crud (keys)            | 10          | ~25ms  | ~35ms      | ~360/s      | 0            |
| auth.session (scrypt)      | 5           | ~130ms | ~200ms     | ~35/s       | 0            |
| data.read                  | 20          | ~30ms  | ~55ms      | ~590/s      | 0            |
| storage.roundtrip (1KB)    | 5           | ~50ms  | ~100ms     | ~90/s       | 0            |
| realtime.fanout (WS pairs) | 10          | ~45ms  | ~55ms      | ~215/s      | 0            |
| functions.invoke (worker)  | 5           | ~135ms | ~165ms     | ~35/s       | 0            |
| ai.plan (local)            | 4           | ~15ms  | ~35ms      | ~175–235/s  | 0            |
| abuse mix (4xx expected)   | 20          | —      | ~30ms      | —           | 0 unexpected |

Scrypt dominates auth latency by design (brute-force resistance). Function
invokes pay worker-isolate startup (~130ms) — isolation is not sacrificed for
speed. AI plans are CPU-trivial locally; frontier-model latency is provider
time, bounded by `AI_REQUEST_TIMEOUT_MS`.

## Bottlenecks fixed

- **N+1 registry reads** on `GET /projects`: replaced 2N lookups with one
  batched `listProjectDatabases` (memory: map pass; drizzle: 2 `IN` queries).
  Live Docker status checks stay per-project (parallel, fail-open).
- **Rate-budget contention in tests**: load runs raise `RATE_LIMIT_*` budgets
  explicitly; 429 behavior stays covered by unit tests, never by load runs.

## Database

Single-statement guarded executor with statement timeouts and row caps; no
arbitrary joins from user input (allow-listed identifiers, `$n` binds only).
Control-plane lists use `IN` batches; per-row follow-ups were removed from the
hot path. No index changes were justified at current scale — drizzle
migrations own schema, and no slow query was observed.

## Redis

Memory-first locally; Redis backs rate limits, pub/sub, and cache in prod.
Keys carry TTLs via the cache abstraction; pub/sub channels are bounded per
project; no unbounded growth vectors found (presence TTLs, capped logs,
bounded job records).

## Realtime / functions under load

40 WS pairs with cross-delivery at 0 errors; 20 concurrent invokes at 0
errors; runaway handlers terminate at `FUNCTION_TIMEOUT_MS` (504 verified
under load). No connection leaks observed (sockets tracked per gateway with
heartbeat sweeps).

## Known limitations

- Fake-provider numbers are throughput ceilings, not production promises.
- Docker-provisioning races at 10/50/100 projects were not exercised here
  (no engine in this environment); jobs are idempotent by key and safe to
  retry — run `DOCKER_TESTS=1` suites where Docker exists.
- No automated backup verification yet — see `docs/operations.md`.
