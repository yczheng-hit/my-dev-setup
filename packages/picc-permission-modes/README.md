# picc-permission-modes — local Pi variant

Based on `@ladbabynpm/picc-permission-modes@0.1.3`. This checkout keeps its planning UI and permission rules, but no longer imports Claude Code configuration. Use the repository package entry, **not** the upstream npm entry, for these changes. Runtime code also depends on sibling `../pi-agents-context`; distributing this directory alone is unsupported.

## Modes

| Mode | Behavior |
| --- | --- |
| `default` | Ask for writes and non-read-only shell actions. |
| `acceptEdits` | Allow ordinary workspace writes and supported shell operations, retaining explicit rules and sensitive-path checks. |
| `plan` | Plan file is writable; other edits require human confirmation. Auto never approves a plan or answers a question for you. |
| `bypassPermissions` | Existing bypass behavior, retaining sensitive-path/manual safety checks. **This repository still defaults to bypass; enabling auto is explicit.** |
| `auto` | Explicit deny/ask and sensitive-path checks run first. Ordinary workspace writes and safe reads may avoid an LLM call; remaining actions use the selected reviewer. |

This is an application permission gate, **not an OS sandbox**. Reviewer judgments and textual policy lists are not deterministic security enforcement; explicit permission rules and manual safety gates remain important.

## Native configuration only

User configuration: `<agentDir>/extensions/picc-permission-modes/config.json`, normally `~/.pi/agent/extensions/picc-permission-modes/config.json`.

- `PICC_PERMISSION_MODES_CONFIG_PATH`: explicit alternate user configuration path.
- `PICC_PERMISSION_MODE`: initial mode for headless/SDK hosts; mode flag/session behavior remains supported.
- Repository permission rules: `.pi/permissions.json`.
- `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE_CONFIG_DIR` and old `autoMode.provider` transport/auth settings are **not imported or persisted**. No Claude content is copied, deleted or migrated.
- Only user configuration chooses the reviewer. Project permission files cannot redirect its provider/model/endpoint.

```json
{
  "autoMode": {
    "classifier": {
      "mode": "fixed",
      "provider": "anthropic",
      "model": "claude-sonnet-5-5",
      "timeoutMs": 15000,
      "onUnavailable": "ask",
      "failureThreshold": 3,
      "cooldownMs": 30000
    },
    "allow": ["Routine local tests and inspection"],
    "softDeny": ["Shared-system changes without specific authorization"],
    "hardDeny": ["Credential exfiltration"],
    "environment": ["A Pi coding session"],
    "classifyAllShell": false,
    "denialLimits": { "maxConsecutive": 3, "maxTotal": 20 },
    "transcriptMaxChars": 80000
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": ["Bash(npm:*)"],
    "deny": ["Edit(./protected/**)"],
    "ask": ["Bash(git push:*)"]
  }
}
```

Generic defaults use `classifier.mode: "active"` (follow the active Pi model). This repository instead supplies the fixed reviewer above. A missing fixed model never silently switches to active. Use a model actually registered in your Pi installation.

Relative path rules are matched against the session cwd, for both relative and absolute tool inputs. `classifyAllShell: true` sends otherwise allowed shell commands to review as well; it never bypasses denies, explicit asks or safety checks.

## Independent reviewer

The main model can be Codex, Claude, Gemini or a custom Pi provider; the reviewer can independently be any registered chat model supported by Pi's native registry. The reviewer request uses **that model's** endpoint, credentials, headers and OAuth handling via `modelRegistry.streamSimple()`. No main-model key/header is copied to another provider. Configure provider credentials using Pi's models/auth facilities, not this permission file.

The reviewer receives no execution tools, requests reasoning off, and returns only:

```json
{"decision":"allow","reason":"Routine authorized local operation"}
```

Valid decisions are `allow`, `deny`, `ask`. Invalid JSON, extra fields, XML, tool calls, incomplete output, auth/provider errors and timeouts never authorize execution. Unavailable → one-time manual confirmation (`ask`) or block (`deny`); headless hosts block when confirmation is required. Repeated failures open a cooldown. Cancellation, session/reload/tree changes and model changes invalidate pending results and permission dialogs. Denial limits request human input, never silently allow.

Instructions use native AGENTS and trusted `.agents/rules` through the shared package; no CLAUDE fallback. Transcript collection uses Pi's read-only, compaction-aware projection, keeping compaction/branch summaries and extension evidence distinct from actual user requests. Thinking is excluded; tool results are untrusted and truncated. Logs, when enabled, contain operational metadata, not prompts, commands, model reasons or credentials. Reviewer requests themselves necessarily transmit the selected context to the reviewer provider.

## Commands

- `/auto`: enter auto mode.
- `/auto status`: reviewer, last decision, latency, failure/cooldown state.
- `/auto model active`: follow main model.
- `/auto model provider/model`: select an independent reviewer **for this session only**.
- `/auto test`: diagnostic review request; executes no proposed action.
- `/default`, `/acceptEdits`, `/plan`, `/bypassPermissions`, `/mode`: existing mode controls.

Interactive selection never changes the main model, thinking level or tool set. Edit the user config and reload/restart to persist a reviewer selection.

## Validation

```sh
export PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
agent_dir=$(mktemp -d /tmp/pi-auto-tests-XXXXXX)
PI_CODING_AGENT_DIR="$agent_dir" npm test --prefix packages/picc-permission-modes -- --maxWorkers=2 --minWorkers=1
rm -rf "$agent_dir"
node --test packages/pi-agents-context/test/*.test.mjs
```

See `LOCAL-PATCH.md` for historical changes. Tests use isolated configuration and mocked/offline providers; they do not establish live provider availability or model decision quality.
