#!/usr/bin/env bash
# Consistent operational backup (DB snapshot + vault + raw sources) into the backup volume,
# then copied to ./backups on the host. Use --encrypt to protect it with a separate passphrase.
source "$(dirname "$0")/lib.sh"
mkdir -p backups && chmod 700 backups
args=(node dist/cli.js backup)
if [[ "${1:-}" == "--encrypt" ]]; then
  read -r -s -p "Backup passphrase (min 12 chars): " P; echo; read -r -s -p "Repeat: " P2; echo
  [[ "$P" == "$P2" && ${#P} -ge 12 ]] || die "passphrases differ or too short"
  out=$(printf '%s\n' "$P" | "${COMPOSE[@]}" exec -T api "${args[@]}" --passphrase-stdin)
else
  out=$("${COMPOSE[@]}" exec -T api "${args[@]}")
fi
echo "$out"
file=$(echo "$out" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')
[[ -n "$file" ]] || die "backup failed"
"${COMPOSE[@]}" cp "api:/data/backups/$file" "backups/$file"
chmod 600 "backups/$file"
info "backup copied to backups/$file — move it to another disk/host; keep secrets/master_key separately."
