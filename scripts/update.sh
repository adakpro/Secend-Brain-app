#!/usr/bin/env bash
# Update: backup first, rebuild pinned images, run migrations, restart. No volume is removed.
# Rollback: migrations are forward-only; to go back, check out the previous release AND restore the
# backup taken here (./scripts/restore.sh backups/<file>), because an older binary cannot read a newer schema.
source "$(dirname "$0")/lib.sh"
info "taking a backup before updating…"
./scripts/backup.sh
info "building…"
"${COMPOSE[@]}" build
info "applying migrations…"
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d
./scripts/doctor.sh || warn "doctor reported problems after update"
