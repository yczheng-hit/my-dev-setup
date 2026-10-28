# Local plan-mode fix

Based on `@ladbabynpm/picc-permission-modes@0.1.3`. The original npm package is retained; this directory is the configured local package.

## Cause and changes

`before_agent_start` runs before the model's tool calls. Entering plan mode mid-turn previously returned neither the plan path nor the workflow, so the model wrote under the workspace's `.pi/plans/` while approval read a different global slugged file.

- `EnterPlanMode` awaits the mode transition and returns the full existing planning instructions with the executing session's exact plan path immediately.
- `ExitPlanMode` stays in plan mode when the expected file is missing, empty, whitespace-only, or unreadable. It returns the required path and a request to write the plan, without opening approval UI.
- Removed the unused fallback context after passing the actual execution context to the mode transition.
- Regression tests cover same-turn entry/write/render/approval, executing-session paths, empty plans, and read failures in TUI and headless paths.

## Approval dialog: wheel and bypass-first ordering

- The normal approval dialog now defaults to **1. bypass permissions** (Enter). **2. auto-accept edits** retains Shift+Tab; selecting 2 then pressing Enter also chooses accept edits. TUI and headless lists use the same order.
- In Pi **fullscreen** mode, the standard `handleMouse` API consumes wheel events anywhere inside the dialog and scrolls only the plan body. Header, approval selection and footer stay fixed; boundary and fitting/empty-plan wheels do not fall through to the conversation or request unnecessary redraws.
- Pi's normalized `wheelDelta` is used directly, including its acceleration/Alt multiplier. Closed dialogs and non-wheel/out-of-bounds events are ignored.
- Fitting plans no longer acquire a hidden one-line offset. PgUp/PgDn and Home/End remain supported. In **regular** mode, mouse scrolling remains terminal-managed; use these keyboard shortcuts for the plan body.
- Tests first demonstrated the missing wheel handler and old approval ordering, then passed after the changes. Coverage includes real Pi `dispatchMouseEvent`, real approval-factory keyboard actions, headless choice mapping, bounds and redraw flags.

## Validation

Runtime dependencies are installed locally. Test-only peer links under `node_modules` point to this machine's Pi host; these peers are supplied by Pi when it loads the extension.

Run the focused tests without writing fixtures into real user plan storage:

```bash
cd packages/picc-permission-modes
test_agent_dir=$(mktemp -d /tmp/pi-plan-mode-test-XXXXXX)
PI_CODING_AGENT_DIR="$test_agent_dir" npm test -- exitPlanModeDialog.test.ts index.test.ts exitPlanModeTool.test.ts \
  -t 'ExitPlanModeDialog|dialogOptionsFor|EnterPlanMode tool|ExitPlanMode tool|ExitPlanMode invalid plan guard' \
  --pool=forks --poolOptions.forks.singleFork
result=$?
rm -rf "$test_agent_dir"
exit "$result"
```

Focused tests: 82 passed (including the earlier plan-file fix regressions). Pi's real `DefaultResourceLoader` loads this local package and registers both tools without errors.

Full-suite comparison in isolated agent directories: original 496 passed / 4 failed; earlier plan-file patch 505 passed / 4 failed; current patch 534 passed / the exact same 4 failed. Existing/environment-dependent failures are Windows config paths, Windows dangerous paths, bypass-mode deny rules, and the home-relative plan-path test when agent storage is outside the home directory. They were not changed by these fixes. Reports: `/tmp/pi-plan-mode-baseline-results.json`, `/tmp/pi-plan-mode-fixed-results.json`, `/tmp/pi-plan-mode-wheel-results.json`; latest test log: `/tmp/pi-plan-mode-wheel-tests.log`.

## Activation and rollback

`~/.pi/agent/settings.json` selects this local directory instead of `npm:@ladbabynpm/picc-permission-modes`. Run `/reload` in Pi (or restart) to activate; the current loaded extension is not modified in place.

