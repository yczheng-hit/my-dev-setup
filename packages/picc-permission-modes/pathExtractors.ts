import { tryParseShellCommand } from "./shellQuote.ts";
import { splitCommandInternal } from "./bashParser.ts";
import {
  PATH_EXTRACTORS,
  COMMAND_OPERATION_TYPE,
  type PathCommand,
} from "./upstream/tools/BashTool/pathValidation.ts";
export const PATH_COMMANDS: ReadonlySet<string> = new Set(
  Object.keys(PATH_EXTRACTORS) as PathCommand[],
);
export const WRITE_PATH_COMMANDS: ReadonlySet<string> = new Set(
  Object.entries(COMMAND_OPERATION_TYPE)
    .filter(([, op]) => op !== "read")
    .map(([cmd]) => cmd),
);
export function isPathBearingCommand(cmd: string): boolean {
  const subcommands = splitCommandInternal(cmd);
  for (const sub of subcommands) {
    const parsed = tryParseShellCommand(sub);
    if (!parsed.success || parsed.tokens.length === 0) continue;
    const firstToken = parsed.tokens[0];
    if (typeof firstToken !== "string") continue;
    if (PATH_COMMANDS.has(firstToken)) return true;
  }
  return false;
}
export function extractBashPaths(cmd: string, writeOnly = false): string[] {
  const subcommands = splitCommandInternal(cmd);
  const results: string[] = [];
  for (const sub of subcommands) {
    const parsed = tryParseShellCommand(sub);
    if (!parsed.success) continue;
    const args: string[] = [];
    for (const tok of parsed.tokens) {
      if (typeof tok === "string") args.push(tok);
    }
    results.push(...extractFromSubcommand(args, writeOnly));
  }
  return results;
}
function extractFromSubcommand(args: string[], writeOnly: boolean): string[] {
  if (args.length === 0) return [];
  const baseCmd = args[0];
  if (typeof baseCmd !== "string") return [];
  if (!PATH_COMMANDS.has(baseCmd)) return [];
  if (writeOnly) {
    const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand];
    if (opType === "read") return [];
  }
  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand];
  if (!extractor) return [];
  try {
    return extractor(args.slice(1));
  } catch {
    return [];
  }
}
export function extractFirstBashPath(
  cmd: string,
  writeOnly: boolean = true,
): string {
  const paths = extractBashPaths(cmd, writeOnly);
  if (paths.length === 0) return "";
  for (const p of paths) {
    if (typeof p === "string" && p.length > 0) return p;
  }
  return "";
}
