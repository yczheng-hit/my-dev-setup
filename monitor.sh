#!/usr/bin/env bash
# Run in an existing herdr pane. Observation only unless explicitly enabled.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -x "$REPO/tools/herdr-monitor/run-monitor.sh" ]; then
  printf 'Run %s/setup.sh to install herdr-monitor first.\n' "$REPO" >&2
  exit 1
fi
exec "$REPO/tools/herdr-monitor/run-monitor.sh" "$@"
