// Isolated interactive fixture: commands exercise the production tool, never user plans.
import { readFileSync, writeFileSync } from "node:fs";
import { makeExitPlanModeTool } from "../../exitPlanModeTool.ts";
import { getPlanFilePath } from "../../utils.ts";
export default function (pi: any) {
  const tool = makeExitPlanModeTool({
    planText: async (ctx) => readFileSync(getPlanFilePath(ctx.sessionManager.getSessionId()), "utf8"),
    applyExit: async () => {},
  });
  pi.registerCommand("plan-repro", { description: "Isolated approval regression", handler: async (_args: string, ctx: any) => {
    writeFileSync(getPlanFilePath(ctx.sessionManager.getSessionId()), "# Original plan\n");
    const result = await tool.execute("review", {}, new AbortController().signal, undefined, ctx);
    ctx.ui.notify(`REPRO_DONE ${JSON.stringify(result.details)}`, "info");
  } });
}
