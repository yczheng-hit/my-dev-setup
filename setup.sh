#!/usr/bin/env bash
# Deploy this repo's herdr + pi configuration to the current machine.
# Safe to re-run: unchanged files are skipped, changed ones are backed up first.
#
#   ./setup.sh               apply
#   ./setup.sh --dry-run     show what would change, touch nothing
#   ./setup.sh --no-rebuild  report a native addon that cannot load, but do not compile it locally
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
HERDR_DIR="$HOME/.config/herdr"
BACKUP_DIR="$HOME/.my-dev-setup-backups/$(date +%Y%m%d-%H%M%S)"
DRY_RUN=0
NO_REBUILD=0
problems=0   # anything that leaves a plugin broken: reported at the end, exit status 1

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --no-rebuild) NO_REBUILD=1 ;;
    *) echo "usage: $0 [--dry-run] [--no-rebuild]" >&2; exit 2 ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = 1 ]; then log "[dry-run] $*"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }


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
# Validate every config/host mutation before clone/install or destination writes.
# This command only builds an in-memory plan; unknown host layouts/custom legacy rules fail closed.
PI_HOST_DIR="${PI_HOST_DIR:-$(node --input-type=module -e 'const {findHost}=await import(process.argv[2]); console.log(findHost())' setup-host "$REPO/scripts/agents-only.mjs")}"
export PI_HOST_DIR
hashline_dir="${PI_HASHLINE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/pi-hashline-edit-pro}"
deploy_args=(--repo "$REPO" --agent-dir "$PI_DIR" --home "$HOME" --herdr-dir "$HERDR_DIR" --hashline-dir "$hashline_dir" --host "$PI_HOST_DIR")
node "$REPO/scripts/managed-deploy.mjs" "${deploy_args[@]}" --check

# ---------------------------------------------------------------- tool repos
# Own tools live in their own GitHub repos (tools.tsv) and are cloned into
# ./tools/<name>, tracking the listed branch. Local edits are never overwritten.
# herdr-monitor is also a git submodule (so its code is browsable from this repo);
# an uninitialised submodule is an empty directory and is cloned the same way.
step "Tool repositories"
while IFS=$'\t' read -r name url branch; do
  case "$name" in ''|'#'*) continue ;; esac
  dir="$REPO/tools/$name"
  # A submodule checkout has a .git file and a detached HEAD: move it onto the branch.
  if [ -f "$dir/.git" ] && [ -z "$(git -C "$dir" status --porcelain)" ] \
     && ! git -C "$dir" symbolic-ref -q HEAD >/dev/null; then
    run git -C "$dir" checkout --quiet "$branch"
  fi
  if [ ! -e "$dir/.git" ]; then
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

# check_native_deps <pkg-dir> <name>: load each native addon dependency for real. Installing with
# --ignore-scripts only proves the files exist; a prebuilt binary that needs a newer libstdc++ (or
# another Node ABI) fails at load time and takes the whole plugin down while `pi list` still shows
# it. A failing addon is rebuilt from source on its own - install scripts stay off for everything
# else - and checked again.
check_native_deps() {
  local pkg="$1" name="$2" out status dep kind msg loaded
  [ -d "$pkg/node_modules" ] || return 0
  out="$(node "$REPO/scripts/native-deps.mjs" "$pkg" 2>&1 || true)"
  while IFS=$'\t' read -r status dep kind msg; do
    [ "$status" = fail ] || continue
    warn "$name: native module '$dep' cannot be loaded ($kind)"
    warn "  $msg"
    case "$kind" in
      libstdcxx) warn "  the prebuilt binary needs a newer libstdc++ than this system provides" ;;
      node-abi)  warn "  the binary was built for a different Node version than $(node -v)" ;;
      no-binary) warn "  no usable prebuilt binary for $(uname -s)/$(uname -m)" ;;
    esac
    case "$kind" in
      libstdcxx|node-abi|no-binary)
        if [ "$NO_REBUILD" = 1 ]; then
          warn "  skipped local rebuild (--no-rebuild)"
        elif [ ! -f "$pkg/node_modules/$dep/binding.gyp" ]; then
          warn "  $dep ships no sources to rebuild from"
        else
          local rebuild_args=()
          [ "$DRY_RUN" = 1 ] && rebuild_args+=(--dry-run)
          if node "$REPO/scripts/rebuild-native.mjs" ${rebuild_args[@]+"${rebuild_args[@]}"} "$pkg" "$dep"; then
            [ "$DRY_RUN" = 1 ] && continue
            if node "$REPO/scripts/native-deps.mjs" "$pkg" "$dep" >/dev/null 2>&1; then
              log "rebuilt    $dep for $name, loads now"
              continue
            fi
            warn "  rebuilt $dep, but it still does not load"
          fi
        fi
        ;;
    esac
    problems=$((problems + 1))
    case "$kind" in
      libstdcxx|node-abi|no-binary)
        warn "  fix by hand: install g++ >= 10 and Python >= 3.8 (or set CC/CXX/PYTHON), then"
        warn "    node $REPO/scripts/rebuild-native.mjs $pkg $dep" ;;
      *) warn "  fix by hand: rm -rf $pkg/node_modules && ./setup.sh" ;;
    esac
  done <<< "$out"
  loaded="$(grep -c '^ok' <<< "$out" || true)"
  if [ "$loaded" != 0 ] && ! grep -q '^fail' <<< "$out"; then
    log "native ok  $name ($loaded addon(s) load)"
  fi
}

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
  check_native_deps "$pkg" "$name"
