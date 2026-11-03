#!/usr/bin/env bash
# One explicit machine setup/update entry; safe preparation remains available inside Pi.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=apply
for arg in "$@"; do
  case "$arg" in
    --prepare) mode=prepare ;;
    --dry-run) mode=check ;;
    --check) mode=check ;;
    *) echo 'usage: ./bootstrap.sh [--prepare|--check|--dry-run]' >&2; exit 2 ;;
  esac
done
command -v node >/dev/null || { echo 'Install Node >=22.19/npm using your preferred Node manager first.' >&2; exit 1; }
case "$mode" in
  check) exec node "$REPO/scripts/maintain.mjs" check ;;
  prepare) exec node "$REPO/scripts/maintain.mjs" update ;;
  apply) exec node "$REPO/scripts/maintain.mjs" bootstrap --apply ;;
esac
