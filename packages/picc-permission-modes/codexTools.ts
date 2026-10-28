export interface GateCall {
  tool: string;
  input: Record<string, unknown>;
}

const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

function parsePatch(patch: string): GateCall[] {
  const calls: GateCall[] = [];
  let current: { kind: "add" | "update" | "delete"; path: string; moveTo?: string; oldLines: string[]; newLines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    if (current.kind === "add") {
      calls.push({ tool: "write", input: { path: current.path, content: current.newLines.join("\n") } });
    } else {
      calls.push({
        tool: "edit",
        input: { path: current.path, old_string: current.oldLines.join("\n"), new_string: current.newLines.join("\n") },
      });
    }
    if (current.moveTo) calls.push({ tool: "edit", input: { path: current.moveTo, old_string: "", new_string: "" } });
    current = undefined;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith(ADD)) {
      flush();
      current = { kind: "add", path: line.slice(ADD.length).trim(), oldLines: [], newLines: [] };
    } else if (line.startsWith(UPDATE)) {
      flush();
      current = { kind: "update", path: line.slice(UPDATE.length).trim(), oldLines: [], newLines: [] };
    } else if (line.startsWith(DELETE)) {
      flush();
      current = { kind: "delete", path: line.slice(DELETE.length).trim(), oldLines: [], newLines: [] };
    } else if (current && line.startsWith(MOVE)) {
      current.moveTo = line.slice(MOVE.length).trim();
    } else if (current && line.startsWith("+")) {
      current.newLines.push(line.slice(1));
    } else if (current && current.kind === "update" && line.startsWith("-")) {
      current.oldLines.push(line.slice(1));
    } else if (current && current.kind === "update" && line.startsWith(" ")) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    }
  }
  flush();
  return calls;
}

/** Map Codex-style tools onto the bash/edit/write shapes the permission gate understands. */
export function expandCodexToolCall(tool: string, input: Record<string, unknown>): GateCall[] {
  if (tool === "exec_command") {
    return [{ tool: "bash", input: { command: typeof input.cmd === "string" ? input.cmd : "" } }];
  }
  if (tool === "shell_command") {
    return [{ tool: "bash", input: { command: typeof input.command === "string" ? input.command : "" } }];
  }
  if (tool === "apply_patch") {
    const patch = typeof input.patch === "string" ? input.patch : "";
    const calls = parsePatch(patch);
    // An unparseable patch has no path to check; an empty-path edit makes the gate ask or deny.
    return calls.length > 0 ? calls : [{ tool: "edit", input: { path: "", old_string: "", new_string: "" } }];
  }
  return [{ tool, input }];
}
