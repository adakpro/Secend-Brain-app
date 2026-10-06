#!/usr/bin/env bash
# Read-only diagnostics. Prints service state, health, versions and common misconfigurations.
source "$(dirname "$0")/lib.sh"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$1"; else printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; fi; }
info "environment"
check "docker reachable" "docker info"
check "compose config valid" "${COMPOSE[*]} config -q"
check "secrets dir is 0700" "[[ \$(stat -c %a secrets) == 700 ]]"
for s in db_password master_key internal_token; do check "secret $s present" "[[ -s secrets/$s ]]"; done
check ".env present" "[[ -f .env ]]"
info "services"
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'
check "web published only on loopback (default)" "! ${COMPOSE[*]} ps --format '{{.Ports}}' | grep -q '0.0.0.0'"
check "api ready" "${COMPOSE[*]} exec -T api node -e \"fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
check "postgres has no published port" "! ${COMPOSE[*]} port postgres 5432"
check "runner has no internet route (internal network)" "! ${COMPOSE[*]} exec -T agent-runner node -e \"fetch('https://api.anthropic.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))\""
info "system status (no secrets)"
"${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/api/v1/system/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({readiness:j.readiness,capabilities:j.capabilities,profile:j.profile,version:j.version},null,1)))" || true
[[ $fail == 0 ]] && info "doctor: all checks passed" || { warn "doctor: some checks failed"; exit 1; }
