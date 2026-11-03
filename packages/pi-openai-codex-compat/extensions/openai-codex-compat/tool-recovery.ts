import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";

const SECTION = "codex_tool_surface_recovery";
const editTools = ["replace", "replace_match", "insert", "copy", "move", "edit", "write"];
const shellTools = ["bash", "powershell", "exec_command", "shell_command"];

function alternatives(active: ReadonlySet<string>, toolName?: string): string {
  const lines: string[] = [];
  if (toolName === undefined || toolName === "apply_patch") {
    const edits = editTools.filter(name => active.has(name));
    lines.push(edits.length
      ? `Current editing tools: ${edits.join(", ")}. Read their current schemas before use.`
      : "No editing replacement is currently declared; do not invent one or bypass tool restrictions.");
  }
  if (toolName === undefined || ["exec_command", "shell_command", "write_stdin"].includes(toolName)) {
    const shells = shellTools.filter(name => active.has(name));
    lines.push(shells.length
      ? `Current command tools: ${shells.join(", ")}. Start a new command if needed; old Codex exec session IDs cannot be resumed through a different tool.`
      : "No command replacement is currently declared; do not invent one or bypass tool restrictions.");
  }
  lines.push("Only use tools declared for the current request and their current schemas/approval rules. Historical calls are not a declaration of availability.");
  return lines.join("\n");
}

/** Enrich only exact dispatch failures on request copies, never successful calls or session entries. */
export function recoverUnavailableCodexCalls(messages: AgentMessage[], activeNames: readonly string[], ownedTools: ReadonlySet<string>): AgentMessage[] | undefined {
  const active = new Set(activeNames), calls = new Map<string, string>();
  let changed = false;
  const result = messages.map(message => {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part.name);
    }
    if (message.role !== "toolResult") return message;
    const calledName = calls.get(message.toolCallId); calls.delete(message.toolCallId);
    if (!message.isError || calledName !== message.toolName || !ownedTools.has(message.toolName) || active.has(message.toolName)
      || message.content.length !== 1 || message.content[0]?.type !== "text"
      || message.content[0].text !== `Tool ${message.toolName} not found`) return message;
    changed = true;
    return { ...message, content: [{ ...message.content[0], text: `${message.content[0].text}\n\nTool ${message.toolName} is not available in the current tool set. This call was not executed. Do not retry ${message.toolName}.\n${alternatives(active, message.toolName)}` }] };
  });
  return changed ? result : undefined;
}

export default function registerToolRecovery(pi: Pick<ExtensionAPI, "on">, toolNames: readonly string[]): void {
  const ownedTools: ReadonlySet<string> = new Set(toolNames);
  let hiddenTools = new Set<string>();
  pi.on("before_agent_start", (event, ctx) => {
    hiddenTools = new Set(event.systemPromptOptions.hiddenTools);
    const active = new Set(event.systemPromptOptions.selectedTools.filter(name => !hiddenTools.has(name)));
    const unavailable = new Set<string>();
    // Recompute from the current branch, so resume/reload/tree changes cannot retain another branch's state.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const part of entry.message.content) {
        if (part.type === "toolCall" && ownedTools.has(part.name) && !active.has(part.name)) unavailable.add(part.name);
      }
    }
    if (unavailable.size) {
      event.systemPromptOptions.sections[SECTION] = `Historical tools ${[...unavailable].sort().join(", ")} are unavailable in the current tool set. Do not repeat their historical calls.\n${alternatives(active)}`;
    } else delete event.systemPromptOptions.sections[SECTION];
  });
  // Unknown calls skip tool hooks. Read request declarations without rewriting the prompt or history.
  pi.on("context_with_system", event => {
    const active = getCurrentTools(event.messages).map(tool => tool.name).filter(name => !hiddenTools.has(name));
    const messages = recoverUnavailableCodexCalls(event.messages, active, ownedTools);
    return messages ? { messages } : undefined;
  });
}
