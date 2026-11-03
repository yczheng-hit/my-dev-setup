# Repository bootstrap and maintenance

When given this repository URL to set up or refresh a machine, read `docs/maintenance.md`, then run `./bootstrap.sh`. The command checks the latest stable Pi and remote plugins, validates a candidate composition, and configures the machine only when no Pi process is running. If Pi is running, run `./bootstrap.sh --prepare` and report the external-terminal activation command; keep the current session running.

At the start of each new maintenance session in this repository, run `node scripts/maintain.mjs check` once. Follow the user's requested scope: inspection-only requests stay read-only; setup/update requests use bootstrap without asking again for routine downloads, validation and configuration.

`maintenance.json` classifies packages. Remote npm/git entries track current releases. Repository-owned, adapter and patched packages use this checkout and its pinned owner-tool commits: do not query, merge, rebase or replace them from the original third-party upstream. Preserve working-tree edits. Pi upgrades preserve the detected original installer and Node prefix; an unsupported installation is a blocker, not permission to install a second Pi.

Report separately: latest discovered, candidate validated, installed, and restart required. Factory loading does not prove live provider/auth/UI correctness. Never commit credentials, sessions, machine-specific paths or downloaded dependencies. Commit/push only when requested. Search with ripgrep (`grep` tool or `rg`).
