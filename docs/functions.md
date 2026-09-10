# CloudNivo Functions (Phase 7)

Serverless functions run project-scoped backend code in isolated runtimes.
Source deploys become immutable versions; invocation runs the active version's
`handler(request)` with an authenticated identity — never with control-plane
privileges, never across projects.

## Architecture

```text
Developer ──► Dashboard ──► Function API ──► FunctionService ──► Runtime ──► handler(request)
                                              (records, jobs,      (worker isolate
                                               versions, env,       or container,
                                               logs, metrics)       no host access)
```

Package map (`packages/functions/src`):

| Module          | Role                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `types.ts`      | Records, versions, jobs, env, invocation shapes, limits, metrics         |
| `validation.ts` | Allow-listed slugs/entrypoints/env keys, size caps                       |
| `sdk.ts`        | In-function `cloudnivo` SDK (identity + project + env, capability stubs) |
| `runtime.ts`    | `FunctionRuntime` + `NodeWorkerRuntime` + `DockerFunctionRuntime`        |
| `service.ts`    | `FunctionService` facade (CRUD, async deploys, invoke, logs, metrics)    |
| `openapi.ts`    | HTTP path fragments merged into `openapi.json`                           |

Control-plane tables (`functions`, `function_versions`, `function_env_vars`)
mirror the service shapes 1:1 as the durable target; v1 stores in memory.

## Function format

CommonJS single-file source exporting an async handler (default export name
`handler`, configurable dotted path such as `api.handler`):

```js
module.exports.handler = async req => {
  // req: { method, path, headers, query, body, auth }
  // auth: { userId, email, role } — resolved by CloudNivo, never forged
  // globals: cloudnivo (frozen SDK), env, console, timers
  return { status: 200, body: { hello: req.auth.userId ?? 'world' } };
};
```

Plain values are returned as `200`. `{ status, headers?, body? }` controls the
response. Top-level `await` is not supported in v1 (classic script). Runtimes:
`node22` today; `deno`/`python` plug into `FunctionRuntime` later.

## Lifecycle

`creating → building → deploying → ready` (invocations report `running` while
in flight), with `failed`, `stopped` (reserved for scale-to-zero), and
`deleting`. Deployments are async jobs (`pending → building → deploying →
ready | failed`); HTTP returns `202` immediately — poll the deployment, and
read actual state in the dashboard (nothing is simulated). Build verification
loads the real source in a throwaway isolate and proves the entrypoint export
exists without invoking the handler, so `ready` always means a verified
artifact. Identical source redeploys resolve to the existing version.

## Invocation

`POST /api/v1/projects/:id/functions/:slug/invoke` with a session JWT
(any member role), a `service`/`admin` project key, or a project customer JWT.
`Authorization`/`apikey`/`cookie`/`host` headers are stripped before the
handler sees the request; query is capped (64 entries); bodies are capped
(`FUNCTION_MAX_BODY_BYTES`). Responses are wrapped in the platform envelope
with `X-Function-Version` / `X-Execution-Ms` headers. Concurrency is capped
per function (`429` past the budget); invocation floods are rate-limited per
project over the shared store.

## Auth context and SDK

Handlers receive `{ userId, email, role }` plus `project.id` and function env
through the frozen `cloudnivo` object (`auth`, `project`, `env`, `database`,
`storage`, `realtime`). Service namespaces execute through a per-invocation
capability channel back to the control plane: `database.query` runs guarded
single-SELECT statements against the project's database (capped rows, short
timeout; non-admin customers are denied raw SQL and use RLS-shaped REST
instead), `storage.read` downloads one project-scoped object (bytes capped,
utf8/base64), and `realtime.publish` fans out to channels of the function's
own project (prefix-enforced both ends, counted in realtime metrics).
`storage.write` stays on the REST API. Signing secrets, connection strings,
and other projects' data are never visible inside the isolate.

## Environment variables

