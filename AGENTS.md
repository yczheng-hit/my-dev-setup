# Repository maintenance

For setup or updates, read `docs/maintenance.md`, then run `./bootstrap.sh` through the agent's shell tool. It validates temporarily and updates installed files directly, even while Pi is running. Keep the current session running; the user uses the new runtime on their next normal start. There is no candidate queue, startup hook or maintenance/version lock. Run maintenance sequentially.

At the start of a maintenance session, run `node scripts/maintain.mjs check` once. Inspection-only requests stay read-only.

`pi/settings.json` is the package list; `maintenance.json` classifies sources. Update ordinary remote packages to current releases. Repository-owned, adapter and patched packages use this checkout and pinned owner-tool commits; preserve local edits and do not merge or replace them from third-party upstream. Preserve Pi's original installer and Node prefix.

Preserve local `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and `externalEditor`. Existing machine permission files stay local and untouched; local agents handle any policy/schema changes explicitly. Never copy machine-specific rules into this repository.

Report installed versions, validation results and whether a new Pi start is needed. Do not claim the current process was hot-upgraded. Direct updates can affect lazy-loaded plugins/shared data in old sessions; do not reload automatically. Keep basic backups and custom-file ownership protection. Never commit credentials, sessions, machine-specific paths or downloaded dependencies. Commit/push only when requested. Search with ripgrep.
