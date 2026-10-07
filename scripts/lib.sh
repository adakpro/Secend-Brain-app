#!/usr/bin/env bash
# Shared helpers for operator scripts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f compose.yaml)
if [[ -f compose.production.yaml && ( "${SB_PRODUCTION:-}" == "1" || -f .env && -n "$(grep -E '^SB_PRODUCTION=1' .env)" ) ]]; then COMPOSE+=(-f compose.production.yaml); fi
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
