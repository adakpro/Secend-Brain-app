#!/usr/bin/env bash
# Interactive creation of the first owner account (there is no default account).
# The password is typed into the container's TTY with echo off; it never appears in argv or logs.
source "$(dirname "$0")/lib.sh"
if [[ "${1:-}" == "--reset-password" ]]; then
  exec "${COMPOSE[@]}" exec api node dist/cli.js reset-password ${2:+--email "$2"}
fi
exec "${COMPOSE[@]}" exec api node dist/cli.js create-admin
