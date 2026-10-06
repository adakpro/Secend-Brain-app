#!/usr/bin/env bash
# First-time setup: checks Docker/Compose, creates secrets ONLY if missing, builds and starts.
# Never overwrites existing secrets or .env. Safe to run again.
source "$(dirname "$0")/lib.sh"

command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not found"
CV=$(docker compose version --short 2>/dev/null || echo 0)
info "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), Compose $CV"
case "$CV" in 1.*|2.0*|2.1*) die "Compose >= 2.20 required (found $CV)";; esac

if [[ ! -f .env ]]; then cp .env.example .env; info "created .env from .env.example (edit APP_ORIGIN for non-local use)"; else info ".env exists; leaving it unchanged"; fi

umask 077
mkdir -p secrets && chmod 700 secrets
gen() { # name bytes encoding
  local f="secrets/$1"
  if [[ -s "$f" ]]; then info "secret $1 exists; not touching it"; return; fi
  if [[ "$3" == hex ]]; then openssl rand -hex "$2" > "$f" 2>/dev/null || head -c "$2" /dev/urandom | od -An -tx1 | tr -d ' \n' > "$f"
  else openssl rand -base64 "$2" > "$f" 2>/dev/null || head -c "$2" /dev/urandom | base64 > "$f"; fi
  chmod 444 "$f"; info "created secret $1"
}
gen db_password 32 hex
gen master_key 32 b64
gen internal_token 32 hex
warn "Back up secrets/master_key OUTSIDE this machine now. Without it, stored API keys and 2FA secrets cannot be decrypted after a restore."

info "building images (this takes a few minutes the first time)…"
"${COMPOSE[@]}" build
info "starting services…"
"${COMPOSE[@]}" up -d
for i in $(seq 1 60); do
  s=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="api"{print $2}')
  [[ "$s" == "healthy" ]] && break; sleep 2
done
"${COMPOSE[@]}" ps
source .env
info "Open ${APP_ORIGIN:-http://127.0.0.1:8080}. Next: ./scripts/create-admin.sh"
