# pi-agents-context

Shared AGENTS-only policy for ordinary prompts and the permission reviewer. Configuration/runtime state remains in `.pi`; instruction resources use:

```text
<agentDir>/AGENTS.md                  # normally ~/.pi/agent/AGENTS.md
~/.agents/rules/**/*.md              # user rules
project/AGENTS.md                    # native ancestor instruction file
project/.agents/rules/**/*.md        # trusted project rules
~/.agents/skills/                    # Pi native skills discovery
project/.agents/skills/              # Pi native trusted resources policy
```

Per directory, priority is `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`. Ancestors apply root to cwd; nested linked worktrees shadow the main checkout's same-named instruction file. Canonical paths are deduplicated. Rules are sorted recursively; hidden entries and symlinks are skipped. Original/canonical `.claude` paths and CLAUDE.md targets are rejected. Project rules require `ctx.isProjectTrusted()`.

The extension adds `systemPromptOptions.sections.agents_rules`; it does **not** return an opaque rendered `systemPrompt`. GPT prompt sections remain composable in either loading order. `/agents-rules` lists currently discovered rule files. `.agents/skills` uses Pi's native loader, not a duplicated skill implementation.

## Deployment compatibility

Pi 1.4 still discovers CLAUDE.md natively. `setup.sh` uses the read-only `planAgentsOnly` compatibility adapter inside `scripts/managed-deploy.mjs` to patch **both SDK and bundled CLI** in the same backed-up config transaction. Custom legacy `extensions/claude-rules.ts` causes an error before writes; only the recognized repository-managed version is retired. The inert source stub is never deployed. See [deployment safety](../../docs/deployment-safety.md). The standalone `agents-only.mjs` CLI remains available for explicit compatibility diagnostics, but setup uses the managed transaction.

- `--dry-run` performs validation without writing or creating backups.
- Repeated application is idempotent; backups are not overwritten.
- An unsupported host layout/version is refused, not partially guessed.
- No `.claude` instructions, credentials or permissions are migrated/deleted.
- Host code changes require a **restart**, not only `/reload`.
- Pi updates can replace this patch: rerun fixture validation before redeploying after an upgrade.
- To roll back setup, preview the exact `transaction-UUID` backup using `node scripts/managed-deploy.mjs --restore <directory>`; `--apply` restores only when all current hashes match the deployed versions. Restore host and config intentionally, then restart Pi. Never force an older host backup over another Pi version.

Before deployment the active Pi installation still has its old discovery behavior. Merely editing this checkout does not disable it. Other explicitly configured third-party packages may load additional resources independently; this policy is not an OS filesystem sandbox.

## Tests (isolated, no host writes)

```sh
PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" npm test --prefix packages/pi-agents-context
```

Tests read the installed SDK and bundled loader source, patch **temporary copies**, check syntax, evaluate discovery with read tracking, and cover trust, symlink rejection, worktree shadowing, structured GPT composition, dry-run, backup and unsupported/custom-version refusal. These tests do not deploy this package or modify installed settings.
