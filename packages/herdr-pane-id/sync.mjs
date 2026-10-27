// Report display-only sidebar tokens for every pane:
//   $pane_id  public pane id (w1:p3)
//   $ws_num   workspace position number (1, 2, ...; same as prefix+shift+N),
//             also reported on each workspace for the Spaces section
// Idempotent; run by herdr on startup and on pane/workspace lifecycle events.
import { execFileSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "local.pane-id";

const run = (args) => execFileSync(herdr, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

const workspaces = JSON.parse(run(["workspace", "list"])).result?.workspaces ?? [];
const numbers = new Map(workspaces.map((w) => [w.workspace_id, String(w.number ?? "")]));

// Same number on the workspace itself, for the Spaces section.
for (const [id, num] of numbers) {
  if (!num) continue;
  try {
    run(["workspace", "report-metadata", id, "--source", SOURCE, "--token", `ws_num=${num}`]);
  } catch (error) {
    process.stderr.write(`pane-id: ${id}: ${error.message}\n`);
  }
}
const panes = JSON.parse(run(["pane", "list"])).result?.panes ?? [];
let updated = 0;
for (const pane of panes) {
  const id = pane.pane_id;
  if (typeof id !== "string") continue;
  const wsNum = numbers.get(pane.workspace_id) ?? "";
  if (pane.tokens?.pane_id === id && (pane.tokens?.ws_num ?? "") === wsNum) continue;
  const args = ["pane", "report-metadata", id, "--source", SOURCE, "--token", `pane_id=${id}`];
  args.push(...(wsNum ? ["--token", `ws_num=${wsNum}`] : ["--clear-token", "ws_num"]));
  try {
    run(args);
    updated++;
  } catch (error) {
    process.stderr.write(`pane-id: ${id}: ${error.message}\n`);
  }
}
process.stdout.write(`pane-id: ${updated} updated, ${panes.length} panes\n`);