Per-function `KEY → value` pairs (`UPPER_SNAKE_CASE`), flagged secret or
plain. Secrets are masked in every API response (`••••`) and redacted from
every log line; platform-reserved keys (`DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, …) cannot be set. Values are capped
(`FUNCTION_MAX_ENV_VALUE_BYTES`).

## Limits (all environment-driven)

| Var                                  | Default   | Purpose                                          |
| ------------------------------------ | --------- | ------------------------------------------------ |
| `FUNCTION_RUNTIME`                   | `worker`  | `worker` isolates, `docker` containers           |
| `FUNCTION_EXECUTION_TIMEOUT_MS`      | `10000`   | Kill budget per invocation (504 past it)         |
| `FUNCTION_MEMORY_MB`                 | `128`     | Isolate heap cap / container `--memory`          |
| `FUNCTION_MAX_BODY_BYTES`            | `262144`  | Invocation body cap (413 past it)                |
| `FUNCTION_MAX_RESPONSE_BYTES`        | `1048576` | Response cap (502 past it)                       |
| `FUNCTION_MAX_CONCURRENCY`           | `10`      | In-flight cap per function (429 past it)         |
| `FUNCTION_MAX_DEPLOY_BYTES`          | `5242880` | Source cap (413 past it)                         |
| `FUNCTION_MAX_FUNCTIONS_PER_PROJECT` | `50`      | Functions per project                            |
| `FUNCTION_MAX_ENV_VALUE_BYTES`       | `8192`    | Env value cap                                    |
| `FUNCTION_MAX_LOG_ENTRIES`           | `500`     | Log retention per function                       |
| `FUNCTION_LOG_RETENTION_DAYS`        | `7`       | Log age cutoff                                   |
| `FUNCTION_INVOKE_RATE_MAX`           | `60`      | Invocations/min per project+function             |
| `FUNCTION_BASE_URL`                  | ``        | Public functions base URL (no hardcoded domains) |

## Sandboxing

Worker isolates run customer code in a `vm` context with no
`require`/`process`/`fetch`/`WebSocket`/sockets — only the SDK, env, capturing
console, and timers. Timeouts terminate the isolate; heaps are capped; console
output is captured (200 lines, 4 KB each) and secret-redacted. Containers
(`docker` runtime) bake source into an image (no host mounts) and run with
`--network none --cap-drop ALL --read-only --pids-limit 64` plus memory caps.
Both runtimes share the entrypoint-deny list (`__proto__`/`constructor`/
`prototype` segments rejected).

## Observability

Per-function logs (`level`, `message`, `requestId`, `version`, timing, status)
with bounded retention, plus metrics: invocations, successes, failures,
timeouts, rate-limited, total/max duration, cold starts, deploy failures.
`cold_start` is true for the first execution of a version. Nothing sensitive
is ever logged.

## Testing

Unit + HTTP E2E run everywhere (`npm test`): validation, sandbox denials,
timeouts, lifecycle, versions, isolation, rate limits, SDK capabilities with
denials. Live infrastructure is gated and skips cleanly without it:

| Suite                                  | Gate                                     | Covers                                                   |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `realtime-cdc.live.test.ts` (database) | `LIVE_PG_URL`                            | trigger DDL + INSERT/UPDATE/DELETE NOTIFY payloads       |
| `bus.live.test.ts` (realtime)          | `LIVE_REDIS_URL`                         | cross-instance fan-out, presence union                   |
| `runtime.docker.test.ts` (functions)   | `DOCKER_TESTS=1`                         | container build + isolated execution                     |
| `realtime-cdc.live.test.ts` (api)      | `DOCKER_TESTS=1`                         | provision → subscribe → DML → WS events                  |
| `tests/e2e` (Playwright)               | running stack + `npx playwright install` | signup → org → project → CRUD → upload → 403 + dashboard |

## Local development

```bash
cp .env.example .env
npm run dev:api   # functions ride the API; FUNCTION_RUNTIME=worker default
```

Create a function in the dashboard (`/projects/:id/functions`), deploy source,
poll the deployment to `ready`, invoke, inspect logs. Container runtime needs
a Docker engine (`FUNCTION_RUNTIME=docker`, `DOCKER_TESTS=1` for gated tests).

## Railway

Same image serves functions in-process; for independent scaling run a worker
service with `FUNCTION_RUNTIME`, `DATABASE_URL`, `REDIS_URL`, and the
`FUNCTION_*` budgets set. No localhost/filesystem/single-memory dependence in
runtime paths.
