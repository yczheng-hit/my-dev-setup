# picc-permission-modes

[![npm downloads](https://img.shields.io/npm/dt/@ladbabynpm/picc-permission-modes.svg)](https://www.npmjs.com/package/@ladbabynpm/picc-permission-modes)

A Claude Code style permission-mode system for the [pi coding agent](https://pi.dev).
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Mirrors upstream `PermissionMode` semantics across messages shown to the LLM, dialogs shown in the TUI, prompt strings, plan-mode flow, dangerous-path safety, and persistence.

Fork of [pi-permission-modes](https://pi.dev/packages/pi-permission-modes), where we replicate Claude Code's harness more faithfully.

## Modes

| Mode | Symbol | Behavior |
| --- | --- | --- |
| `default` | — | Ask on edits/writes. Auto-allow reads inside cwd. Ask on bash outside the read-only allowlist. |
| `acceptEdits` | ⏵⏵ | Auto-allow edits inside cwd. Ask otherwise. Auto-allow bash commands on the upstream allowlist (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`). |
| `plan` | ⏸ | Read-only intent, but **not hard-blocked**: only the plan file is auto-allowed; every other edit/write flows through the normal permission prompt (matches Claude Code). Bash and reads defer to `pi-permission-system`. Plan file at `<agentDir>/plans/<slug>.md` (global dir + random 3-word `adjective-verb-noun` slug, e.g. `~/.pi/agent/plans/gleaming-brewing-phoenix.md`). |
| `bypassPermissions` | ⏵⏵ | Auto-allow everything **except** dangerous-path safety checks (`.gitconfig`, `.bashrc`, `.git/`, `.claude/`, etc.). |
| `auto` | ⏵⏵ | Reads/search/plan/task tools are safe-allowlisted (no classifier call). Edits/writes **inside cwd** are fast-pathed like `acceptEdits` (dangerous paths excluded). Everything else goes through a separate LLM classifier that allows safe actions and blocks destructive/exfiltrating ones. If the classifier is **unavailable** (no provider, HTTP error, timeout), the call falls back to a normal user prompt instead of hard-blocking. The TUI surfaces each classifier decision inline (see below). |

## Install

Install via `pi install npm:@ladbabynpm/picc-permission-modes`.


## Configuration

All configuration lives in `~/.pi/agent/extensions/picc-permission-modes/config.json` (not the installed npm package), with a few environment variables to override its location or supply the classifier's auth. The extension creates a starter config at that path on first load if it does not yet exist.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PICC_PERMISSION_MODES_CONFIG_PATH` | `~/.pi/agent/extensions/picc-permission-modes/config.json` | Absolute path to the extension's `config.json`. Override to point at a config in a different location. |
| `PICC_PERMISSION_MODE` | *(unset)* | Initial permission mode for **headless / SDK** hosts (e.g. the `picc-claude-shim` driven by T3 Code). Set to one of `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` (camelCase or kebab-case). Headless pi sessions never fire `session_start`, so the `--permission-mode` flag is never seen — this var is how a host tells the gate which mode to start in. Without it, a headless session stays on `default` and auto-rejects every non-allow tool call. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Directory the loader reads `settings.json` from when falling back to Claude Code's permissions block. |
| `ANTHROPIC_AUTH_TOKEN` | *(unset)* | API key for the `auto` mode LLM classifier. Used when `autoMode.provider.apiKey` is unset, and interpolated into `"${ANTHROPIC_AUTH_TOKEN}"` placeholders in `config.json`. |

### Example `config.json`

```json
{
  "autoMode": {
    "provider": {
      "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
      "maxContextChars": 80000
    },
    "allow": [
      "Standard read-only file inspection inside the working directory.",
      "Standard search/grep/glob operations in the working directory.",
      "Running tests, linters, and formatters.",
      "Editing files inside the current working directory.",
      "git add/commit/diff/log/status/fetch within the repository."
    ],
    "softDeny": [
      "Force pushes (git push -f, git push --force, git push --force-with-lease).",
      "rm -rf outside the working directory.",
      "Editing files outside the working directory without explicit authorization.",
      "Network egress to non-trusted external endpoints.",
      "git push to a branch that is not the session's working branch."
    ],
    "hardDeny": [
      "rm -rf /, rm -rf $HOME, or equivalent filesystem-wide destructive deletes.",
      "Force push to main / master / the repository default branch.",
      "DROP DATABASE / DROP SCHEMA without explicit user confirmation.",
      "Disabling safety tooling, audit logs, or git hooks.",
      "Systematic scanning of credential stores (.env, ~/.aws/, keychains, etc.).",
      "Disabling or removing .claude/ settings, hooks, or rules."
    ],
    "environment": [
      "An autonomous coding agent running inside the user's pi session."
    ],
    "classifyAllShell": false,
    "denialLimits": {
      "maxConsecutive": 3,
      "maxTotal": 20
    },
    "transcriptMaxChars": 80000
  },
  "permissions": {
    "allow": ["Read", "Bash(go)", "Bash(git commit *)"],
    "deny": ["Bash(rm *)", "Bash(git push *)", "Bash(sudo *)"],
    "ask": []
  }
}
```

User permissions are explained in the next section.

## User permissions

Add a `permissions` block to `~/.pi/agent/extensions/picc-permission-modes/config.json` to seed session-allow, session-deny, and session-ask rules. The format is identical to Claude Code's `permissions` block in `~/.claude/settings.json` (see [code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions)). Example:

```json
{
  "permissions": {
    "allow": [
      "WebFetch",
      "Read(//**)",
      "Bash(go)",
      "Bash(git commit *)",
      "Bash(git * main)"
    ],
    "deny": [
      "Bash(rm *)",
      "Bash(rmdir *)",
      "Bash(git push *)",
      "Bash(sudo *)",
      "Bash(shred *)",
      "Bash(Restart-Computer *)",
      "Bash(Format-Volume *)",
      "Bash(Clear-Disk *)",
      "Bash(Remove-Item *)"
    ],
    "ask": []
  }
}
```

Each rule is a string like `Read`, `Bash(go)`, `Bash(git commit *)`, or `Read(//absolute/path/**)`. Bare tool names (no parens) auto-allow every call to that tool. Paren rules can carry an exact command, a wildcard, or a path glob.

**Precedence:** if the local `permissions` block in `config.json` has any entries in `allow`/`deny`/`ask`, those are used as-is. If the local block is empty (or the file is missing), the loader falls back to parsing `~/.claude/settings.json`'s `permissions` block so the same allow/deny rules you have in Claude Code apply to pi too.

**Auto-persistence:** when the loader falls back to `~/.claude/settings.json`, it also writes the parsed rules back to `config.json` so the rules show up on disk where you can inspect or edit them. The write is idempotent — re-running when the local rules already match the claude settings is a no-op. Other top-level keys in `config.json` (e.g. `autoMode`) are preserved.

## CLI

```bash
pi --permission-mode default          # explicit default
pi --permission-mode acceptEdits      # auto-approve edits
pi --permission-mode plan             # start in plan mode
pi --permission-mode bypassPermissions
pi --permission-mode auto             # auto-mode classifier routes every tool call
pi --permission-mode ask              # alias for default
```

## Slash commands

- `/default`, `/acceptEdits`, `/plan`, `/bypassPermissions`, `/auto`
- `/mode <name>` — set mode by alias
- `/mode` — open an interactive selector
