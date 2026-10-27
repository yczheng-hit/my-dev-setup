// Report every pane's public id (w1:p3) as the display-only `$pane_id` token.
// Idempotent; run by herdr on startup and on pane create/move/agent detection.
import { execFileSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "local.pane-id";

const run = (args) => execFileSync(herdr, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

const panes = JSON.parse(run(["pane", "list"])).result?.panes ?? [];
let updated = 0;
for (const pane of panes) {
  const id = pane.pane_id;
  if (typeof id !== "string" || pane.tokens?.pane_id === id) continue;
  try {
    run(["pane", "report-metadata", id, "--source", SOURCE, "--token", `pane_id=${id}`]);
    updated++;
  } catch (error) {
    process.stderr.write(`pane-id: ${id}: ${error.message}\n`);
  }
}
process.stdout.write(`pane-id: ${updated} updated, ${panes.length} panes\n`);