done

if [ "$problems" != 0 ]; then
  warn "native dependency checks failed; configuration has not been applied."
  exit 1
fi

# ---------------------------------------------------------------- extension load check
# Load repo + installed npm/git + standalone extensions together, preserving filters.
# No model/session startup, network, child processes, or writes outside a disposable directory.
step "pi extension load check"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] skipped (dependencies may not be installed yet)"
else
  ext_status=0
  ext_out="$(node "$REPO/scripts/check-pi-extensions.mjs" "$REPO" --agent-dir "$PI_DIR" 2>&1)" || ext_status=$?
  while IFS=$'\t' read -r kind pkg_name detail; do
    case "$kind" in
      ok)      log "loads      $pkg_name ($detail)" ;;
      skip)    log "skipped    $pkg_name: $detail" ;;
      fail)    warn "$pkg_name fails to load: $detail" ;;
      summary) log "result     $pkg_name" ;;
      *)       [ -z "$kind" ] || warn "$kind $pkg_name $detail" ;;
    esac
  done <<< "$ext_out"
  case "$ext_status" in
    0) ;;
    2) problems=$((problems + 1))
       warn "composition incomplete: missing npm/git packages must be installed by Pi, then re-run the checker." ;;
    *) warn "extension preflight failed; configuration has not been applied."; exit 1 ;;
  esac
fi
# Recompute/validate the plan after repository updates, then apply one backed-up transaction.
step "Managed pi + herdr configuration"
if [ "$DRY_RUN" = 1 ]; then
  node "$REPO/scripts/managed-deploy.mjs" "${deploy_args[@]}" --dry-run
else
  node "$REPO/scripts/managed-deploy.mjs" "${deploy_args[@]}" --apply --backup "$BACKUP_DIR"
  herdr config check || warn "herdr config check reported problems"
fi
# Official pi <-> herdr integration (writes ~/.pi/agent/extensions/herdr-agent-state.ts).
if [ "$PI_DIR" != "$HOME/.pi/agent" ]; then
  warn "custom PI_CODING_AGENT_DIR: official Herdr integration is managed separately; not installing into the default agent directory."
else
  integration_status="$(herdr integration status 2>&1 || true)"
  if printf '%s\n' "$integration_status" | grep -q '^pi: current'; then
    log "unchanged  herdr integration: pi"
  else
    run herdr integration install pi
    [ "$DRY_RUN" = 1 ] || log "installed  herdr integration: pi"
  fi
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
  elif [ "$linked_root" = "$root" ] || { [ -d "$linked_root" ] && [ "$(cd "$linked_root" && pwd -P)" = "$(cd "$root" && pwd -P)" ]; }; then
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

# ---------------------------------------------------------------- version floors
# Unpatched npm plugins with a known-bad old version: warn, never auto-update.
# pi-hashline-edit-pro < 6.5.0 can stall the pi main thread for minutes when a
# long session nearly exhausts its anchor pool (fixed upstream in 6.5.0).
step "npm version floors"
hl_pkg="$PI_DIR/npm/node_modules/pi-hashline-edit-pro/package.json"
if [ -f "$hl_pkg" ]; then
  hl_ver="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$hl_pkg" | head -n 1)"
  if [ "$(printf '%s\n%s\n' 6.5.0 "$hl_ver" | sort -V | head -n 1)" = 6.5.0 ]; then
    log "ok  pi-hashline-edit-pro $hl_ver (>= 6.5.0)"
  else
    warn "pi-hashline-edit-pro $hl_ver < 6.5.0 (anchor-pool stall); run: pi update --extension npm:pi-hashline-edit-pro"
  fi
else
  log "pi-hashline-edit-pro not installed yet; pi installs the latest on next start."
fi

# ---------------------------------------------------------------- done
step "Done"
if [ "$DRY_RUN" = 0 ] && [ -d "$BACKUP_DIR" ]; then
  log "previous files backed up to ${BACKUP_DIR/#$HOME/~}"
fi
if [ "$problems" != 0 ]; then
  warn "$problems problem(s) above: configuration was applied, but some plugins will not load."
fi
log "npm: packages are installed by pi on its next start."
log "running pi sessions: restart Pi after host/AGENTS-only patches; /reload only reloads extensions/resources."
log "local package sources can already be active before setup; setup synchronizes managed configuration."
log "herdr-monitor: run ./monitor.sh inside a herdr pane."
[ "$problems" = 0 ] || exit 1
