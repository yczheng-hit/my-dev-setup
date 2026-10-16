# pi-subagent-hud

Local Pi extension (0.1.2). It shows each running [pi-subagents](https://github.com/nicobailon/pi-subagents)
child as one claude-hud style segment at the end of the HUD status line. A `│` separates the block
from the other extensions' statuses (permission mode, todos, …):

```
⏵⏵ bypass permissions ✓ All todos complete (4/4) │ ◐ delegate [gpt-6-luna]: Display test (1m 12s) · 2.7k | ◐ delegate [sonnet-5-5] (0m 45s) · 5.1k
```

Each segment shows these parts:
- **Icon**: `◐◓◑◒` while the child runs (one frame per second), `✓` when it completed, `✗` when it
  failed, was rejected or finished partially, `■` when it was stopped or paused, and `•` when it
  vanished without a result.
- **Agent name** and **short model name**: provider prefix and `claude-` dropped, e.g. `sonnet-5-5`.
- **Task**: first line, at most 28 chars. Only shown for children launched with the `subagent`
  tool; `/run` launches show no task, because the RPC never exposes task text.
- **Elapsed time** and **tokens**, when the provider reports them.

A finished segment stays for 10 s, then disappears. With nothing running, the segment is gone.

If the line is too long for the terminal (budget: terminal width − 50), the segments degrade in
three steps:
1. Tasks are dropped.
2. Everything collapses into one summary: `◐ 3 running: delegate×2, scout · 7.4k ✓1`.
3. The agent names are dropped from the summary too.

## How it works
- **Data source.** pi-subagents' documented in-process RPC (`docs/extension-api.md`) over `pi.events`:
  - `ping` checks the `fleetStatus` v1 and `asyncStatusSnapshot` v1 capabilities, and gives the
    async-complete event name;
  - `status` with no target is served from memory. It returns the fleet DTO (agent, model,
    startedAt, tokens) and the async snapshot (run ids, states, end times).
  - If the capabilities are missing, nothing is shown.
- **Task text.** Taken from the parent's own `subagent` tool calls: `tool_execution_start` gives
  the args, and `tool_execution_end` gives `result.details.asyncId`.
- **Matching fleet entries to runs.** Fleet keys are opaque, so entries are matched to runs by
  agent and by the child's start time.
  - Parallel launches start children in the same millisecond. So when a run's model is known
    (from its launch, or from what it already showed), only an entry with the same model
    qualifies; an entry with a different model is never taken.
  - Before 0.1.2, eight parallel `delegate`s could swap luna and sonnet models and tokens.
- **Workflow runs.** These include `/run`, which wraps its child in a one-step workflow. The
  wrapper's `workflow` fleet entry is claimed and never shown as its own segment.
- **Polling.** Every 1 s while something runs or lingers, and every 5 s when idle. When
  pi-subagents is absent or the status is not served from memory, polling drops to every 15 s.
  At most one request is in flight. Polling is read-only: the live test checks that the session
  file stays unchanged.
- **Output.** A single `ctx.ui.setStatus("zz-subagents", "│ …")`.
  - pi-hud-footer sorts statuses by key with `localeCompare`, joins them with spaces and truncates
    at the end.
  - The key `zz-subagents` sorts last, so the block always sits after permission mode and todos,
    behind a dim `│ `. Since 0.1.1; in 0.1.0 it sat between them, and the todo `✓` read like a
    finished subagent.
  - The bar counts against the width budget.
  - Separators between subagents are ` | `, because the HUD collapses repeated spaces.

## Setup
1. Add this package to `~/.pi/agent/settings.json` → `packages`.
2. In `~/.pi/agent/extensions/subagent/config.json` (pi-subagents), set:
   ```json
   { "inlineToolDisplay": "summary", "asyncWidget": false, "fleetView": false }
   ```
   `fleetView: false` removes the `N active agents · ↓/← to inspect` line above the HUD. Use
   `/subagents-fleet` for details.
3. Restart Pi.

## Tests
- `npm test`: unit tests for `extensions/format.ts`.
- `PI_HUD_LIVE_TEST=1 PI_HOST_DIR=<pi-coding-agent dir> node test/live-hud.mjs`: opt-in live test.
  Uses `PI_AGENT_HOME` (default `~/.pi/agent`) for installed npm packages, and the sibling
  `pi-hud-footer` package and `tools/pi-btw-split` checkout of this repo.
  - Runs a real Pi in a temporary, unfocused Herdr tab, with an isolated agent dir and the local
    fake model (`test/fixtures/fake-provider.ts`). No paid calls.
  - Scenarios: tool launch, two at once, `/run`, and idle polling leaving the session untouched.

## Rollback
1. Remove the package from `settings.json`.
2. Delete `"fleetView": false` from the pi-subagents config.
3. Restart Pi.