To roll back, replace this package entry with `npm:@ladbabynpm/picc-permission-modes` and run `/reload`. The pre-change settings backup is `~/.pi/agent/settings.json.pre-plan-mode-fix-20261014T011618.bak`.

## Footer: hand over to pi-hud-footer

- `installFooter` no longer calls `ctx.ui.setFooter`; the footer is owned by `npm:pi-hud-footer` (pi-cc-extensions `enableCustomFooter` is false).
- `updateStatus` publishes the mode as status key `permission-mode` (e.g. `⏵⏵ bypass permissions`), coloured per mode. pi-hud-footer shows extension statuses with their colours intact.
- Colours: `modeColors` in `~/.pi/agent/extensions/picc-permission-modes/config.json` (`#rrggbb` or pi theme colour; `null` hides the chip, the default for `default`). Built-in defaults: acceptEdits #ccb1ff, plan #5fafff, bypassPermissions #ff5f5f, auto #ffc107. Read on every mode change.
- The old `Footer: mode line format` tests are `describe.skip`ped. Backups: `index.ts.bak-footer-*`, `~/.pi/agent/pi-cc-extensions.json.bak-*`, `config.json.bak-*`.

## Shell parse errors no longer printed onto the TUI (2026-10-15)

**Symptom.** `[picc-permission-modes] Bad substitution: new` was printed three times on top of the
editor and the HUD footer. The trigger was a bash command whose quoted heredoc held a JS template
literal (`${new Date()…}`).

**Cause.**
- `shell-quote` throws on such text.
- `tryParseShellCommand` (`upstream/utils/bash/shellQuote.ts`) already returns
  `{ success: false, error }`.
- But first it called `logError`, which used `console.error`. Under Pi's TUI, raw stderr writes land
  on the screen.

**Change.** `upstream/_compat/stubs.ts` `logError` no longer writes to stdout or stderr.
- Its only callers, the three in `shellQuote.ts`, already handle the error, so permission decisions
  are unchanged.
- For diagnostics, set `PICC_DEBUG=/absolute/file`; the messages are appended there.
- Backup: `upstream/_compat/stubs.ts.bak-parse-noise-*`.

**Tests.**
- `parse-noise.test.ts` failed before the change (`console.error` was called) and passes after it.
  It covers the silent default and the `PICC_DEBUG` file.
- Full suite: 530 passed (including the 2 new), 6 skipped, 4 failed. The same 4 fail with the original `stubs.ts`, so they
  predate this change:
  - `config-path` default dir;
  - `host-mode-env` deny-in-bypass;
  - tilde plan path;
  - Windows path.
- The Pi loader loads `index.ts` with 0 errors.

**Not changed.** Two other raw writes remain, both on error paths only:
- `index.ts` `console.warn` for auto-mode config issues;
- `index.ts` `console.error` when `persistState` cannot append.

## Plan mode: user-only entry (2026-10-20)

**Why.** The model-callable `EnterPlanMode` tool let the agent switch into plan mode by itself
(after a confirm dialog). The user wants plan mode entered only by hand.

**Change.** New config `planMode.agentCanEnter` in the permission-modes `config.json`:
- `false`: `EnterPlanMode` is not registered, so the model can neither see nor call it.
  `/plan`, `/mode plan` and Shift+Tab still switch modes. `ExitPlanMode` and its approval flow
  are unchanged, so a manually entered plan still ends with the approval dialog.
- Missing, invalid or `true`: upstream behavior (tool registered).
- Read once at extension load; edit the file, then `/reload`.

**Tests.** `index.test.ts` → `planMode.agentCanEnter (local patch)`: default keeps the tool; `false`
removes it while keeping `ExitPlanMode` and `/plan`. Full suite in an isolated copy with Pi 1.2.0
host dependencies: 532 passed, 6 skipped, and the same 4 pre-existing failures as before the change
(baseline 530 passed / same 4).

## Startup mode: `permissions.defaultMode` (2026-10-22)

**Why.** The user wants every new Pi session to start in bypass permissions, without typing
`--permission-mode` each time.

