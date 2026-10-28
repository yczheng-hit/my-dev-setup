import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyGptPrompt, isGptModel, withTruncationHint } from "./prompt.ts";

const SHELL_TOOLS = new Set(["bash", "exec_command", "write_stdin", "shell_command"]);

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isGptModel(ctx.model)) return;
    applyGptPrompt(event.systemPromptOptions);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!SHELL_TOOLS.has(event.toolName) || !isGptModel(ctx.model)) return;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = withTruncationHint(part.text);
      if (text === undefined) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });
}
