// Display-only sidebar metadata for every pane (herdr plugin local.pane-id):
//   $pane_id      token: public pane id (w1:p3)
//   state labels  agent number 1, 2, 3... in `herdr agent list` order (same as
//                 the Agents sidebar and focus_agent prefix+N), shown by the
//                 `state_text` token in the agent's state color.
//   $ws_num       workspace token: workspace number (Spaces section).
// Idempotent; run by herdr on startup and on pane/tab/workspace lifecycle events.
import { execFileSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "local.pane-id";
const STATES = ["idle", "working", "blocked", "done", "unknown"];

const run = (args) => execFileSync(herdr, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
const list = (args, key) => JSON.parse(run(args)).result?.[key] ?? [];

for (const w of list(["workspace", "list"], "workspaces")) {
  const num = String(w.number ?? "");
  if (!num || w.tokens?.ws_num === num) continue;
  try {
    run(["workspace", "report-metadata", w.workspace_id, "--source", SOURCE, "--token", `ws_num=${num}`]);
  } catch (error) {
    process.stderr.write(`pane-id: ${w.workspace_id}: ${error.message}\n`);
  }
}

const agentNumber = new Map(list(["agent", "list"], "agents").map((a, i) => [a.pane_id, String(i + 1)]));
const panes = list(["pane", "list"], "panes");

let updated = 0;
for (const pane of panes) {
  const id = pane.pane_id;
  if (typeof id !== "string") continue;
  const args = [];
  if (pane.tokens?.pane_id !== id) args.push("--token", `pane_id=${id}`);
  if (pane.tokens?.ws_num !== undefined) args.push("--clear-token", "ws_num"); // pre-0.3.0 leftover
  const num = agentNumber.get(id);
  const labels = pane.state_labels ?? {};
  if (num) {
    if (STATES.some((s) => labels[s] !== num)) for (const s of STATES) args.push("--state-label", `${s}=${num}`);
  } else if (Object.keys(labels).length) {
    args.push("--clear-state-labels");
  }
  if (!args.length) continue;
  try {
    run(["pane", "report-metadata", id, "--source", SOURCE, ...args]);
    updated++;
  } catch (error) {
    process.stderr.write(`pane-id: ${id}: ${error.message}\n`);
  }
}
process.stdout.write(`pane-id: ${updated} updated, ${panes.length} panes, ${agentNumber.size} agents\n`);
