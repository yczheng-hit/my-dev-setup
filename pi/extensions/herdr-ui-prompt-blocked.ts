// Bridge pi UI prompts (permission dialogs, plan review, select/confirm/input/custom)
// to herdr's "blocked" state, and tell herdr WHY it is blocked.
//
// - State: herdr's managed integration (herdr-agent-state.ts) only listens for
//   `herdr:blocked` on pi.events; pi emits ui_prompt_start/ui_prompt_end around
//   every ctx.ui prompt, so we forward those.
// - Reason: herdr has no blocked sub-states, so we publish a display-only
//   state label for `blocked`. The local.pane-id herdr plugin labels every agent
//   row "<n> <workspace> · <tab>" (and blocked "<n> approval"); we keep its agent
//   number and replace the whole blocked row with "<n> plan ready" etc. Clearing
//   our source falls back to the plugin's labels.
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
  const runningTools = new Map(); // toolCallId -> toolName

  let bootstrapActive = false;
  let ignoredBootstrapPrompt = false;
  pi.events.on("btw:ui-bootstrap", (event) => {
    bootstrapActive = event?.active === true;
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
    // Reuse the agent number from the plugin's label ("3 tools · pi-config").
    try {
      execFile(herdrBin, ["pane", "get", paneId], { timeout: 2000 }, (error, stdout) => {
        if (seq !== reportSeq) return; // prompt already ended
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

  pi.on("ui_prompt_start", (event) => {
    // Only the short-lived BTW TUI bootstrap is non-blocking. Its persistent
    // overlay is mounted separately, so real subsequent approvals still emit.
    if (bootstrapActive && event?.kind === "custom" && !active) {
      ignoredBootstrapPrompt = true;
      return;
    }
    if (active) return;
    active = true;
    const label = classify(event);
    reportMetadata(label);
    pi.events.emit("herdr:blocked", { active: true, label });
  });

  pi.on("ui_prompt_end", () => {
    if (ignoredBootstrapPrompt) {
      ignoredBootstrapPrompt = false;
      return;
    }
    if (!active) return;
    active = false;
    pi.events.emit("herdr:blocked", { active: false });
    reportMetadata(null);
  });
}
