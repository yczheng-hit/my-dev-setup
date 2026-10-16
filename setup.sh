#!/usr/bin/env bash
# Deploy this repo's herdr + pi configuration to the current machine.
# Safe to re-run: unchanged files are skipped, changed ones are backed up first.
#
#   ./setup.sh            apply
#   ./setup.sh --dry-run  show what would change, touch nothing
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
HERDR_DIR="$HOME/.config/herdr"
BACKUP_DIR="$HOME/.my-dev-setup-backups/$(date +%Y%m%d-%H%M%S)"
DRY_RUN=0

case "${1:-}" in
  --dry-run|-n) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

log()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = 1 ]; then log "[dry-run] $*"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

backup() {
  local target="$1"
  [ -e "$target" ] || return 0
  local dest="$BACKUP_DIR${target#"$HOME"}"
  mkdir -p "$(dirname "$dest")"
  cp -p "$target" "$dest"
}

# install_file <src> <dst>: copy only when content differs, backing up the old file.
install_file() {
  local src="$1" dst="$2" label
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    log "unchanged  ${dst/#$HOME/~}"
    return 0
  fi
  label="$([ -e "$dst" ] && echo updated || echo created)"
  if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] $label ${dst/#$HOME/~}"
    return 0
  fi
  backup "$dst"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  log "$label    ${dst/#$HOME/~}"
}

# ---------------------------------------------------------------- preflight
step "Preflight"
missing=0
for cmd in git node npm pi herdr; do
  if have "$cmd"; then log "found      $cmd"; else warn "missing    $cmd"; missing=1; fi
done
if [ "$missing" = 1 ]; then
  warn "install the missing tools first (see README.md), then re-run."
  exit 1
fi
log "repo       $REPO"
log "pi dir     ${PI_DIR/#$HOME/~}"
log "herdr dir  ${HERDR_DIR/#$HOME/~}"

