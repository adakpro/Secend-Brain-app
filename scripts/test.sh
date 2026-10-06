#!/usr/bin/env bash
# Runs the automated checks and writes logs under evidence/tests/. Exit code is non-zero on any failure.
#   ./scripts/test.sh          lint+typecheck, unit, integration (disposable PostgreSQL), web build, compose config, audit
#   ./scripts/test.sh e2e      Playwright against the test stack (compose.test.yaml, mock provider) on 127.0.0.1:8081
source "$(dirname "$0")/lib.sh"
mkdir -p evidence/tests
step() { local name=$1; shift; info "$name"; if "$@" > "evidence/tests/$name.log" 2>&1; then echo "  passed"; else echo "  FAILED (see evidence/tests/$name.log)"; FAILED=1; fi; }
FAILED=0
if [[ "${1:-}" == "e2e" ]]; then
  [[ -n "${E2E_EMAIL:-}" && -n "${E2E_PASSWORD:-}" ]] || die "set E2E_EMAIL and E2E_PASSWORD for the test stack owner"
  step e2e npx playwright test
  exit $FAILED
fi
command -v pnpm >/dev/null || die "pnpm (corepack) required for host tests"
PGC=sb-test-pg
if ! docker ps --format '{{.Names}}' | grep -q "^$PGC$"; then
  info "starting disposable PostgreSQL ($PGC on 127.0.0.1:55499, tmpfs)"
  docker run -d --rm --name $PGC -e POSTGRES_PASSWORD=sbtest -e POSTGRES_USER=sbtest -e POSTGRES_DB=sbtest -p 127.0.0.1:55499:5432 --tmpfs /var/lib/postgresql/data:rw,size=1g postgres:17.6-bookworm >/dev/null
  until docker exec $PGC pg_isready -U sbtest >/dev/null 2>&1; do sleep 1; done; sleep 2
fi
step install pnpm install --frozen-lockfile
step lint node scripts/lint.mjs
step typecheck pnpm -r run typecheck
step unit npx vitest run --project unit
step integration npx vitest run --project integration
step build-web pnpm --filter @sb/web run build
step build-node pnpm --filter @sb/api --filter @sb/worker --filter @sb/agent-runner run build
step compose-config docker compose -f compose.yaml config -q
step audit pnpm audit --prod --audit-level high
exit $FAILED
