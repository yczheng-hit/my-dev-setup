// Display-only sidebar metadata for every pane (herdr plugin local.pane-id):
//   state labels  the agent number 1, 2, 3... for every agent pane, in
//                 `herdr agent list` order (= sidebar order = focus_agent prefix+N).
//                 Shown by `state_text` in place of the state dot, in the state color.
//                 A pi pane replaces blocked with "<n> <reason>"
//                 (pi/extensions/herdr-ui-prompt-blocked.ts).
//   $pane_id      pane token: public pane id (w1:p3)
// Idempotent; run by herdr on startup and on pane/tab/workspace lifecycle events.
import { execFileSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "local.pane-id";
const STATES = ["idle", "working", "done", "unknown"];

const run = (args) => execFileSync(herdr, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
const report = (args, id) => {
  try {
    run(args);
    return 1;
  } catch (error) {
    process.stderr.write(`pane-id: ${id}: ${error.message}\n`);
    return 0;
  }
};

const snapshot = JSON.parse(run(["api", "snapshot"])).result?.snapshot ?? {};
const workspaces = new Map((snapshot.workspaces ?? []).map((w) => [w.workspace_id, w]));
const agents = JSON.parse(run(["agent", "list"])).result?.agents ?? [];
const panes = JSON.parse(run(["pane", "list"])).result?.panes ?? [];

let updated = 0;
for (const w of workspaces.values()) {
  // Spaces keep herdr's own style; drop the pre-0.6 workspace number token.
  if (w.tokens?.ws_num !== undefined) {
    updated += report(["workspace", "report-metadata", w.workspace_id, "--source", SOURCE, "--clear-token", "ws_num"], w.workspace_id);
  }
}

const numberFor = new Map(agents.map((agent, index) => [agent.pane_id, String(index + 1)]));

for (const pane of panes) {
  const id = pane.pane_id;
  if (typeof id !== "string") continue;
  const args = [];
  if (pane.tokens?.pane_id !== id) args.push("--token", `pane_id=${id}`);
  if (pane.tokens?.ws_num !== undefined) args.push("--clear-token", "ws_num"); // pre-0.3.0 leftover
  const num = numberFor.get(id);
  const labels = pane.state_labels ?? {};
  if (num) {
    // A label report replaces this source's whole label set, so always send all of them.
    // `labels` is the merged view: a pi-reported reason ("<n> plan ready") is kept as
    // long as its number is current.
    const blockedOk = labels.blocked === num || labels.blocked?.startsWith(`${num} `);
    if (STATES.some((state) => labels[state] !== num) || !blockedOk) {
      for (const state of STATES) args.push("--state-label", `${state}=${num}`);
      args.push("--state-label", `blocked=${num}`);
    }
  } else if (Object.keys(labels).length) {
    args.push("--clear-state-labels");
  }
  if (args.length) updated += report(["pane", "report-metadata", id, "--source", SOURCE, ...args], id);
}
process.stdout.write(`pane-id: ${updated} updated, ${panes.length} panes, ${agents.length} agents\n`);