**Change.**
- New config `permissions.defaultMode` in the permission-modes `config.json`, the same key as Claude
  Code's `settings.json`. Accepts the mode names and aliases of `/mode` (`bypass`,
  `bypass-permissions`, any case). Missing or invalid means `default` (upstream behavior).
  Read once at extension load; edit the file, then `/reload`.
- It only replaces the initial value of `currentMode`. Precedence, highest first:
  1. `PICC_PERMISSION_MODE` (headless hosts);
  2. `--permission-mode`;
  3. the mode saved in a resumed, forked or reloaded session;
  4. `permissions.defaultMode`.
- Fix: `refreshSessionContext` now calls `publishMode` for UI sessions. Before, a new session that
  started in a non-default mode (from the flag or this setting) never published it, so subagents
  fell back to `default` until the user switched mode by hand.
- This repo's config sets `"defaultMode": "bypassPermissions"`.

**Tests.** `index.test.ts` → `planMode.agentCanEnter (local patch)` → `permissions.defaultMode …`:
aliases and invalid values; a new session starts in bypass and lets `npm test` run; a headless
(subagent) session inherits it; `--permission-mode default` overrides it; a resumed session keeps its
saved `acceptEdits`. The subagent assertion fails without the `publishMode` fix. Full suite in an
isolated copy with Pi 1.2.0 host dependencies: 533 passed, 6 skipped, and the same 4 pre-existing
failures as before the change (baseline 532 passed / same 4). The patch was regenerated and checked:
npm original (CRLF stripped) + patch equals this directory's runtime files.

## macOS/Linux only: Windows path logic removed (2026-10-22)

**Why.** This setup never runs on Windows. `hasSuspiciousWindowsPathPattern` also ran on macOS and
asked for approval on ordinary paths: `grep`/`read` with path `.`, `src/.`, `notes.`, `file `,
`backup~1/a.ts`, `a/.../b`, `//server/share`, `x.CON`.

**Change** (marked `// local patch`):
- `permissionContext.ts`: removed `hasSuspiciousWindowsPathPattern` and its two uses
  (`isDangerousFilePath`, the read-permission prompt). The dangerous-file and dangerous-directory
  checks (`.git/`, `.bashrc`, `.claude/`, …) are unchanged.
- `upstream/utils/shell/readOnlyCommandValidation.ts`: removed `getPlatform` and
  `containsVulnerableUncPath` (returned `false` on non-Windows anyway); removed its calls in
  `upstream/tools/BashTool/readOnlyValidation.ts` and `upstream/utils/permissions/pathValidation.ts`.
- `pathValidation.ts`: glob base uses `/` only; `expandTilde` drops the `~\\` branch.
- `bashPathHelpers.ts`: removed the `C:` / `C:/x` drive-letter checks from `isDangerousRemovalPath`.

**Tests.** The 4 previously environment-dependent failures are fixed:
- `config-path.test.ts`: POSIX agent dir instead of `C:\\...`.
- `index.test.ts` Windows-path test: replaced by "does NOT flag `.`, `src/.`, `notes.`, `backup~1/a.ts`,
  `//server/share`".
- `host-mode-env.test.ts`: writes its own temp config with `Bash(rm -rf:*)` deny and sets
  `PICC_PERMISSION_MODES_CONFIG_PATH` / `CLAUDE_CONFIG_DIR`, so it no longer depends on the user's
  `~/.claude/settings.json` (or reads the real picc config).
- `index.test.ts` tilde plan path: builds `~/` + `relative(home, planPath)`, so it also works when
  the agent dir is outside `$HOME`.
- Other tests: `C:/Users/...` and `C:\\...` sample paths changed to POSIX paths.

Full suite in an isolated copy with Pi 1.4.0 host dependencies: **541 passed, 6 skipped, 0 failed**.
Patch regenerated and verified: npm original (CRLF stripped) + patch equals this directory's runtime
files. Pi 1.4.0 loads all 26 extensions with no errors.

