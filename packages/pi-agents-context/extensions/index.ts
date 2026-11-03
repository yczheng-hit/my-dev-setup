import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isClaudeSource, loadAgentsContextFiles, loadAgentsRules, formatAgentsInstructions } from "../context.ts";

export default function agentsContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    // Defense in depth for unpatched SDK hosts; setup patches discovery before any read.
    options.contextFiles = options.contextFiles.filter((file) => !isClaudeSource(file.path));
    options.skills = options.skills.filter((skill) => !isClaudeSource(skill.filePath));
    if (!ctx.isProjectTrusted()) {
      const globalPaths = new Set(loadAgentsContextFiles(ctx.cwd, false).map(file => file.path));
      options.contextFiles = options.contextFiles.filter(file => globalPaths.has(file.path));
    }
    const rules = loadAgentsRules(ctx.cwd, ctx.isProjectTrusted());
    if (rules.length) options.sections.agents_rules = formatAgentsInstructions(rules);
    else delete options.sections.agents_rules;
  });
  pi.registerCommand("agents-rules", {
    description: "List loaded .agents/rules sources (Claude Code configuration is never imported)",
    handler: async (_args, ctx) => {
      const rules = loadAgentsRules(ctx.cwd, ctx.isProjectTrusted());
      ctx.ui.notify(rules.length ? rules.map((file) => file.path).join("\n") : "No .agents/rules loaded", "info");
    },
  });
}
