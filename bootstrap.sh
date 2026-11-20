#!/usr/bin/env bash
# Validate and update installed files directly; the current Pi is not restarted.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=apply
extra_args=()
for arg in "$@"; do
  case "$arg" in
    --prepare) mode=prepare ;;
    --dry-run) mode=check ;;
    --check) mode=check ;;
    --clean-backups|--prune-backups) extra_args+=(--clean-backups) ;;
    *) echo 'usage: ./bootstrap.sh [--prepare|--check|--dry-run] [--clean-backups]' >&2; exit 2 ;;
  esac
done
command -v node >/dev/null || { echo 'Install Node >=22.19/npm using your preferred Node manager first.' >&2; exit 1; }
case "$mode" in
  check) exec node "$REPO/scripts/maintain.mjs" check ${extra_args[@]+"${extra_args[@]}"} ;;
  prepare) exec node "$REPO/scripts/maintain.mjs" update ${extra_args[@]+"${extra_args[@]}"} ;;
  apply) exec node "$REPO/scripts/maintain.mjs" bootstrap --apply ${extra_args[@]+"${extra_args[@]}"} ;;
esac
