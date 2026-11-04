# Pi Scheduler

**Run checks on a schedule. Wake the agent when there’s something to do.**

Schedule shell commands, agent prompts, and reminders inside [Pi](https://github.com/earendil-works/pi). Commands run directly and bring their output back to the agent when your wake policy matches.

> “Run the tests every five minutes. Wake yourself if they fail. Stop after ten runs.”

## Why this package?

Pi Scheduler focuses on **scheduled actions**: run a command, capture stdout/stderr, and trigger a follow-up on success or failure. Execution limits, persistent tasks, and atomic claims let multiple Pi processes share scheduled work.

Prompt loops suit checks that need agent judgment every time. Broader packages such as [pi-loop](https://github.com/trvon/pi-loop) also provide workflows, event triggers, orchestration, and command monitoring. Choose Pi Scheduler when you want a focused scheduler for commands, prompts, and reminders.

**Pi must be running for tasks to fire.** Tasks persist across restarts, but this package does not run an always-on daemon.

## Get started

```bash
pi install npm:@jl1990/pi-scheduler
```

Restart Pi or run `/reload`. Ask for a scheduled task in plain language, or try:

```text
/remind 20m take a break
/schedule prompt 5m :: Check whether the deployment has finished.
/schedules
```

A compact widget shows upcoming tasks below the editor.

## Example: run tests, investigate failures

Ask Pi to schedule this, or use these arguments with its `schedule_task` tool:

```json
{
  "action": "shell",
  "type": "interval",
  "schedule": "5m",
  "command": "npm test",
  "timeoutMs": 120000,
  "wakeOn": "failure",
  "failurePrompt": "Review the test output, diagnose the failure, and report the cause.",
  "maxRuns": 10,
  "scope": "cwd"
}
```

Use a test command that finishes rather than entering watch mode. Every five minutes, the scheduler runs it and captures the result:

- **Pass:** no agent turn. Pi may still show execution notifications and result messages.
- **Non-zero exit or timeout:** wake the agent with stdout/stderr to investigate.
- **Ten executions:** disable the task automatically.

For recurring shell tasks, `stopOn` may be `success`, `failure`, or `never` (the default). It disables recurrence after the matching result; non-zero exits, timeouts, and killed commands count as failures. `stopOn` is independent of `wakeOn`.

Recurring tasks do not stop when an external goal completes unless configured with `stopOn`. Cancel them when finished, or bound them with `maxRuns`.

Use `expiresIn: "2h"` to stop starting new runs after two hours. The absolute deadline persists across restarts. For ordinary shell tasks, expiry is silent and visible as `expired` in task history; an already-running command finishes with its usual wake policy. Renew an expired task with a new `expiresIn`, or set it to `null` in `manage_scheduled_task` to clear the deadline and resume it.

## Wait for readiness explicitly (local extension)

Use `resultMode: "readiness"` when waiting for a report, file or flow. This is opt-in: existing tasks and ordinary shell exit-code policies are unchanged. Repair a broken checker before migrating it; the scheduler never guesses the meaning of an existing command.

```json
{
  "action": "shell",
  "resultMode": "readiness",
  "type": "interval",
  "schedule": "5m",
  "command": "./check-readiness.sh",
  "wakeOn": "success",
  "stopOn": "success",
  "followUpPrompt": "Read the final report and continue within the existing authorization.",
  "expiresIn": "2h"
}
```

The checker must exit **0** and write exactly one JSON object to stdout. Put diagnostic logs on stderr:

```json
{"state":"pending","summary":"The flow is running; no final report yet"}
```

Use `ready` when the condition is satisfied, or `error` when the checker cannot determine the state. Only `state` and `summary` are accepted; summary must be nonblank and at most 1000 characters, and stdout at most 8192 UTF-8 bytes. Missing/malformed output, nonzero exit, timeout, killed execution, truncated output or execution exceptions are checker errors—even if stdout claims `ready`. Exit 1 is **not** a synonym for pending.

| Policy | `pending` | `ready` | Checker error |
| --- | --- | --- | --- |
| `wakeOn: "success"` (default) | Keep waiting | Wake | Pause checks and report |
| `wakeOn: "always"` | Wake on every check | Wake | Pause checks and report |

`stopOn: "success"` (default) means **ready**, not just exit 0. `stopOn: "never"` continues after ready. Other wake/stop policies are rejected in readiness mode. `successPrompt` applies only to ready; pending uses `followUpPrompt` or a default instruction. Error/limit reports have fixed diagnostic instructions and do not depend on `failurePrompt` or the success wake filter.

- A checker error disables **this scheduled check**, not the monitored flow or main session. Repair `command`/`cwd` via `manage_scheduled_task action=update`, then explicitly `enable`. A repair alone does not resume polling.
- `maxRuns`, `expiresIn`, or a one-shot pending check ends waiting with a report that the condition is not yet satisfied. This is not evidence that the monitored work failed. Renew an elapsed deadline before enabling; raise an exhausted run limit to allow more attempts. Limits remain lifetime counters.
- Reports use the durable wake queue and respect drafts, busy turns and pause. Expiry does not delete a queued terminal report. Restart resumes queued delivery; ambiguous dispatch is retained as `uncertain`, never automatically replayed. Pi must be running; this is not an external alarm service.
- Unchanged pending checks suppress only repeated display-only chat lines. Every execution still counts, updates the widget/time and bounded history; `wakeOn: "always"` still wakes every time.
- `/schedule-edit` edits future prompts without changing the checker or policy. A queued fixed error/limit report remains unchanged; dispatching/uncertain delivery still rejects editing. Generic task updates invalidate queued work as before; explicit cancel/disable/remove discards it. Cleanup preserves undelivered readiness terminal reports.

A logically broken checker that repeatedly outputs a valid `pending` still needs its own tests and a waiting limit. The protocol cannot infer that the checker is wrong.

## Scheduling options

| Option | Choices |
| --- | --- |
| Action | `shell` runs a command; `prompt` wakes the agent; `notify` shows a reminder; `message` adds a custom message |
| Schedule | `once`: `5m`, `tomorrow at 9am`, ISO datetime; `interval`: `30s`, `5m`, `1h`; `cron`: `0 0 9 * * 1-5` (weekdays at 9am) |
| Scope | `session` (default): creating session; `cwd`: sessions in the same project directory; `global`: any session |
| Limits | `maxRuns` caps executions; `timeoutMs` bounds each shell command; `expiresIn` sets a positive lifetime (for example `2h`) |
| `stopOn` | For shell actions, stop recurrence after `success`, `failure`, or `never` (default) |
| `backoff` | Interval-only `{ "factor": 2, "maxInterval": "15m" }` grows the delay after each execution, up to the cap |

Backoff applies to every outcome and persists across restarts. Updating the schedule or backoff, or explicitly enabling a task, resets the delay to the base interval. Set `backoff: null` to return to a fixed interval; remove it explicitly when switching to cron or once. Execution limits still count runs normally.

Cron uses `croner`; six-field expressions with seconds are recommended. Use `session` scope when a follow-up must return to a specific session. For shared scopes, the process that claims the task receives the follow-up.

### Shell wake policy

| `wakeOn` | Wake the agent when… |
| --- | --- |
| `failure` | The command exits non-zero or is killed/times out |
| `success` | The command exits 0 without being killed |
| `always` | Any run finishes |
| `never` | Never; just record the result |
| `change` | After the first run, when stdout, stderr, exit status, or killed/timeout state changes |

Use `successPrompt` or `failurePrompt` for outcome-specific instructions, or `followUpPrompt` for either outcome. The wake policy is checked first. Without an explicit policy, supplying a prompt defaults to `always`; otherwise the default is `never`. An explicit matching policy without a custom prompt uses a default review instruction.

`change` stores a SHA-256 fingerprint of the complete (untruncated) shell result in task state. The first run establishes the baseline without waking; repeated identical results stay quiet. Editing the command, working directory, or opting into `change` starts a new baseline. If that first run matches `stopOn`, the task stops silently; use `success` or `failure` when the stopping result must wake the agent.

**Exit status matters.** A command that prints a failed CI pipeline may still exit 0. In default exit-code mode, map pipeline states to the intended exit status. For a separate pending/ready/checker-error protocol, explicitly use readiness mode above.

## Manage tasks

Ask Pi to list, update, disable, or remove tasks. Its tools are `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task`, and `manage_scheduled_task`.

Completed runs keep a compact history of the latest 10 attempts (timestamps, duration, outcome, and wake disposition). Use `list_scheduled_tasks` with `includeHistory: true` (and optionally `id`) to inspect it; the default listing remains compact. `delivered` means a wake was submitted to Pi, not that an agent turn finished; `pending` means delivery was not yet recorded.

```text
/schedules                       # active tasks
/schedules all                   # include inactive tasks
/schedules history               # show compact run history
/schedule-cancel <id-or-prefix>
/schedule-enable <id-or-prefix>
/schedule-disable <id-or-prefix>
/schedule-remove <id-or-prefix>
/schedule-cleanup
/schedule-widget [on|off]
```

To create tasks directly:

```text
/schedule [notify|prompt|shell|message] [once|interval|cron|every] <schedule> :: <payload>
```

## Persistence and recovery

Tasks live in `~/.pi/agent/state/scheduler/tasks.json`. Atomic state transactions and task claims coordinate execution across Pi processes; shared state refreshes every five seconds.

A reported loss of the state lock fails the affected transaction instead of terminating Pi. Background storage failures are contained: failed claims retry after a successful refresh rather than immediately, and attempts unable to save completion or failure are recovered as interrupted once storage is available.

On restart, overdue one-shot and interval tasks run. Cron catches up the most recent missed occurrence per task, newest first, within these limits:

| Environment variable | Default |
| --- | --- |
| `PI_SCHEDULER_CATCHUP_WINDOW_H` | `24` hours |
| `PI_SCHEDULER_CATCHUP_MAX` | `5` tasks per startup; `0` disables cron catch-up |

Interrupted executions are recorded as failed: one-shot tasks remain failed, while ordinary recurring tasks are rescheduled. Interrupted readiness checks instead pause and report the checker failure. Shell commands run with your local user permissions.

## Development

```bash
npm test
npm pack --dry-run
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --list-models __unlikely_model_filter__
```

Published GitHub Releases trigger the [npm publishing workflow](.github/workflows/publish-npm.yml), which tests, checks package contents, and publishes with provenance.

[MIT license](LICENSE.md)