## Codex-style tools go through the same permission gate (2026-10-28)

**Symptom.** With GPT on the `openai-codex` provider, `pi-openai-codex-compat` replaces `edit`/`write`/`bash`
with `apply_patch`, `exec_command` and `write_stdin`. The gate only knew `bash`/`edit`/`write`, so the new
tools fell through to "no-path tool" → allow: plan, default and acceptEdits mode no longer stopped edits or
shell commands, and bypass mode skipped its sensitive-path (D4) check.

**Change.**
- New `codexTools.ts` with `expandCodexToolCall`: `exec_command` (`cmd`) and `shell_command` (`command`) become a
  `bash` call; `apply_patch` is parsed into one `write` (Add File) or `edit` (Update/Delete File, plus the
  `Move to` target) per file with its path; other tools are passed through unchanged. An unparseable patch is
  gated as an edit with no path, so it asks (or is denied without UI) instead of being allowed.
- `index.ts`: the `tool_call` handler now loops over the expanded calls and runs the existing gate on each
  (`gateToolCall`, the old handler body with `toolCallId` passed in); the first block wins. Claude's tools are
  unaffected: `expandCodexToolCall` returns them as-is.
- `write_stdin` is left ungated: it only feeds a process the user already approved.

**Tests.** `codexTools.test.ts` (parser/mapping) and a "Codex-style tools" block in `index.test.ts` (default asks,
read-only `exec_command` allowed, acceptEdits allows in cwd, bypass still asks on `~/.gitconfig`, plan mode
blocks project edits). Full suite: **550 passed, 6 skipped, 0 failed**. Patch regenerated and verified:
npm original (CRLF stripped) + patch equals this directory's runtime files.

## Native plan review and explicit cancellation (2026-10-28)

**Symptom/cause.** The old fourth choice spawned an inherited-stdio editor inside the approval
custom overlay without stopping/restoring Pi's TUI. Returning from `vi :q!` could leave a blank,
unusable screen. With no EDITOR it could do nothing. “Stay” did not stop the model's next turn.

**Change** (`// local patch`):
- Keep four choices and bypass-first approval order. Choice 3 is **Stay in plan mode**; choice 4 is
  **Request changes to the plan…**, not a second ambiguous “No”.
- Approval closes before `ctx.ui.editor()` opens. Feedback Esc/empty submission and Stay/Esc return
  `terminate: true`: remain in plan mode, retain the plan, wait for the user's next message.
- Submitted feedback is returned through the current tool result, with explicit revise/reapprove
  instructions. It is not an edited plan, not execution approval, and not a queued follow-up message.
- Ctrl+G in approval closes it, opens Pi's native editor with the saved plan, saves non-empty edits,
  and reopens approval. Cancelling/blank input preserves the old plan; save failure is notified.
  Ctrl+G inside the native editor uses Pi's own external-editor terminal handoff.
- RPC uses its supported selector, not terminal custom UI. Empty/unreadable-plan guards, scrolling,
  Shift+Tab, approval permissions and allowed prompts remain unchanged.

**Validation.** New regression suite was red on all 12 cases before the fix. Current isolated full
suite: **562 passed, 6 skipped, 0 failed** (Pi 1.4.0). Also run from the repository root:

```sh
PI_HOST_DIR=/path/to/pi-coding-agent node packages/picc-permission-modes/test/model-turn.mjs
PI_HOST_DIR=/path/to/pi-coding-agent python3 packages/picc-permission-modes/test/native-ui.py
```

The first uses a deterministic offline provider with real Pi orchestration: Stay/cancelled feedback
produce one model request, explicit approval produces two. The second uses an isolated tmux Pi to
verify native feedback → Pi-managed vi → cancel → usable input, plus edit/save/reapproval. Neither
reads real user configuration, saved sessions or the clipboard. Regenerated runtime-only patch:
normalized npm 0.1.3 + patch equals all local runtime files. Activate with `/reload` when idle.
