// Bridge pi UI prompts (permission dialogs, plan review, select/confirm/input/custom)
// to herdr's "blocked" state, and tell herdr WHY it is blocked.
//
// - State: herdr's managed integration (herdr-agent-state.ts) only listens for
//   `herdr:blocked` on pi.events; pi emits ui_prompt_start/ui_prompt_end around
//   every ctx.ui prompt, so we forward those.
// - Reason: herdr has no blocked sub-states, so we publish a display-only
//   state label for `blocked`. The local.pane-id herdr plugin labels every agent
//   with its number; we keep that number and show "<n> plan ready" etc.
//   Clearing our source falls back to the plugin's labels.
// @ts-nocheck

import { execFile } from "node:child_process";

const LABELS = {
  ExitPlanMode: "plan ready",
  EnterPlanMode: "enter plan?",
};
const DEFAULT_LABEL = "approval";

export default function (pi) {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let active = false;
  let activeLabel;
  let stopped = false;
  const runningTools = new Map(); // toolCallId -> toolName
  const prompts = []; // Matching kind/title supports nested and out-of-order closes.

  let bootstrapActive = false;
  const unsubscribeBootstrap = pi.events.on("btw:ui-bootstrap", (event) => {
    if (!stopped) bootstrapActive = event?.active === true;
  });
  function report(args) {
    try {
      execFile(herdrBin, ["pane", "report-metadata", paneId, "--source", "user:pi-blocked-reason", ...args], { timeout: 2000 }, () => {});
    } catch {}
  }

  let reportSeq = 0;
  function reportMetadata(label) {
    const seq = ++reportSeq;
    if (!label) {
      // Also clears the pre-0.4 `blocked_reason` token.
      report(["--clear-state-labels", "--clear-token", "blocked_reason"]);
      return;
    }
    // Reuse the agent number from the plugin's label.
    try {
      execFile(herdrBin, ["pane", "get", paneId], { timeout: 2000 }, (error, stdout) => {
        if (stopped || seq !== reportSeq) return; // prompt already ended
        let num = "";
        try {
          if (!error) num = String(JSON.parse(stdout).result?.pane?.state_labels?.idle ?? "").match(/^\d+(?= |$)/)?.[0] ?? "";
        } catch {}
        report(["--state-label", `blocked=${num ? `${num} ` : ""}${label}`]);
      });
    } catch {}
  }

  function classify(event) {
    // Dialogs opened from inside a running tool (e.g. ExitPlanMode's plan review).
    for (const name of [...runningTools.values()].reverse()) {
      if (LABELS[name]) return LABELS[name];
    }
    // Permission dialogs open in the tool_call hook, before the tool starts,
    // and picc's dialog is an untitled ctx.ui.custom overlay.
    if (event?.title) return String(event.title).slice(0, 80);
    return DEFAULT_LABEL;
  }

  pi.on("tool_execution_start", (e) => runningTools.set(e.toolCallId, e.toolName));
  pi.on("tool_execution_end", (e) => runningTools.delete(e.toolCallId));

  function publish() {
    const visible = prompts.filter((prompt) => !prompt.ignored).at(-1);
    const label = visible?.label;
    if (active === !!visible && activeLabel === label) return;
    active = !!visible;
    activeLabel = label;
    reportMetadata(label);
    pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
  }

  pi.on("ui_prompt_start", (event) => {
    if (stopped) return;
    prompts.push({
      kind: event?.kind, title: event?.title,
      // Only the short-lived resource-bootstrap custom prompt is exempt.
      ignored: bootstrapActive && event?.kind === "custom",
      label: classify(event),
    });
    publish();
  });

  pi.on("ui_prompt_end", (event) => {
    if (stopped) return;
    const index = prompts.findLastIndex((prompt) => prompt.kind === event?.kind && prompt.title === event?.title);
    if (index < 0) return; // An unmatched end must not unblock a different prompt.
    prompts.splice(index, 1);
    publish();
  });

  pi.on("session_shutdown", () => {
    if (stopped) return;
    stopped = true;
    unsubscribeBootstrap?.();
    bootstrapActive = false;
    prompts.length = 0;
    runningTools.clear();
    if (active) pi.events.emit("herdr:blocked", { active: false });
    active = false;
    activeLabel = undefined;
    reportMetadata(null); // increments reportSeq and clears only our metadata source
  });
}
