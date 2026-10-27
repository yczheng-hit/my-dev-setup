// Display-only sidebar metadata for every pane (herdr plugin local.pane-id):
//   state labels  "<n> <workspace> · <tab>" for every agent pane, where n is the
//                 agent number 1, 2, 3... in `herdr agent list` order (= sidebar
//                 order = focus_agent prefix+N). Shown by the `state_text` token
//                 in the agent's state color; one token, so no " · " after n.
//                 blocked defaults to "<n> approval"; a pi pane may replace it
//                 with its own reason (pi/extensions/herdr-ui-prompt-blocked.ts).
//   $pane_id      pane token: public pane id (w1:p3)
//   $ws_num       workspace token: workspace number (Spaces section)
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
const tabs = new Map((snapshot.tabs ?? []).map((t) => [t.tab_id, t]));
const agents = JSON.parse(run(["agent", "list"])).result?.agents ?? [];
const panes = JSON.parse(run(["pane", "list"])).result?.panes ?? [];

let updated = 0;
for (const w of workspaces.values()) {
  const num = String(w.number ?? "");
  if (num && w.tokens?.ws_num !== num) {
    updated += report(["workspace", "report-metadata", w.workspace_id, "--source", SOURCE, "--token", `ws_num=${num}`], w.workspace_id);
  }
}

const labelFor = new Map(
  agents.map((agent, index) => {
    const where = [workspaces.get(agent.workspace_id)?.label, tabs.get(agent.tab_id)?.label].filter(Boolean).join(" · ");
    return [agent.pane_id, { num: String(index + 1), text: `${index + 1} ${where}`.trim() }];
  }),
);

for (const pane of panes) {
  const id = pane.pane_id;
  if (typeof id !== "string") continue;
  const args = [];
  if (pane.tokens?.pane_id !== id) args.push("--token", `pane_id=${id}`);
  if (pane.tokens?.ws_num !== undefined) args.push("--clear-token", "ws_num"); // pre-0.3.0 leftover
  const want = labelFor.get(id);
  const labels = pane.state_labels ?? {};
  if (want) {
    // A label report replaces this source's whole label set, so always send all of them.
    // `labels` is the merged view: a pi-reported reason ("<n> plan ready") is kept as
    // long as its number is current.
    if (STATES.some((state) => labels[state] !== want.text) || !labels.blocked?.startsWith(`${want.num} `)) {
      for (const state of STATES) args.push("--state-label", `${state}=${want.text}`);
      args.push("--state-label", `blocked=${want.num} approval`);
    }
  } else if (Object.keys(labels).length) {
    args.push("--clear-state-labels");
  }
  if (args.length) updated += report(["pane", "report-metadata", id, "--source", SOURCE, ...args], id);
}
process.stdout.write(`pane-id: ${updated} updated, ${panes.length} panes, ${agents.length} agents\n`);
