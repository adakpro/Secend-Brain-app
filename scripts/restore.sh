#!/usr/bin/env bash
# Restore a backup into THIS installation. Steps: validate (dry-run) -> show summary -> ask you to
# type the file name -> stop api/worker -> restore -> start. Current data is moved to .pre-restore-*.
source "$(dirname "$0")/lib.sh"
f="${1:-}"; [[ -n "$f" && -f "$f" ]] || die "usage: ./scripts/restore.sh backups/sb-backup-<stamp>.zip[.enc]"
name=$(basename "$f")
[[ "$name" =~ ^sb-backup-[0-9TZ-]+\.zip(\.enc)?$ ]] || die "unexpected file name: $name"
"${COMPOSE[@]}" up -d postgres api >/dev/null
"${COMPOSE[@]}" cp "$f" "api:/data/backups/$name"
pp=()
if [[ "$name" == *.enc ]]; then read -r -s -p "Backup passphrase: " P; echo; pp=(--passphrase-stdin); fi
run() { if [[ ${#pp[@]} -gt 0 ]]; then printf '%s\n' "$P" | "${COMPOSE[@]}" "$@"; else "${COMPOSE[@]}" "$@"; fi; }
info "validating (dry-run)…"
run exec -T api node dist/cli.js verify-backup --file "$name" "${pp[@]}" || die "backup failed validation; nothing was changed"
warn "Restoring replaces the database contents and moves current vault/source files to .pre-restore-*."
warn "All sessions end, schedules are paused, unfinished paid runs are NOT re-sent."
read -r -p "Type the file name to confirm ($name): " c
[[ "$c" == "$name" ]] || die "confirmation did not match; aborted"
"${COMPOSE[@]}" stop web worker api
run run --rm -T api node dist/cli.js restore --file "$name" --confirm "$name" "${pp[@]}"
"${COMPOSE[@]}" up -d
info "restore finished. Sign in again; re-enable schedules in Activity › Schedules after checking them."
