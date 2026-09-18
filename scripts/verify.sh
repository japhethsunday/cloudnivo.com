#!/usr/bin/env bash
#
# Run what CI runs, in CI's order, against CI's environment.
#
# CI has gone red three times in a row on changes that passed "the tests" —
# because "the tests" meant a subset, run against a stack whose environment
# did not match the one CI boots. The failures were real every time:
#
#   - e2e locators that were unambiguous by luck, never run after a UI change
#   - a smoke step that ordered its assertions in a way a new throttle broke,
#     because the smoke was last run BEFORE that throttle existed
#
# Both would have been caught by running the whole gate once. So this script
# exists to make that a single command, and the environment differences that
# caused the misses are encoded here rather than remembered:
#
#   - the e2e harness raises rate-limit and threat budgets, because the suite
#     drives hostile traffic from one address (matches .github/workflows/ci.yml)
#   - the smoke API gets NO such exemption, because it is meant to prove
#     production-shaped behaviour, and runs on its own port
#   - the dashboard is rebuilt with the API origin the e2e run will use, since
#     NEXT_PUBLIC_API_URL is inlined at BUILD time; a stale build serves 400s
#     for its own chunks and every browser test fails for the wrong reason
#
# Usage:  bash scripts/verify.sh [--fast]
#           --fast  skip e2e and smoke (lint, typecheck, unit, build only)

set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

API_PORT_E2E=3001
SMOKE_PORT=3101
DASH_PORT=3000
FAILED=()

log()  { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }
pass() { printf '\033[32m  PASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[31m  FAIL\033[0m  %s\n' "$*"; FAILED+=("$1"); }

step() {
  local name="$1"; shift
  log "$name"
  if "$@"; then pass "$name"; else fail "$name"; fi
}

# Kill anything this script started, however it exits — a leftover server on
# 3000/3001 is the single most common cause of a confusing local run.
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid:-}" ]] && kill -9 "$pid" 2>/dev/null
  done
}
PIDS=()
trap cleanup EXIT

free_port() {
  local port="$1"
  for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    local cmd
    cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      *"apps/api/dist"*|*next-server*|*"next start"*) kill -9 "$p" 2>/dev/null ;;
    esac
  done
  sleep 2
}

wait_for() {
  local url="$1" tries="${2:-30}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ── Static gates (CI: validate) ──
step "lint"      npm run lint
step "typecheck" npm run typecheck
step "unit tests" npm test
step "build"     npm run build

if [[ $FAST -eq 1 ]]; then
  log "skipping e2e and smoke (--fast)"
else
  free_port "$API_PORT_E2E"

  # ── e2e (CI: e2e job) ──
  log "booting e2e stack"
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))") \
  DATABASE_URL=postgres://u:p@localhost:5432/db \
  CORS_ORIGINS=http://127.0.0.1:$DASH_PORT API_PORT=$API_PORT_E2E \
  PROVISION_DRIVER=fake CONTROL_STORE=memory CACHE_DRIVER=memory \
  AUTH_RATE_MAX=1000 RATE_LIMIT_MAX_REQUESTS=10000 \
  THREAT_THROTTLE_AT=10000 THREAT_BAN_AT=50000 \
  nohup node apps/api/dist/index.js > /tmp/cn-verify-api.log 2>&1 &
  PIDS+=($!)

  # Rebuilt here on purpose: NEXT_PUBLIC_API_URL is inlined at build time, so a
  # dashboard built against a different origin will fail every browser test
  # with a CSP error that looks nothing like the real cause.
  (cd apps/dashboard && NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT_E2E" npx next build) \
    > /tmp/cn-verify-dash-build.log 2>&1 || fail "dashboard build"

  (cd apps/dashboard && NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT_E2E" \
    nohup npx next start -p $DASH_PORT > /tmp/cn-verify-dash.log 2>&1 &)

  if wait_for "http://127.0.0.1:$API_PORT_E2E/api/v1/health/ready" && \
     wait_for "http://127.0.0.1:$DASH_PORT/"; then
    step "e2e" env API_URL="http://127.0.0.1:$API_PORT_E2E" \
      DASHBOARD_URL="http://127.0.0.1:$DASH_PORT" \
      npx playwright test --config tests/e2e/playwright.config.ts --reporter=line
  else
    fail "e2e stack never became ready"
  fi

  # ── Production smoke (CI: e2e job, separate API) ──
  # Deliberately WITHOUT the raised budgets above: this one proves the
  # behaviour production actually gets, including the adaptive throttle.
  log "booting smoke API"
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))") \
  PROVISION_DRIVER=fake CONTROL_STORE=memory CACHE_DRIVER=memory \
  DATABASE_URL=postgres://u:p@localhost:5432/db \
  CORS_ORIGINS=http://localhost:$DASH_PORT API_PORT=$SMOKE_PORT \
  nohup node apps/api/dist/index.js > /tmp/cn-verify-smoke.log 2>&1 &
  PIDS+=($!)

  if wait_for "http://127.0.0.1:$SMOKE_PORT/api/v1/health/ready"; then
    step "production smoke" env API_BASE="http://127.0.0.1:$SMOKE_PORT" node tests/smoke-prod.mjs
  else
    fail "smoke API never became ready"
  fi
fi

log "result"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  printf '\033[32mAll gates passed.\033[0m CI runs the same set — plus the docker job,\n'
  printf 'which needs a real Postgres and is not reproduced here.\n'
  exit 0
fi
printf '\033[31m%d gate(s) failed:\033[0m\n' "${#FAILED[@]}"
printf '  - %s\n' "${FAILED[@]}"
exit 1