# ---------------------------------------------------------------- tool repos
# Own tools live in their own GitHub repos (tools.tsv) and are cloned into
# ./tools/<name>, tracking the listed branch. Local edits are never overwritten.
step "Tool repositories"
while IFS=$'\t' read -r name url branch; do
  case "$name" in ''|'#'*) continue ;; esac
  dir="$REPO/tools/$name"
  if [ ! -d "$dir/.git" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      log "[dry-run] git clone $url"
    else
      mkdir -p "$REPO/tools"
      git clone --quiet --branch "$branch" "$url" "$dir"
      log "cloned     $name ($(git -C "$dir" rev-parse --short HEAD))"
    fi
    continue
  fi
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    warn "$name has local changes; not updated"
  elif [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" != "$branch" ]; then
    warn "$name is not on $branch; not updated"
  elif [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] git pull $name"
  elif ! git -C "$dir" pull --quiet --ff-only; then
    warn "$name: git pull failed; keeping $(git -C "$dir" rev-parse --short HEAD)"
  else
    log "up to date $name ($(git -C "$dir" rev-parse --short HEAD))"
  fi
done < "$REPO/tools.tsv"

# ---------------------------------------------------------------- local packages
# pi loads local-path packages as-is and never installs their dependencies,
# so install runtime deps here. Host packages (pi-ai, pi-tui, ...) come from pi.
step "Local pi packages"
for pkg in "$REPO"/packages/*/ "$REPO"/tools/*/; do
  pkg="${pkg%/}"
  [ -f "$pkg/package.json" ] || continue
  name="$(basename "$pkg")"
  needs_install="$(node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    const deps = Object.keys(require(path.join(dir, "package.json")).dependencies || {});
    console.log(deps.some(d => !fs.existsSync(path.join(dir, "node_modules", d))) ? 1 : 0);
  ' "$pkg")"
  if [ "$needs_install" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      log "[dry-run] npm install $name"
    else
      (cd "$pkg" && npm install --omit=dev --legacy-peer-deps --no-package-lock \
        --ignore-scripts --no-audit --no-fund --loglevel=error)
      log "installed  deps for $name"
    fi
  else
    log "deps ok    $name"
  fi
done

# ---------------------------------------------------------------- pi
step "pi configuration"

# settings.json: keys in the repo win; keys only on this machine (deviceId,
# lastChangelogVersion, ...) are kept. "repo:<path>" package entries become
# absolute paths into this checkout.
settings_tmp="$(mktemp)"
herdr_tmp=""
trap 'rm -f "$settings_tmp"; if [ -n "$herdr_tmp" ]; then rm -f "$herdr_tmp"; fi' EXIT
node -e '
  const fs = require("fs"), path = require("path");
  const [repo, src, dst, out] = process.argv.slice(1);
  const desired = JSON.parse(fs.readFileSync(src, "utf8"));
  const current = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, "utf8")) : {};
  desired.packages = (desired.packages || []).map(p =>
    typeof p === "string" && p.startsWith("repo:") ? path.join(repo, p.slice(5)) : p);
  fs.writeFileSync(out, JSON.stringify({ ...current, ...desired }, null, 2) + "\n");
' "$REPO" "$REPO/pi/settings.json" "$PI_DIR/settings.json" "$settings_tmp"
install_file "$settings_tmp" "$PI_DIR/settings.json"

for f in keybindings.json pi-cc-extensions.json WATCHDOG.yml; do
  install_file "$REPO/pi/$f" "$PI_DIR/$f"
done
for theme in "$REPO"/pi/themes/*.json; do
  [ -f "$theme" ] || continue
  install_file "$theme" "$PI_DIR/themes/$(basename "$theme")"
done
install_file "$REPO/pi/permissions.json" "$(dirname "$PI_DIR")/permissions.json"

# Extensions and per-extension config files, mirrored into $PI_DIR/extensions.
(cd "$REPO/pi/extensions" && find . -type f) | sort | while read -r rel; do
  install_file "$REPO/pi/extensions/${rel#./}" "$PI_DIR/extensions/${rel#./}"
done

# ---------------------------------------------------------------- herdr
step "herdr configuration"
herdr_src="$REPO/herdr/config.toml"
if [ ! -x /bin/zsh ]; then
  if [ -x /bin/bash ]; then
    herdr_tmp="$(mktemp)"
    sed 's|^default_shell = "/bin/zsh"$|default_shell = "/bin/bash"|' "$herdr_src" > "$herdr_tmp"
    herdr_src="$herdr_tmp"
    log "shell      /bin/zsh unavailable; using /bin/bash"
  else
    warn "neither /bin/zsh nor /bin/bash is available; herdr config not applied"
    herdr_src=""
  fi
fi
if [ -n "$herdr_src" ]; then
  install_file "$herdr_src" "$HERDR_DIR/config.toml"
fi
if [ "$DRY_RUN" = 0 ] && [ -n "$herdr_src" ]; then
  herdr config check || warn "herdr config check reported problems"
fi

# Official pi <-> herdr integration (writes ~/.pi/agent/extensions/herdr-agent-state.ts).
integration_status="$(herdr integration status 2>&1 || true)"
if printf '%s\n' "$integration_status" | grep -q '^pi: current'; then
  log "unchanged  herdr integration: pi"
else
  run herdr integration install pi
  [ "$DRY_RUN" = 1 ] || log "installed  herdr integration: pi"
fi

# herdr plugins: any package or tool repo containing herdr-plugin.toml.
for manifest in "$REPO"/packages/*/herdr-plugin.toml "$REPO"/tools/*/herdr-plugin.toml; do
  [ -f "$manifest" ] || continue
  root="$(dirname "$manifest")"
  id="$(sed -n 's/^id *= *"\(.*\)"/\1/p' "$manifest" | head -1)"
  linked_root="$(herdr plugin list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const p = JSON.parse(s).result.plugins.find(p => p.plugin_id === process.argv[1]);
        console.log(p ? p.plugin_root : "");
      } catch { console.log(""); }
    });
  ' "$id" || true)"
  if [ -z "$linked_root" ]; then
    run herdr plugin link "$root"
    [ "$DRY_RUN" = 1 ] || log "linked     herdr plugin $id"
  elif [ "$linked_root" = "$root" ]; then
    log "unchanged  herdr plugin $id"
  else
    warn "herdr plugin $id is linked to $linked_root, not this repo; left as is."
    warn "to switch: herdr plugin unlink $id && ./setup.sh"
  fi
done

if [ "$DRY_RUN" = 0 ]; then
  herdr server reload-config >/dev/null 2>&1 && log "reloaded   herdr server config" || true
fi

# ---------------------------------------------------------------- herdr-monitor
# Python >=3.11 in a venv inside the clone; reinstalled when the commit changes.
# Only installed here; it runs when you start ./monitor.sh in a herdr pane.
step "herdr-monitor"
monitor="$REPO/tools/herdr-monitor"
if [ ! -f "$monitor/pyproject.toml" ]; then
  log "skipped    (not cloned yet)"
else
  python=""
  for cand in python3.13 python3.12 python3.11 python3; do
    if have "$cand" && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      python="$(command -v "$cand")"; break
    fi
  done
  commit="$(git -C "$monitor" rev-parse HEAD)"
  stamp="$monitor/.venv/.my-dev-setup-commit"
  if [ -z "$python" ]; then
    warn "Python >=3.11 not found; herdr-monitor not installed"
  elif [ -x "$monitor/.venv/bin/herdr-monitor" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$commit" ]; then
    log "unchanged  herdr-monitor (${commit:0:7})"
  elif [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] install herdr-monitor with $python"
  else
    [ -d "$monitor/.venv" ] || "$python" -m venv "$monitor/.venv"
    "$monitor/.venv/bin/python" -m pip install --quiet --disable-pip-version-check "$monitor"
    echo "$commit" > "$stamp"
    log "installed  herdr-monitor (${commit:0:7}, $("$monitor/.venv/bin/python" -V))"
  fi
fi

# ---------------------------------------------------------------- done
step "Done"
if [ "$DRY_RUN" = 0 ] && [ -d "$BACKUP_DIR" ]; then
  log "previous files backed up to ${BACKUP_DIR/#$HOME/~}"
fi
log "npm: packages are installed by pi on its next start."
log "running pi sessions: run /reload to pick up changes."
log "herdr-monitor: run ./monitor.sh inside a herdr pane."
